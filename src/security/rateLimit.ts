// nothing fancy, just counts hits per IP per minute and says no when they go over

import {
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_CLEANUP_MS,
} from "../config/timeouts";
import { DEFAULT_RATE_LIMIT } from "../config/limits";

const hits = new Map<string, { count: number; resetAt: number }>();

// clean up old entries every minute so the map doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of hits) {
    if (data.resetAt < now) hits.delete(ip);
  }
}, RATE_LIMIT_CLEANUP_MS);

export function checkRateLimit(
  ip: string,
  limit = DEFAULT_RATE_LIMIT,
): Response | null {
  const now = Date.now();

  let data = hits.get(ip);
  if (!data || data.resetAt < now) {
    data = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    hits.set(ip, data);
  }

  data.count++;
  if (data.count > limit) {
    return new Response(JSON.stringify({ error: "rate limit exceeded" }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(Math.ceil((data.resetAt - now) / 1000)),
      },
    });
  }

  return null;
}

export function clearExpiredRateLimit(): void {
  const now = Date.now();
  for (const [ip, data] of hits) {
    if (data.resetAt < now) hits.delete(ip);
  }
}
