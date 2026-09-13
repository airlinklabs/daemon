/**
 * Server binding and network defaults.
 */

export const DEFAULT_HOST = "0.0.0.0";

// HTTP server settings
export const SERVER_KEEPALIVE_TIMEOUT_MS = 65_000;
export const SERVER_HEADERS_TIMEOUT_MS = 65_000;
export const SERVER_REQUEST_TIMEOUT_MS = 120_000;
export const SERVER_SHUTDOWN_TIMEOUT_MS = 10_000;

// Graceful shutdown
export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 15_000;

// ── Loopback / localhost ──────────────────────────────────────────────────────
export const LOCALHOST = "localhost";
export const LOOPBACK_IP = "127.0.0.1";
export const LOOPBACK_IPV6_MAPPED = "::ffff:127.0.0.1";

// ── WebSocket upgrade ─────────────────────────────────────────────────────────
export const WS_UPGRADE_RATE_LIMIT = 60;
