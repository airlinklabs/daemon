import { timingSafeEqual } from "node:crypto";
import config from "../config";
import { type ApiErrorCode, apiError } from "../errors";
import { maxBodyBytesFor } from "../limits";
import logger from "../logger";

const HMAC_WINDOW_SECS = 30;
const seenNonces = new Map<string, number>(); // key -> inserted timestamp
const MAX_NONCE_MAP_SIZE = 10_000;
const MAX_NONCE_LENGTH = 128;

// Must match HMAC_PAYLOAD_VERSION in the panel's daemonRequest.ts.
// Increment both sides together when changing the signing format.
// Protocol v1 signs the body's sha256 digest, never raw body text.
// Format: ${ts}:${nonce}:${method}:${path}:${bodyRepr}
function sign(
  key: string,
  method: string,
  path: string,
  bodyRepr: string,
  ts: number,
  nonce: string,
): string {
  const payload = `${ts}:${nonce}:${method.toUpperCase()}:${path}:${bodyRepr}`;
  const hasher = new Bun.CryptoHasher("sha256", key);
  hasher.update(payload);
  return hasher.digest("hex");
}

function rememberNonce(ts: number, nonceValue: string): Response | null {
  const _now = Math.floor(Date.now() / 1000);

  // Reject new nonces when map is full.
  if (seenNonces.size >= MAX_NONCE_MAP_SIZE) {
    return apiError(
      "nonce_storage_full",
      "nonce storage exhausted, retry later",
      503,
    );
  }

  const cacheKey = `${ts}:${nonceValue}`;
  if (seenNonces.has(cacheKey)) {
    return apiError("nonce_replayed", "replayed request", 401);
  }

  seenNonces.set(cacheKey, Date.now());
  return null;
}

// Background sweep: evict expired nonces every 5s (O(n) but infrequent)
setInterval(() => {
  const cutoff = Date.now() - HMAC_WINDOW_SECS * 1000;
  for (const [key, insertedAt] of seenNonces) {
    if (insertedAt < cutoff) seenNonces.delete(key);
  }
}, 5_000);

// Streams the request body through a sha256 hash, enforcing the per-route byte
// cap while reading. The body is never buffered, so multi-GiB backup uploads
// stay memory-safe. Returns null when the body exceeds the cap (the original
// request is left untouched so route handlers can still read it afterwards).
async function bodyDigestAndSize(
  req: Request,
  maxBytes: number,
): Promise<{ digest: string; byteLength: number } | null> {
  const stream = req.body;
  if (!stream) return { digest: EMPTY_BODY_DIGEST, byteLength: 0 };

  const hash = new Bun.CryptoHasher("sha256");
  const reader = stream.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) return null;
      hash.update(value);
    }
  } finally {
    reader.releaseLock();
  }

  return { digest: hash.digest("hex"), byteLength: total };
}

