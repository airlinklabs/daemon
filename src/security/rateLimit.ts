// nothing fancy, just counts hits per IP per minute and says no when they go over

const hits = new Map<string, { count: number; resetAt: number }>();

// clean up old entries every minute so the map doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of hits) {
    if (data.resetAt < now) hits.delete(ip);
  }
}, 60_000);

export function checkRateLimit(ip: string, limit = 300): Response | null {
  const now = Date.now();

  let data = hits.get(ip);
  if (!data || data.resetAt < now) {
    data = { count: 0, resetAt: now + 60_000 };
    hits.set(ip, data);
  }

  data.count++;
  if (data.count > limit) {
    return new Response(JSON.stringify({ error: 'rate limit exceeded' }), {
      status:  429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After':  String(Math.ceil((data.resetAt - now) / 1000)),
      },
    });
  }

  return null;
}
