/**
 * File size limits, body-parser limits, upload thresholds.
 * All values in bytes unless noted.
 */

// ── Request body limits ───────────────────────────────────────────────────────
export const MAX_REQUEST_BODY_BYTES = 100 * 1024 * 1024;
export const MAX_BACKUP_UPLOAD_BYTES = 50 * 1024 * 1024 * 1024;

// ── File content limits ───────────────────────────────────────────────────────
export const MAX_FILE_CONTENT_BYTES = 10 * 1024 * 1024;

// ── Pull limits ───────────────────────────────────────────────────────────────
export const MAX_PULL_BYTES = 512 * 1024 * 1024;

// ── Radar scanning limits ─────────────────────────────────────────────────────
export const RADAR_MAX_CONTENT_READ_BYTES = 10 * 1024 * 1024;
export const RADAR_MAX_CONTENT_SCAN_FILES = 20_000;

// ── Log limits ────────────────────────────────────────────────────────────────
export const DEFAULT_LOG_HISTORY_LIMIT = 500;

// ── Directory listing limits ──────────────────────────────────────────────────
export const MAX_DIR_DEPTH = 20;
export const MAX_DIR_LISTING_ENTRIES = 256;

// ── Rate limits ───────────────────────────────────────────────────────────────
export const DEFAULT_RATE_LIMIT = 300;

// ── Container defaults ────────────────────────────────────────────────────────
export const DEFAULT_MEMORY_MB = 512;
export const DEFAULT_CPU_PERCENT = 100;
export const DEFAULT_STORAGE_MB = 0;
export const DEFAULT_SWAP_MB = 0;

// ── Installer defaults ────────────────────────────────────────────────────────
export const INSTALLER_MEMORY_MB = 2048;
export const INSTALLER_CPU_PERCENT = 100;

// ── Docker container limits ───────────────────────────────────────────────────
export const PIDS_LIMIT = 256;
export const BLKIO_WEIGHT = 500;
export const CPU_NANO_FACTOR = 1e9;

// ── Validation ────────────────────────────────────────────────────────────────
export const MAX_CONTAINER_ID_LENGTH = 64;

// ── Nonce limits ──────────────────────────────────────────────────────────────
export const MAX_NONCE_MAP_SIZE = 10_000;
export const MAX_NONCE_LENGTH = 128;

// ── Download tokens ───────────────────────────────────────────────────────────
export const MAX_DOWNLOAD_TOKENS = 10_000;

// ── WebSocket ─────────────────────────────────────────────────────────────────
export const MAX_WS_CONNECTIONS = 200;
export const MAX_WS_AUTH_ATTEMPTS = 5;

// ── Operation manager ─────────────────────────────────────────────────────────
export const MAX_CONCURRENT_OPERATIONS = 4;

// ── SFTP ──────────────────────────────────────────────────────────────────────
export const SFTP_ACTIVITY_BUFFER_LIMIT = 500;
export const MAX_SFTP_OPEN_FILES = 2_000;
export const MAX_SFTP_OPEN_FILES_PER_SESSION = 100;

// ── Stats collection ──────────────────────────────────────────────────────────
export const STATS_MAX_ENTRIES = 2_000;

// ── Daemon stats ──────────────────────────────────────────────────────────────
export const DAEMON_STATS_PREV_PROCS_CAP = 300;
export const DAEMON_STATS_TOP_PROCS_LIMIT = 4;
export const DAEMON_ERROR_LOG_TAIL_CAP = 4 * 1024 * 1024;
export const DAEMON_ERROR_COUNT_CUTOFF_MS = 24 * 3600 * 1000;

// ── Host stats ────────────────────────────────────────────────────────────────
export const HOST_MAX_DISKS = 4;
export const HOST_MAX_NETWORK_INTERFACES = 2;
export const HOST_MAX_DISK_IO_DEVICES = 3;
export const HOST_MAX_THERMAL_ZONES = 4;

// ── Nodestats ─────────────────────────────────────────────────────────────────
export const NODE_STATS_HISTORY_SLICE = 30;

// ── Memory overhead multipliers (Wings-compatible) ────────────────────────────
export const MEMORY_OVERHEAD_SMALL_MB = 2048;
export const MEMORY_OVERHEAD_SMALL_FACTOR = 1.15;
export const MEMORY_OVERHEAD_MEDIUM_MB = 4096;
export const MEMORY_OVERHEAD_MEDIUM_FACTOR = 1.1;
export const MEMORY_OVERHEAD_LARGE_FACTOR = 1.05;

// ── Network throttle ──────────────────────────────────────────────────────────
export const TC_BURST = "64kb";
export const TC_LATENCY = "50ms";

// ── Installer error log tail ──────────────────────────────────────────────────
export const INSTALLER_ERROR_LOG_TAIL_LINES = 20;

// ── Logger ────────────────────────────────────────────────────────────────────
export const LOG_BUFFER_SIZE = 150;
export const MAX_LOG_LINE_BYTES = 32 * 1024;
export const MAX_PENDING_BYTES = 64 * 1024;
export const LOG_MAX_BYTES = 5 * 1024 * 1024;

// ── Console ───────────────────────────────────────────────────────────────────
export const MAX_COMMAND_LENGTH = 4096;

// ── Min key length ────────────────────────────────────────────────────────────
export const MIN_KEY_LENGTH = 16;

// ── Path jail ────────────────────────────────────────────────────────────────
export const MAX_PATH_LENGTH = 4096;
export const MAX_SYMLINK_DEPTH = 10;

// ── System ───────────────────────────────────────────────────────────────────
export const SYSTEM_CLK_TCK = 100;
