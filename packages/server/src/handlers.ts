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

/* A 65-byte `(r, s, v)` signature is exactly 130 hex digits after the `0x` prefix. */
const SIGNATURE_HEX_LENGTH = 132;

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
const HEX_REGEX = /^0x[0-9a-fA-F]+$/;

/*
 * Validates the request body before any of it reaches ethers or the chain.
 */
function validateDepositRequest(body: unknown): string | undefined {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return "Request body must be a JSON object";
    }

    const candidate = body as Record<string, unknown>;

    // Signatures must match exact 65-byte length (132 chars with 0x prefix)
    for (const field of ["receiveSig", "depositSig"]) {
        const value = candidate[field];
        if (typeof value !== "string") return `\`${field}\` must be a hexstring`;
        if (!HEX_REGEX.test(value)) return `\`${field}\` must be a 0x-prefixed hexstring`;
        if (value.length !== SIGNATURE_HEX_LENGTH) {
            return `\`${field}\` must be exactly ${SIGNATURE_HEX_LENGTH} characters`;
        }
    }

    // Amount and uint256 hex fields bounded by maximum uint256 representation length
    const boundedHexFields: Array<[string, number]> = [
        ["totalValue", MAX_UINT256_HEX_LENGTH],
        ["fee", MAX_UINT256_HEX_LENGTH],
        ["receiveNonce", MAX_UINT256_HEX_LENGTH],
    ];

    for (const [field, maxLength] of boundedHexFields) {
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
    // timestamps on chain, so they must be non-negative safe integers.
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
        signer = await getSigner();
    } catch (_e) {
        ctx.throw(400, "Unsupported chainId " + chainId);
    }

    const depositContract = getDepositContract(signer, chainId);

    let receiveSig: Signature;
    try {
        receiveSig = splitSignature(receiveSigRaw);
    } catch (_e) {
        ctx.throw(400, "Error splitting `receiveSig`: not a valid signature");
    }

    let depositSig: Signature;
    try {
        depositSig = splitSignature(depositSigRaw);
    } catch (_e) {
        ctx.throw(400, "Error splitting `depositSig`: not a valid signature");
    }

    const { fee: calculatedFee } = await getFee();

    const feeMin = calculatedFee.mul(90).div(100);
    ctx.assert(BigNumber.from(fee).gt(feeMin), 400, "Fee lower than minimum accepted fee.");

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
        console.error("Failed to estimate gas for deposit transaction:", e);
        ctx.throw(400, "Failed to estimate gas for deposit transaction. Transaction will likely fail.");
    }

    try {
        const isDefenderSetup = await getIsDefenderSetup();

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
        console.error("Failed to submit deposit transaction:", error);

        ctx.body = {
            error: "Failed to submit deposit transaction.",
        };
        ctx.status = 400;
    }
};
