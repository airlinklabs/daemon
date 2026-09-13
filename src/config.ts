// bun loads .env automatically, no dotenv needed

import { z } from "zod";
import type { DaemonPaths } from "./paths";

// Case-insensitive env lookup — Bun loads .env case-sensitively.

function env(name: string): string | undefined {
  const v = process.env[name];
  if (v !== undefined) return v;
  // try the other case
  const alt =
    name === name.toUpperCase() ? name.toLowerCase() : name.toUpperCase();
  return process.env[alt];
}

// If --config was used, AIRLINK_ENV_PATH is set before this module loads.
// Bun's auto .env loading only reads the cwd .env; we need to also inject
// the override file so config.ts sees all values.
if (env("AIRLINK_ENV_PATH")) {
  try {
    const { readFileSync } = require("node:fs");
    const { parseEnvFile } = require("./utils/parseEnv");
    const raw = readFileSync(env("AIRLINK_ENV_PATH")!, "utf8");
    const parsed = parseEnvFile(raw);
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) process.env[k] = v as string;
    }
  } catch (err) {
    console.error(
      `[config] warning: could not read AIRLINK_ENV_PATH="${env("AIRLINK_ENV_PATH")}": ${err}`,
    );
  }
}

// Zod schema for DaemonConfig.

const DaemonConfigSchema = z.object({
  remote: z.string().default("localhost"),
  key: z.string().min(16, "daemon key must be at least 16 characters"),
  port: z.coerce.number().int().min(1).max(65535).default(3002),
  debug: z.coerce.boolean().default(false),
  version: z.string().default("3.0.0"),
  statsInterval: z.coerce.number().int().min(1000).default(10000),
  containerRuntime: z.enum(["docker", "podman"]).default("docker"),
  allowedIps: z
    .string()
    .default("")
    .transform((val) =>
      val
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  tlsCertPath: z.string().nullable().default(null),
  tlsKeyPath: z.string().nullable().default(null),
  sftpPort: z.coerce.number().int().min(1).max(65535).default(3004),
  networkRateMbps: z.coerce.number().int().min(0).default(0),
  requireHmac: z.coerce.boolean().default(true),
  installerMemoryMb: z.coerce.number().int().min(256).default(2048),
  installerCpuPercent: z.coerce.number().int().min(100).default(100),
  tmpfsSizeMb: z.coerce.number().int().min(0).default(0),

  // ── Network ──
  host: z.string().default("0.0.0.0"),
  trustedProxies: z.string().default(""),
  xForwardedForDepth: z.number().int().min(0).max(10).default(1),
  behindProxy: z.coerce.boolean().default(false),

  // ── TLS ──
  tlsMinVersion: z.enum(["1.2", "1.3"]).default("1.2"),
  tlsCaCert: z.string().nullable().default(null),

  // ── Rate Limiting (HTTP) ──
  rateLimitRps: z.number().int().min(0).default(0),
  rateLimitBurst: z.number().int().min(0).default(0),

  // ── Logging ──
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  logFile: z.string().nullable().default(null),
  logMaxSizeMb: z.number().int().min(1).default(10),
  logMaxFiles: z.number().int().min(1).default(5),

  // ── Process ──
  pidFile: z.string().nullable().default(null),
  healthCheckInterval: z.number().int().min(0).default(30000),

  // ── WebSocket ──
  wsMaxMessageSize: z
    .number()
    .int()
    .min(1024)
    .default(64 * 1024),
  wsPingInterval: z.number().int().min(1000).default(30000),
  wsPongTimeout: z.number().int().min(1000).default(10000),

  // ── SFTP ──
  sftpBindAddress: z.string().default("0.0.0.0"),
  sftpMaxSessions: z.number().int().min(1).default(100),
  sftpMaxOpenFiles: z.number().int().min(1).default(1000),

  // ── Security ──
  maxCommandLength: z.number().int().min(1).default(4096),
  maxRequestBodySizeMb: z.number().int().min(1).default(64),
});

type DaemonConfig = z.infer<typeof DaemonConfigSchema> & {
  paths: DaemonPaths;
};

// Parse and validate.

const ALL_ZEROS = "00000000000000000000000000000000";

// Skip validation in test environments
const isTest =
  process.env.BUN_TEST === "true" || process.env.NODE_ENV === "test";

function parseConfig(): DaemonConfig {
  // In test mode, use defaults if env vars are missing
  const envKey = isTest
    ? (env("KEY") ?? "test-key-for-unit-tests-12345678")
    : env("KEY");

  const result = DaemonConfigSchema.safeParse({
    remote: env("REMOTE"),
    key: envKey,
    port: env("PORT"),
    debug: env("DEBUG"),
    version: env("VERSION"),
    statsInterval: env("STATS_INTERVAL"),
    containerRuntime: env("CONTAINER_RUNTIME"),
    allowedIps: env("ALLOWED_IPS"),
    tlsCertPath: env("TLS_CERT"),
    tlsKeyPath: env("TLS_KEY"),
    sftpPort: env("SFTP_PORT"),
    networkRateMbps: env("NETWORK_RATE_MBPS"),
    requireHmac: env("REQUIRE_HMAC"),
    installerMemoryMb: env("INSTALLER_MEMORY_MB"),
    installerCpuPercent: env("INSTALLER_CPU_PERCENT"),
    tmpfsSizeMb: env("TMPFS_SIZE_MB"),
    host: env("HOST"),
    trustedProxies: env("TRUSTED_PROXIES"),
    xForwardedForDepth: env("X_FORWARDED_FOR_DEPTH"),
    behindProxy: env("BEHIND_PROXY"),
    tlsMinVersion: env("TLS_MIN_VERSION"),
    tlsCaCert: env("TLS_CA_CERT"),
    rateLimitRps: env("RATE_LIMIT_RPS"),
    rateLimitBurst: env("RATE_LIMIT_BURST"),
    logLevel: env("LOG_LEVEL"),
    logFile: env("LOG_FILE"),
    logMaxSizeMb: env("LOG_MAX_SIZE_MB"),
    logMaxFiles: env("LOG_MAX_FILES"),
    pidFile: env("PID_FILE"),
    healthCheckInterval: env("HEALTH_CHECK_INTERVAL"),
    wsMaxMessageSize: env("WS_MAX_MESSAGE_SIZE"),
    wsPingInterval: env("WS_PING_INTERVAL"),
    wsPongTimeout: env("WS_PONG_TIMEOUT"),
    sftpBindAddress: env("SFTP_BIND_ADDRESS"),
    sftpMaxSessions: env("SFTP_MAX_SESSIONS"),
    sftpMaxOpenFiles: env("SFTP_MAX_OPEN_FILES"),
    maxCommandLength: env("MAX_COMMAND_LENGTH"),
    maxRequestBodySizeMb: env("MAX_REQUEST_BODY_SIZE_MB"),
  });

  if (!result.success) {
    console.error("[config] FATAL: invalid configuration");
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }

  const config = result.data;

  // Additional security checks (skip in test)
  if (!isTest) {
    if (config.key === ALL_ZEROS) {
      console.error(
        "[config] FATAL: daemon key is insecure (all zeros). Set a unique key in .env",
      );
      process.exit(1);
    }

    if (!config.requireHmac && process.env.NODE_ENV === "production") {
      console.error(
        "[config] FATAL: REQUIRE_HMAC=false is not allowed in production. Remove it or set NODE_ENV=development.",
      );
      process.exit(1);
    }

    // TLS config: both or neither
    if ((config.tlsCertPath === null) !== (config.tlsKeyPath === null)) {
      console.error(
        "[config] FATAL: both TLS_CERT and TLS_KEY must be set together",
      );
      process.exit(1);
    }
  }

  return config as DaemonConfig;
}

const config = parseConfig();

export default config;
