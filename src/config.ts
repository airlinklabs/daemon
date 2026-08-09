// bun loads .env automatically, no dotenv needed

import type { DaemonPaths } from './paths';

const ALL_ZEROS = '00000000000000000000000000000000';
const MIN_KEY_LENGTH = 16;

const required = (key: string, fallback?: string): string => {
  const val = Bun.env[key] ?? fallback;
  if (val === undefined) {
    console.error(`[config] required env var ${key} is missing`);
    process.exit(1);
  }
  return val;
};

const daemonKey = required('key');

if (daemonKey === ALL_ZEROS || daemonKey.length < MIN_KEY_LENGTH) {
  console.error('[config] FATAL: daemon key is insecure (default or too short). Set a unique key in .env');
  process.exit(1);
}

const RUNTIME_VALUES = ['docker', 'podman'] as const;
type ContainerRuntime = (typeof RUNTIME_VALUES)[number];

function parseContainerRuntime(raw: string | undefined): ContainerRuntime {
  if (raw === 'docker' || raw === 'podman') return raw;
  return 'docker';
}

interface DaemonConfig {
  readonly remote: string;
  readonly key: string;
  readonly port: number;
  readonly debug: boolean;
  readonly version: string;
  readonly statsInterval: number;
  readonly containerRuntime: ContainerRuntime;
  readonly allowedIps: readonly string[];
  readonly tlsCertPath: string | null;
  readonly tlsKeyPath: string | null;
  readonly sftpPort: number;
  readonly networkRateMbps: number;
  readonly requireHmac: boolean;
  /** Set once by resolveDaemonPaths() during bootstrap. Never null at runtime. */
  paths: DaemonPaths;
}

const config: DaemonConfig = {
  remote: required('remote', 'localhost'),
  key: daemonKey,
  port: parseInt(required('port', '3002'), 10),
  debug: Bun.env.DEBUG === 'true',
  version: required('version', '3.0.0'),
  statsInterval: parseInt(Bun.env.STATS_INTERVAL ?? '10000', 10),
  containerRuntime: parseContainerRuntime(Bun.env.CONTAINER_RUNTIME),
  allowedIps:
    Bun.env.ALLOWED_IPS?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? [],
  tlsCertPath: Bun.env.TLS_CERT ?? null,
  tlsKeyPath: Bun.env.TLS_KEY ?? null,
  sftpPort: parseInt(required('sftpPort', '3004'), 10),
  networkRateMbps: parseInt(Bun.env.NETWORK_RATE_MBPS ?? '0', 10) || 0,
  requireHmac: Bun.env.REQUIRE_HMAC !== 'false',
  // Assigned by resolveDaemonPaths() in bootstrap.ts before any handler runs.
  // Placeholder is overwritten synchronously before the event loop starts.
  paths: undefined as unknown as DaemonPaths,
};

// Production must NEVER allow unsigned requests.
if (!config.requireHmac && process.env.NODE_ENV === 'production') {
  console.error('[config] FATAL: REQUIRE_HMAC=false is not allowed in production. Remove it or set NODE_ENV=development.');
  process.exit(1);
}

export default config;
