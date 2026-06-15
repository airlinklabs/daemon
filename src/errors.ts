// ── Typed Error Factory ──────────────────────────────────────────────────────
// All daemon API errors use a consistent shape: { error: string, code: ApiErrorCode }.
// The panel can narrow on `code` to show user-friendly messages.

export type ApiErrorCode =
  | 'invalid_json'
  | 'container_not_found'
  | 'path_traversal'
  | 'rate_limit_exceeded'
  | 'unauthorized'
  | 'hmac_expired'
  | 'hmac_invalid'
  | 'nonce_replayed'
  | 'missing_nonce'
  | 'missing_hmac_headers'
  | 'access_denied'
  | 'internal_error';

export interface ApiError {
  error: string;
  code: ApiErrorCode;
}

// Type-safe error factory. Uses `satisfies` to ensure the shape matches
// without widening the type. The panel can match on `code` to display
// contextual error messages instead of raw daemon strings.
export function apiError(code: ApiErrorCode, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message, code } satisfies ApiError), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
