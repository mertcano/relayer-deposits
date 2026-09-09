import Koa from "koa";
import bodyParser from "koa-bodyparser";
import cors from "@koa/cors";

// XXX: must import env which configures dotenv
import { chainId } from "./env";
import { getSigner } from "./utils";
import router from "./router";
import { maybeRegister } from "./depositContract";

const app = new Koa();
const port = process.env.PORT || process.env.SERVER_PORT || 5555;

/*
 * Origins permitted to call this relayer from a browser, as a comma-separated
 * list in `CORS_ALLOWED_ORIGINS`.
 *
 * `cors()` with no options reflects the request's `Origin` header, which is
 * equivalent to `Access-Control-Allow-Origin: *`: any web page the relay
 * operator's users visit can POST /deposit and read the response. Because the
 * relayer pays gas for every deposit it submits, an unrestricted origin lets an
 * arbitrary site spend the relayer's balance using a visitor's signatures.
 *
 * A `/deposit` request is only accepted with valid EIP-712 signatures over the
 * deposit, so this is not by itself an authentication bypass -- but there are no
 * credentials to protect here and nothing else bounds who may submit. Restricting
 * the origin is what makes the wallet-signing frontends the intended callers.
 *
 * Left unset, no CORS headers are sent at all, which is the correct default for a
 * relayer called from a server or a native client. Set it explicitly to enable
 * browser access.
 */
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map(origin => origin.trim())
    .filter(origin => origin.length > 0);

app.use(bodyParser({ jsonLimit: "128kb" }));

if (allowedOrigins.length > 0) {
    app.use(
        cors({
            // Returning the empty string omits the header, so a disallowed origin
            // is refused by the browser rather than silently permitted.
            origin: ctx => {
                const requestOrigin = ctx.request.header.origin;

                return requestOrigin && allowedOrigins.includes(requestOrigin) ? requestOrigin : "";
            },
            allowMethods: ["GET", "POST", "OPTIONS"],
        }),
    );
}

app.use(router.routes()).use(router.allowedMethods());

app.listen(port, async () => {
    console.log(`Listening on port ${port}`);

    const signer = await getSigner();
    const relay = await signer.getAddress();
    console.log("Relay account:", relay);

    await maybeRegister(chainId);
});

export default app;
