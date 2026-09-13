// Single-use, short-lived download tokens. Minted by daemon, consumed at /dl/<token>.

import { randomBytes } from "node:crypto";
import {
  DOWNLOAD_TOKEN_TTL_MS,
  DOWNLOAD_TOKEN_CLEANUP_MS,
} from "../config/timeouts";
import { MAX_DOWNLOAD_TOKENS } from "../config/limits";
import logger from "../logger";

export { DOWNLOAD_TOKEN_TTL_MS };

export interface DownloadToken {
  /** absolute path, already resolved and jailed by the mint handler */
  filePath: string;
  /** safe filename for Content-Disposition */
  fileName: string;
  contentType: string;
  disposition: "attachment" | "inline";
  expiresAt: number;
}

const tokens = new Map<string, DownloadToken>();

// background sweep keeps the map bounded even if mint endpoints are hammered
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of tokens) {
    if (entry.expiresAt < now) tokens.delete(token);
  }
}, DOWNLOAD_TOKEN_CLEANUP_MS);

function evictExpired(): void {
  const now = Date.now();
  for (const [token, entry] of tokens) {
    if (entry.expiresAt < now) tokens.delete(token);
  }
}

export function createDownloadToken(
  entry: Omit<DownloadToken, "expiresAt">,
): string {
  evictExpired();
  if (tokens.size >= MAX_DOWNLOAD_TOKENS) {
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

  const token = randomBytes(32).toString("hex");
  tokens.set(token, {
    ...entry,
    expiresAt: Date.now() + DOWNLOAD_TOKEN_TTL_MS,
  });
  return token;
}

// single-use: the token is removed the moment it is read, so the same URL can
// never be replayed a second time.
export function consumeDownloadToken(token: string): DownloadToken | null {
  const entry = tokens.get(token);
  if (!entry) return null;
  tokens.delete(token);
  if (entry.expiresAt < Date.now()) {
    logger.warn(`expired download token used: ${token.slice(0, 8)}...`);
    return null;
  }
  return entry;
}

// for tests / health reporting
export function activeDownloadTokenCount(): number {
  return tokens.size;
}
