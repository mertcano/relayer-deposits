import { BigNumber } from "@ethersproject/bignumber";
import { Signer } from "@ethersproject/abstract-signer";
import { splitSignature } from "@ethersproject/bytes";
import { Signature } from "@polymarket/relayer-deposits";

import { getSigner, getFee } from "./utils";
import { getDepositContract } from "./depositContract";
import NonceManager from "./NonceManager";
import { chainId } from "./env";
import { getIsDefenderSetup } from "./defender";

const nonceManager = new NonceManager();

type DepositRequestBody = {
    receiveSig: string;
    depositSig: string;
    from: string;
    depositRecipient: string;
    totalValue: string; // hexstring
    fee: string; // hexstring
    validBefore: number;
    receiveNonce: string; // hexstring
    chainId: number;
    maxBlock: number;
};

/*
 * Upper bound for the hexstring amount fields. `uint256` is 32 bytes, so 64 hex
 * digits after the `0x` prefix. Bounding the length keeps `BigNumber.from` from
 * being handed an unbounded string, and rejects values the contract could never
 * accept anyway.
 */
const MAX_UINT256_HEX_LENGTH = 66;

/* A 65-byte `(r, s, v)` signature is 130 hex digits after the `0x` prefix. */
const SIGNATURE_HEX_LENGTH = 132;

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
const HEX_REGEX = /^0x[0-9a-fA-F]+$/;

/*
 * Validates the request body before any of it reaches ethers or the chain.
 *
 * The body previously arrived as `ctx.request.body as DepositRequestBody`. A
 * cast is a compile-time assertion only -- at runtime the body is whatever JSON
 * the client sent, so every field was unvalidated. `BigNumber.from(totalValue)`
 * with `totalValue: undefined` or `totalValue: {}` throws inside the handler and
 * surfaces as an unhandled 500 rather than the 400 this is, and the surrounding
 * `ctx.assert` checks silently read `undefined` as a valid comparison operand.
 *
 * Returns a human-readable reason on failure and `undefined` on success, so the
 * caller decides the response shape.
 */
function validateDepositRequest(body: unknown): string | undefined {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return "Request body must be a JSON object";
    }

    const candidate = body as Record<string, unknown>;

    const requiredHexFields: Array<[string, number]> = [
        ["receiveSig", SIGNATURE_HEX_LENGTH],
        ["depositSig", SIGNATURE_HEX_LENGTH],
        ["totalValue", MAX_UINT256_HEX_LENGTH],
        ["fee", MAX_UINT256_HEX_LENGTH],
        ["receiveNonce", MAX_UINT256_HEX_LENGTH],
    ];

    for (const [field, maxLength] of requiredHexFields) {
        const value = candidate[field];
        if (typeof value !== "string") return `\`${field}\` must be a hexstring`;
        if (!HEX_REGEX.test(value)) return `\`${field}\` must be a 0x-prefixed hexstring`;
        if (value.length > maxLength) return `\`${field}\` is longer than ${maxLength} characters`;
    }

    for (const field of ["from", "depositRecipient"]) {
        const value = candidate[field];
        if (typeof value !== "string" || !ADDRESS_REGEX.test(value)) {
            return `\`${field}\` must be a 0x-prefixed 20 byte address`;
        }
    }

    // `validBefore` and `maxBlock` are compared against block numbers and
    // timestamps on chain, so they must be non-negative safe integers. A
    // fractional or NaN value would be encoded as an unpredictable uint256.
    for (const field of ["validBefore", "maxBlock", "chainId"]) {
        const value = candidate[field];
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
            return `\`${field}\` must be a non-negative integer`;
        }
    }

    return undefined;
}

