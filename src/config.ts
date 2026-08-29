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
