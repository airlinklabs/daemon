import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import config from '../utils/config';
import logger from '../utils/logger';

const SIGNATURE_WINDOW_S = 30;

function hmacSign(key: string, method: string, path: string, body: string, timestamp: number): string {
  const payload = `${timestamp}:${method.toUpperCase()}:${path}:${body}`;
  return crypto.createHmac('sha256', key).update(payload).digest('hex');
}

// Verifies X-Airlink-Timestamp and X-Airlink-Signature on incoming requests.
// Runs after basicAuthMiddleware — both checks must pass.
//
// If a request lacks the headers (older panel version or direct curl) it is
// allowed through with a warning so the daemon doesn't hard-break on upgrade.
// Set REQUIRE_HMAC=true in the daemon .env to enforce strict mode.
export function hmacVerificationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const tsHeader  = req.headers['x-airlink-timestamp'] as string | undefined;
  const sigHeader = req.headers['x-airlink-signature'] as string | undefined;

  // Strict mode: reject requests without HMAC headers entirely.
  if (!tsHeader || !sigHeader) {
    if (process.env.REQUIRE_HMAC === 'true') {
      logger.warn(`Rejected unsigned request: ${req.method} ${req.path} from ${req.ip}`);
      res.status(401).json({ error: 'Missing HMAC signature headers' });
      return;
    }
    // Permissive mode: log and pass through.
    logger.debug(`Unsigned request allowed (REQUIRE_HMAC not set): ${req.method} ${req.path}`);
    next();
    return;
  }

  const timestamp = parseInt(tsHeader, 10);
  if (isNaN(timestamp)) {
    res.status(401).json({ error: 'Invalid timestamp header' });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const drift = Math.abs(now - timestamp);
  if (drift > SIGNATURE_WINDOW_S) {
    logger.warn(`Rejected request with stale timestamp (drift=${drift}s): ${req.method} ${req.path}`);
    res.status(401).json({ error: 'Request timestamp out of window' });
    return;
  }

  const body = req.body
    ? typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
    : '';

  // Sign only pathname — no query string. The panel signs before axios appends
  // query params, so we must verify against the same path-only string.
  const urlPath = req.path;
  const expected = hmacSign(config.key, req.method, urlPath, body, timestamp);

  const expectedBuf = Buffer.from(expected, 'hex');
  const receivedBuf = Buffer.from(sigHeader, 'hex');

  if (
    expectedBuf.length !== receivedBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, receivedBuf)
  ) {
    logger.warn(`Rejected request with invalid HMAC: ${req.method} ${req.path} from ${req.ip}`);
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  next();
}
