import { Wallet } from "@ethersproject/wallet";

import { getWallet } from "./utils";
import { getIsDefenderSetup } from "./defender";

/*
 * If transactions are dropped, our nonce will continue incrementing so subsequent
 * transactions will have too high of a nonce to go through. Whenever cached_nonce - network_nonce
 * is over this threshold we assume that a transaction was dropped and reset the nonce.
 *
 * The higher this threshold is the more transactions that will fail after a transaction is dropped.
 * The lower the threshold, the more likely it is that transactions will fail because there's many in the same block.
 * Ideally this threshold should be the maximum amount of transactions this relayer may send in a block.
 */
const NONCE_STALE_THRESHOLD = 10;

export default class NonceManager {
    private wallet: Wallet;
    private nonce: number;

    /*
     * Tail of the serialization chain used by `withNonce`. Every reservation
     * appends itself to this promise, so at most one caller is between "read the
     * nonce" and "increment the nonce" at any time.
     */
    private queue: Promise<unknown> = Promise.resolve();

    constructor() {
        this.wallet = getWallet();
        this.nonce = 0;
    }

    async currentNonce(): Promise<number> {
        return this.wallet.provider.getTransactionCount(this.wallet.address);
    }

    async setNonce(): Promise<void> {
        this.nonce = await this.currentNonce();
    }

    async checkNonceFresh(): Promise<void> {
        const currentNonce = await this.currentNonce();
        if (this.nonce - NONCE_STALE_THRESHOLD > currentNonce || this.nonce < currentNonce) {
            this.nonce = currentNonce;
        }
    }

    async getNonce(): Promise<number | void> {
        if (await getIsDefenderSetup()) return;

        if (!this.nonce) {
            await this.setNonce();
        } else {
            await this.checkNonceFresh();
        }

        return this.nonce as number;
    }

    async incrementNonce(): Promise<void> {
        if (await getIsDefenderSetup()) return;

        if (!this.nonce) {
            await this.setNonce();
        }

        this.nonce += 1;
    }

    /*
     * Runs `send` with the nonce that should be used for the next transaction,
     * and advances the cached nonce only if `send` resolves.
     *
     * `undefined` is passed when Defender is configured, because Defender's relay
     * assigns nonces itself; callers should omit the `nonce` transaction option in
     * that case rather than passing `undefined` through to ethers.
     *
     * This exists because reading and advancing the nonce are only correct as a
     * single atomic step. Previously the caller did
     *
     *     const txOptions = isDefenderSetup ? {} : { nonce: await nonceManager.getNonce() };
     *     const tx = await depositContract.deposit(..., txOptions);
     *     isDefenderSetup && await nonceManager.incrementNonce();
     *
     * which had two defects:
     *
     *   1. The increment condition was inverted. `incrementNonce()` already
     *      returns early when Defender is set up, so `isDefenderSetup && ...`
     *      made the call a guaranteed no-op on both branches: with Defender the
     *      method returns immediately, and without Defender it was never called.
     *      The cached nonce therefore never advanced, and every deposit submitted
     *      before the previous one confirmed reused the same nonce. Ethereum
     *      treats a second transaction with an already-pending nonce as a
     *      replacement, so under any concurrency the relayer silently dropped
     *      deposits it had already reported as accepted (it returned the tx hash
     *      of a transaction that would never be mined). The `this.nonce <
     *      currentNonce` branch in `checkNonceFresh` masked this whenever traffic
     *      was slow enough for each transaction to confirm before the next
     *      arrived, which is why it survived: the network nonce did the
     *      incrementing that this class was supposed to do, and the ability to
     *      have more than one transaction in flight -- the entire reason this
     *      class exists -- was quietly lost.
     *
     *   2. Even with the condition corrected, `getNonce()` and `incrementNonce()`
     *      are separate awaits, so two concurrent deposits could both read nonce
     *      N before either incremented. Serializing the whole read/send/increment
     *      sequence is what actually removes the race.
     *
     * Holding the lock across the send serializes `eth_sendRawTransaction` calls,
     * which is required anyway: nonces must be submitted in order, and a gap
     * stalls every later transaction until it is filled. The increment is skipped
     * when `send` rejects so a failed submission does not burn a nonce.
     */
    async withNonce<T>(send: (nonce: number | undefined) => Promise<T>): Promise<T> {
        const run = this.queue.then(async () => {
            const nonce = await this.getNonce();

            const result = await send(typeof nonce === "number" ? nonce : undefined);

            await this.incrementNonce();

            return result;
        });

        // Keep the chain alive after a rejection: `run` is handed to the caller
        // so they observe the error, while the queue continues from a settled
        // promise. Without the catch, one failed deposit would reject every
        // subsequent reservation forever.
        this.queue = run.catch(() => undefined);

        return run;
    }
}