const EMPTY_BODY_DIGEST =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// returns null if valid, returns a Response error if not
export async function verifyHmac(
  req: Request,
  key: string,
  routeKey: string,
): Promise<Response | null> {
  const tsHeader = req.headers.get("x-airlink-timestamp");
  const sigHeader = req.headers.get("x-airlink-signature");
  const nonceHeader = req.headers.get("x-airlink-nonce") ?? "";
  const versionHeader = req.headers.get("x-airlink-payload-version");

  if (!tsHeader || !sigHeader) {
    if (Bun.env.REQUIRE_HMAC === "false") {
      // In development mode only: allow unsigned requests from loopback.
      // Production must NEVER set REQUIRE_HMAC=false.
      const clientIp =
        req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
        req.headers.get("x-real-ip") ??
        "";
      const isLoopback =
        clientIp === "127.0.0.1" ||
        clientIp === "::1" ||
        clientIp === "::ffff:127.0.0.1" ||
        clientIp === "";
      if (!isLoopback) {
        return apiError("missing_hmac_headers", "missing HMAC headers", 401);
      }
      logger.warn(
        `unsigned request allowed from loopback (REQUIRE_HMAC=false): ${req.method} ${new URL(req.url).pathname}`,
      );
      return null;
    }
    return apiError("missing_hmac_headers", "missing HMAC headers", 401);
  }

  // The panel always sends the payload version; a mismatch means one side
  // signs with a different scheme and the signature is meaningless.
  if (versionHeader !== "1") {
    return apiError(
      "invalid_payload_version",
      "unsupported HMAC payload version",
      401,
    );
  }

  const ts = parseInt(tsHeader, 10);
  if (Number.isNaN(ts)) {
    return apiError("hmac_invalid", "bad timestamp", 401);
  }

  const drift = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (drift > HMAC_WINDOW_SECS) {
    return apiError("hmac_expired", "timestamp out of window", 401);
  }

  // Required — prevents replay attacks.
  if (!nonceHeader) {
    return apiError("missing_nonce", "missing nonce header", 401);
  }

  // Cap nonce length to prevent memory abuse.
  if (nonceHeader.length > MAX_NONCE_LENGTH) {
    return apiError("invalid_nonce", "nonce exceeds maximum length", 401);
  }

  const url = new URL(req.url);
  const bodylessMethod = req.method === "GET";

  // Canonical target: sign the exact pathname + search that the panel signed.
  // Previously only pathname was signed, leaving query params unprotected.
  const canonicalTarget = url.search
    ? `${url.pathname}${url.search}`
    : url.pathname;

  // Reject duplicate query keys — panel forbids them.
  if (url.search) {
    const _keys = url.searchParams.getAll.bind(url.searchParams);
    const uniqueKeys = new Set<string>();
    for (const [key] of url.searchParams) {
      if (uniqueKeys.has(key)) {
        return apiError(
          "duplicate_query_key",
          `duplicate query key "${key}"`,
          400,
        );
      }
      uniqueKeys.add(key);
    }
  }

  // Verify the digest over the exact bytes received.
  let digestHex: string | null = null;
  if (!bodylessMethod) {
    const bodyInfo = await bodyDigestAndSize(
      req.clone(),
      maxBodyBytesFor(routeKey),
    );
    if (bodyInfo === null) {
      return apiError("request_too_large", "request body too large", 413);
    }

    if (bodyInfo.byteLength > 0) {
      digestHex = bodyInfo.digest;

      const digestHeader = req.headers.get("x-airlink-digest");
      if (!digestHeader) {
        return apiError("missing_digest", "missing digest header", 401);
      }
      const expected = digestHeader.startsWith("sha256:")
        ? digestHeader.slice("sha256:".length)
        : "";
      if (expected.length !== 64 || digestHex !== expected) {
        return apiError("digest_mismatch", "request body digest mismatch", 401);
      }
    }
  }

  const bodyRepr = digestHex ? `digest:${digestHex}` : "";

  const expected = sign(
    key,
    req.method,
    canonicalTarget,
    bodyRepr,
    ts,
    nonceHeader,
  );
  const expBuf = Buffer.from(expected, "hex");
  let gotBuf: Buffer;
  try {
    gotBuf = Buffer.from(sigHeader, "hex");
  } catch {
    return apiError("hmac_invalid", "invalid signature", 401);
  }

  if (expBuf.length !== gotBuf.length || !timingSafeEqual(expBuf, gotBuf)) {
    return apiError("hmac_invalid", "invalid signature", 401);
  }

  // Nonce deduplication: each nonce can only be used once within the window
  const replayErr = rememberNonce(ts, nonceHeader);
  if (replayErr) return replayErr;

  return null;
}

// parse the Authorization: Basic ... header ourselves — express-basic-auth is gone
export function checkBasicAuth(
  req: Request,
  expectedKey: string,
): Response | null {
  const unauthorized = (): Response =>
    new Response(
      JSON.stringify({
        error: "unauthorized",
        code: "unauthorized",
        status: 401,
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": 'Basic realm="airlinkd"',
        },
      },
    );

  const header = req.headers.get("authorization");
  if (!header?.startsWith("Basic ")) return unauthorized();

  let decoded = "";
  try {
    decoded = atob(header.slice(6));
  } catch {
    return unauthorized();
  }

  const colon = decoded.indexOf(":");
  if (colon < 0) return unauthorized();

  const user = decoded.slice(0, colon);
  const pass = decoded.slice(colon + 1);

  // constant-time compare — don't use ===
  const passBuf = Buffer.from(pass);
  const expBuf = Buffer.from(expectedKey);
  if (
    user !== "Airlink" ||
    passBuf.length !== expBuf.length ||
    !timingSafeEqual(passBuf, expBuf)
  ) {
    return unauthorized();
  }

  return null;
}

// accepts the already-resolved effective IP — caller extracts it via server.requestIP()
export function getAllowedIpCheck(effectiveIp: string): Response | null {
  const allowed = config.allowedIps;
  if (allowed.length === 0) return null;

  if (!allowed.includes(effectiveIp)) {
    logger.warn(`blocked connection from ${effectiveIp} — not in ALLOWED_IPS`);
    return apiError("access_denied", "access denied", 403);
  }

  return null;
}

// call this on every response before returning from the router
export function withSecurityHeaders(res: Response): Response {
  const h = new Headers(res.headers);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("X-XSS-Protection", "0"); // deprecated but harmless
  h.set("Referrer-Policy", "no-referrer");
  h.set("Permissions-Policy", "interest-cohort=()");
  // Default to same-origin, but never override a handler-set value. The
  // /dl/<token> download route intentionally serves cross-origin so the panel
  // origin can render <img> previews and run downloads from the daemon host.
  if (!h.has("Cross-Origin-Resource-Policy"))
    h.set("Cross-Origin-Resource-Policy", "same-origin");
  h.set("Cache-Control", "no-store");
  // not setting CSP — this is a JSON API, not HTML
  return new Response(res.body, { status: res.status, headers: h });
}

export type { ApiErrorCode };

export function clearNonceCache(): void {
  seenNonces.clear();
}

export function clearExpiredNonces(): void {
  const cutoff = Date.now() - HMAC_WINDOW_SECS * 1000;
  for (const [key, insertedAt] of seenNonces) {
    if (insertedAt < cutoff) seenNonces.delete(key);
  }
}
