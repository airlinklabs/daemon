/**
 * Docker-specific constants — API versions, security, networking.
 */

// ── Docker API version (must match dockerode) ─────────────────────────────────
export const DOCKER_API_VERSION = "v1.41";

// ── DNS servers (Wings-compatible) ────────────────────────────────────────────
export const DEFAULT_DNS_SERVERS = ["1.1.1.1", "1.0.0.1"];

// ── Security drop set (Wings-compatible) ──────────────────────────────────────
export const WINGS_CAP_DROP = [
  "setpcap",
  "mknod",
  "audit_write",
  "net_raw",
  "dac_override",
  "fowner",
  "fsetid",
  "net_bind_service",
  "sys_chroot",
  "setfcap",
] as const;

// ── Forbidden mount prefixes ──────────────────────────────────────────────────
export const FORBIDDEN_MOUNT_PREFIXES = [
  "/proc",
  "/sys",
  "/dev",
  "/run",
] as const;

// ── Console FIFO ──────────────────────────────────────────────────────────────
export const CONSOLE_FIFO_RELATIVE_PATH = ".airlinkd/console.in";

// ── Container defaults ────────────────────────────────────────────────────────
export const DOCKER_DEFAULT_PROTOCOL = "tcp";
export const DOCKER_RESTART_POLICY = "unless-stopped";
export const DOCKER_LOG_DRIVER = "local";
export const DOCKER_INSTALLER_NETWORK_MODE = "bridge";

// ── Stats display ─────────────────────────────────────────────────────────────
export const DOCKER_DISPLAY_CONTAINER_ID_LENGTH = 12;
export const DOCKER_ERROR_MSG_MAX_LENGTH = 40;
export const DOCKER_MAX_DISPLAY_CONTAINERS = 8;
