// ── Typed Error Factory ──────────────────────────────────────────────────────
// All daemon API errors use a consistent shape: { error, code, status }.
// The panel can narrow on `code` to show user-friendly messages.

export type ApiErrorCode =
  | 'invalid_json'
  | 'invalid_request'
  | 'container_not_found'
  | 'path_traversal'
  | 'rate_limit_exceeded'
  | 'unauthorized'
  | 'hmac_expired'
  | 'hmac_invalid'
  | 'nonce_replayed'
  | 'missing_nonce'
  | 'missing_digest'
  | 'digest_mismatch'
  | 'invalid_payload_version'
  | 'missing_hmac_headers'
  | 'access_denied'
  | 'internal_error'
  | 'not_found'
  | 'port_conflict'
  | 'checksum_mismatch'
  | 'request_too_large'
  | 'local_only'
  | 'unsupported_content_type'
  | 'duplicate_query_key'
  | 'nonce_storage_full'
  | 'invalid_nonce';

export interface ApiError {
  error: string;
  code: ApiErrorCode;
  status: number;
  detail?: string;
}

// Type-safe error factory. Uses `satisfies` to ensure the shape matches
// without widening the type. The panel can match on `code` to display
// contextual error messages instead of raw daemon strings.
export function apiError(code: ApiErrorCode, message: string, status: number, detail?: string): Response {
  const body: ApiError = { error: message, code, status };
  if (detail) body.detail = detail;
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
