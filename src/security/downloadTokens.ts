// ── One-time download tokens (F-phase6: no file hairpin through the panel) ──
// Downloads are no longer proxied panel→daemon→client. The panel calls a
// signed mint endpoint, the daemon records a short-lived single-use token bound
// to an already-jailed absolute path, and the browser is 302'd straight at the
// daemon's /dl/<token> route. The token is the only credential the browser ever
// sees; it expires in seconds and is consumed on first use, so it cannot be
// replayed, re-requested, or guessed (256 bits of CSPRNG entropy per token).

import { randomBytes } from 'node:crypto';
import logger from '../logger';

export const DOWNLOAD_TOKEN_TTL_MS = 90_000; // 90s — enough for a redirect + tab open
const MAX_TOKENS = 10_000;
const CLEANUP_INTERVAL_MS = 30_000;

export interface DownloadToken {
  /** absolute path, already resolved and jailed by the mint handler */
  filePath: string;
  /** safe filename for Content-Disposition */
  fileName: string;
  contentType: string;
  disposition: 'attachment' | 'inline';
  expiresAt: number;
}

const tokens = new Map<string, DownloadToken>();

// background sweep keeps the map bounded even if mint endpoints are hammered
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of tokens) {
    if (entry.expiresAt < now) tokens.delete(token);
  }
}, CLEANUP_INTERVAL_MS);

function evictExpired(): void {
  const now = Date.now();
  for (const [token, entry] of tokens) {
    if (entry.expiresAt < now) tokens.delete(token);
  }
}

export function createDownloadToken(entry: Omit<DownloadToken, 'expiresAt'>): string {
  evictExpired();
  if (tokens.size >= MAX_TOKENS) {
    // still full after eviction — drop the soonest-to-expire token
    let oldest: string | null = null;
    let oldestExp = Infinity;
    for (const [token, e] of tokens) {
      if (e.expiresAt < oldestExp) {
        oldestExp = e.expiresAt;
        oldest = token;
      }
    }
    if (oldest) tokens.delete(oldest);
  }

  const token = randomBytes(32).toString('hex');
  tokens.set(token, { ...entry, expiresAt: Date.now() + DOWNLOAD_TOKEN_TTL_MS });
  return token;
}

// single-use: the token is removed the moment it is read, so the same URL can
// never be replayed a second time.
export function consumeDownloadToken(token: string): DownloadToken | null {
  const entry = tokens.get(token);
  if (!entry) return null;
  tokens.delete(token);
  if (entry.expiresAt < Date.now()) {
    logger.warn(`expired download token used: ${token}`);
    return null;
  }
  return entry;
}

// for tests / health reporting
export function activeDownloadTokenCount(): number {
  return tokens.size;
}
