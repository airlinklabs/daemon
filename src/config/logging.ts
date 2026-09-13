/**
 * Logging constants.
 */

// Log rotation defaults
export const LOG_DEFAULT_MAX_SIZE_MB = 10;
export const LOG_DEFAULT_MAX_FILES = 5;
export const LOG_ROTATION_CHECK_INTERVAL_MS = 60_000;

// Log formatting
export const LOG_TIMESTAMP_FORMAT = "iso"; // 'iso' | 'unix' | 'local'
export const LOG_MAX_LINE_LENGTH = 32_768;

// Structured logging
export const LOG_REQUEST_ID_HEADER = "x-request-id";
export const LOG_CORRELATION_ID_LENGTH = 16;
