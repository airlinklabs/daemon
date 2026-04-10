const hits = new Map<string, { count: number; resetAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of hits) {
    if (data.resetAt < now) hits.delete(ip);
  }
}, 60_000);

export function checkRateLimit(req: Request, limit = 300): Response | null {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";
  const now = Date.now();
  let data = hits.get(ip);

  if (!data || data.resetAt < now) {
    data = { count: 0, resetAt: now + 60_000 };
    hits.set(ip, data);
  }

  data.count += 1;
  if (data.count > limit) {
    return new Response(JSON.stringify({ error: "rate limit exceeded" }), {
      status: 429,
      headers: { "Retry-After": String(Math.ceil((data.resetAt - now) / 1000)) },
    });
  }

  return null;
}
