/**
 * Time durations (milliseconds).
 * Import from here — never inline `60 * 1000` etc.
 */

// ── Docker ────────────────────────────────────────────────────────────────────
export const CONSOLE_FIFO_WRITE_TIMEOUT_MS = 10_000;
export const STORAGE_ENFORCE_INTERVAL_MS = 30_000;
export const STOP_GRACEFUL_TIMEOUT_MS = 20_000;
export const STOP_GRACEFUL_POLL_MS = 500;
export const STOP_FORCE_TIMEOUT_S = 5;
export const STOP_COMMAND_WAIT_MS = 2_000;

// ── Docker event reconnection ─────────────────────────────────────────────────
export const DOCKER_EVENT_RECONNECT_ERROR_MS = 5_000;
export const DOCKER_EVENT_RECONNECT_END_MS = 2_000;

// ── HMAC / Security ───────────────────────────────────────────────────────────
export const HMAC_WINDOW_SECS = 30;
export const HMAC_NONCE_SWEEP_MS = 5_000;
export const DOWNLOAD_TOKEN_TTL_MS = 90_000;
export const DOWNLOAD_TOKEN_CLEANUP_MS = 30_000;

// ── Rate limiting ─────────────────────────────────────────────────────────────
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_CLEANUP_MS = 60_000;

// ── WebSocket ─────────────────────────────────────────────────────────────────
export const WS_AUTH_TIMEOUT_MS = 10_000;
export const WS_IDLE_TIMEOUT_S = 30;

// ── Stats collection ──────────────────────────────────────────────────────────
export const CPU_SAMPLE_INTERVAL_MS = 100;
export const STATS_MAX_AGE_MS = 30 * 60 * 1000;
export const STATS_HEALTH_CHECK_TIMEOUT_MS = 1_500;

// ── SFTP ──────────────────────────────────────────────────────────────────────
export const SFTP_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const SFTP_SESSION_CLEANUP_MS = 60 * 60 * 1000;

// ── Filesystem ────────────────────────────────────────────────────────────────
export const FS_LIST_RATE_WINDOW_MS = 1_000;
export const FS_LIST_RATE_LOCKOUT_MS = 3_000;
export const FS_DOWNLOAD_ABORT_MS = 30_000;
export const FS_PULL_ABORT_MS = 60_000;

// ── Log history ───────────────────────────────────────────────────────────────
export const LOG_BUFFER_TTL_MS = 10 * 60 * 1000;

// ── Minecraft ─────────────────────────────────────────────────────────────────
export const MINECRAFT_PING_TIMEOUT_MS = 5_000;

// ── Operation manager ─────────────────────────────────────────────────────────
export const SHUTDOWN_OPERATIONS_TIMEOUT_MS = 10_000;
export const SHUTDOWN_POLL_INTERVAL_MS = 200;

// ── Node stats ────────────────────────────────────────────────────────────────
export const NODE_STATS_POLL_MS = 3_000;
export const CONTAINER_STATUS_POLL_MS = 2_000;

// ── Crash detection ───────────────────────────────────────────────────────────
export const CRASH_RESTART_DELAY_MS = 5_000;

// ── Radar scanning ────────────────────────────────────────────────────────────
export const RADAR_MAX_CONTENT_SCAN_MS = 10_000;

// ── Docker stats collection ──────────────────────────────────────────────────
export const DOCKER_FETCH_DEFAULT_TIMEOUT_MS = 3_000;
export const DOCKER_FETCH_LIST_TIMEOUT_MS = 4_000;
export const DOCKER_CONTAINER_STATS_TIMEOUT_MS = 3_500;

// ── Install ───────────────────────────────────────────────────────────────────
export const INSTALL_REPORT_TIMEOUT_MS = 5_000;

// ── Filesystem rate limiting ──────────────────────────────────────────────────
export const FS_LIST_RATE_WINDOW_S = 1;
export const FS_LIST_MAX_REQUESTS = 5;

// ── Logger ────────────────────────────────────────────────────────────────────
export const LOG_FILE_MAX_BYTES = 1024 * 1024;
