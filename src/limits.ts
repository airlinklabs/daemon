// Body size limits — per-route caps enforced by the HMAC layer on actual bytes read.

import {
  MAX_REQUEST_BODY_BYTES,
  MAX_BACKUP_UPLOAD_BYTES,
} from "./config/limits";

export { MAX_REQUEST_BODY_BYTES, MAX_BACKUP_UPLOAD_BYTES };

// Route key format: `${method} ${pathname}` — must match router.ts.
export function maxBodyBytesFor(routeKey: string): number {
  if (routeKey === "POST /container/backup/upload")
    return MAX_BACKUP_UPLOAD_BYTES;
  return MAX_REQUEST_BODY_BYTES;
}
