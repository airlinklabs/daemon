import { timingSafeEqual } from "node:crypto";
import config from "../config";
import logger from "../logger";

const WINDOW_SECS = 30;

function sign(key: string, method: string, path: string, body: string, ts: number): string {
  const payload = `${ts}:${method.toUpperCase()}:${path}:${body}`;
  return new Bun.CryptoHasher("sha256", key).update(payload).digest("hex");
}

export function getAllowedIpCheck(req: Request): Response | null {
  if (config.allowedIps.length === 0) return null;

  const clientIp = config.behindProxy
    ? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown"
    : req.headers.get("x-real-ip") ?? "unknown";

  const normalized = clientIp.replace(/^::ffff:/, "");
  if (!config.allowedIps.includes(normalized)) {
    logger.warn(`blocked connection from ${normalized} - not in ALLOWED_IPS`);
    return new Response(JSON.stringify({ error: "access denied" }), { status: 403 });
  }

  return null;
}

export function checkBasicAuth(req: Request, expectedKey: string): Response | null {
  const header = req.headers.get("authorization");
  if (!header || !header.startsWith("Basic ")) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="airlinkd"' },
    });
  }

  const decoded = atob(header.slice(6));
  const colon = decoded.indexOf(":");
  const user = decoded.slice(0, colon);
  const pass = decoded.slice(colon + 1);
  const passBuf = Buffer.from(pass);
  const expBuf = Buffer.from(expectedKey);

  if (user !== "Airlink" || passBuf.length !== expBuf.length || !timingSafeEqual(passBuf, expBuf)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="airlinkd"' },
    });
  }

  return null;
}

export async function verifyHmac(req: Request, key: string): Promise<Response | null> {
  if (!config.requireHmac) return null;

  const tsHeader = req.headers.get("x-airlink-timestamp");
  const sigHeader = req.headers.get("x-airlink-signature");
  if (!tsHeader || !sigHeader) {
    return new Response(JSON.stringify({ error: "missing HMAC headers" }), { status: 401 });
  }

  const ts = Number.parseInt(tsHeader, 10);
  if (Number.isNaN(ts)) {
    return new Response(JSON.stringify({ error: "bad timestamp" }), { status: 401 });
  }

  const drift = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (drift > WINDOW_SECS) {
    return new Response(JSON.stringify({ error: "timestamp out of window" }), { status: 401 });
  }

  const url = new URL(req.url);
  const body = req.method === "GET" || req.method === "DELETE" ? "" : await req.clone().text();
  const expected = sign(key, req.method, url.pathname, body, ts);
  const expBuf = Buffer.from(expected, "hex");
  const gotBuf = Buffer.from(sigHeader, "hex");

  if (expBuf.length !== gotBuf.length || !timingSafeEqual(expBuf, gotBuf)) {
    logger.warn(`invalid HMAC for ${req.method} ${url.pathname}`);
    return new Response(JSON.stringify({ error: "invalid signature" }), { status: 401 });
  }

  return null;
}

export function withSecurityHeaders(res: Response): Response {
  const h = new Headers(res.headers);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("X-XSS-Protection", "0");
  h.set("Referrer-Policy", "no-referrer");
  h.set("Permissions-Policy", "interest-cohort=()");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  h.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, headers: h });
}