export const handleDeposit = async (ctx, next) => {
    await next();

    const validationError = validateDepositRequest(ctx.request.body);
    ctx.assert(!validationError, 400, validationError);

    const {
        receiveSig: receiveSigRaw,
        depositSig: depositSigRaw,
        from,
        depositRecipient,
        totalValue,
        fee,
        validBefore,
        receiveNonce,
        chainId: requestedChainId,
        maxBlock,
    } = (ctx.request.body as DepositRequestBody);

    ctx.assert(chainId === requestedChainId, 400, `Requested deposit on chainId ${requestedChainId} but server only accepts deposits on ${chainId}`);

    ctx.assert(BigNumber.from(totalValue).gt(fee), 400, "Deposit amount must be greater than the fee");

    let signer: Signer;
    try {
        // will throw on an unsupported chainId
        signer = await getSigner();
    } catch (_e) {
        ctx.throw(400, "Unsupported chainId " + chainId);
    }

    const depositContract = getDepositContract(signer, chainId);

    let receiveSig: Signature;
    try {
        receiveSig = splitSignature(receiveSigRaw);
    } catch (_e) {
        // The upstream message is not echoed: it embeds the caller-supplied
        // signature bytes, so reflecting it turns this endpoint into a mirror for
        // arbitrary attacker-chosen content. The field name is enough to fix a
        // malformed request.
        ctx.throw(400, "Error splitting `receiveSig`: not a valid signature");
    }

    let depositSig: Signature;
    try {
        depositSig = splitSignature(depositSigRaw);
    } catch (_e) {
        ctx.throw(400, "Error splitting `depositSig`: not a valid signature");
    }

    // check gas price is fast to prevent slow gas price from slowing deposits
    const { fee: calculatedFee } = await getFee();

    // check that fee is acceptable
    const feeMin = calculatedFee.mul(90).div(100);
    ctx.assert(BigNumber.from(fee).gt(feeMin), 400, "Fee lower than minimum accepted fee.");

    // estimate gas on transaction to check validity
    try {
        await depositContract.estimateGas.deposit(
            from,
            depositRecipient,
            totalValue,
            fee,
            validBefore,
            receiveNonce,
            maxBlock,
            receiveSig,
            depositSig,
        );
    } catch (e) {
        // Log the provider's reason server-side, where it is useful for
        // debugging, but do not reflect it: an estimateGas revert reason can
        // carry relayer configuration and provider URLs.
        console.error("Failed to estimate gas for deposit transaction:", e);
        ctx.throw(400, "Failed to estimate gas for deposit transaction. Transaction will likely fail.");
    }

    try {
        const isDefenderSetup = await getIsDefenderSetup();

        // The nonce is reserved, used, and advanced as one atomic step. See
        // NonceManager.withNonce for why the previous read-then-increment pair
        // never advanced the nonce at all.
        // `Contract` methods are untyped, so the transaction response is `any`
        // here exactly as it was before this call was wrapped.
        const tx: any = await nonceManager.withNonce((nonce) => { // eslint-disable-line
            const txOptions = isDefenderSetup || nonce === undefined ? {} : { nonce };

            return depositContract.deposit(
                from,
                depositRecipient,
                totalValue,
                fee,
                validBefore,
                receiveNonce,
                maxBlock,
                receiveSig,
                depositSig,
                txOptions,
            );
        });

        console.log(`Sending tx with hash ${tx.hash}`);

        ctx.body = {
            hash: tx.hash,
            nonce: tx.nonce,
            gasPrice: tx.gasPrice && tx.gasPrice.toHexString(),
            gasLimit: tx.gasLimit.toHexString(),
            maxPriorityFeePerGas: tx.maxPriorityFeePerGas && tx.maxPriorityFeePerGas.toHexString(),
            maxFeePerGas: tx.maxFeePerGas && tx.maxFeePerGas.toHexString(),
            to: tx.to,
            value: tx.value.toHexString(),
            data: tx.data,
            v: tx.v,
            r: tx.r,
            s: tx.s,
            chainId,
            fee,
        };
        ctx.status = 200;
    } catch (error) {
        // `error.toString()` on an ethers error includes the full RPC request and
        // response, which can contain the provider endpoint (with its API key in
        // the path, as constructed in chains.ts) and the relayer's own address.
        // Log it, return a generic message.
        console.error("Failed to submit deposit transaction:", error);

        ctx.body = {
            error: "Failed to submit deposit transaction.",
        };
        ctx.status = 400;
    }
}
