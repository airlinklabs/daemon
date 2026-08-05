// ── Body size limits ─────────────────────────────────────────────────────────
// Content-Length is only a fast-path pre-check; the HMAC layer enforces the
// cap on actual bytes read. Per-route caps exist because backup uploads are
// allowed to be far larger than regular JSON requests.

export const MAX_REQUEST_BODY_BYTES = 100 * 1024 * 1024;
export const MAX_BACKUP_UPLOAD_BYTES = 50 * 1024 * 1024 * 1024;

// Route key format: `${method} ${pathname}` — must match router.ts.
export function maxBodyBytesFor(routeKey: string): number {
  if (routeKey === 'POST /container/backup/upload') return MAX_BACKUP_UPLOAD_BYTES;
  return MAX_REQUEST_BODY_BYTES;
}
