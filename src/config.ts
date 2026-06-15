// bun loads .env automatically, no dotenv needed

const ALL_ZEROS = '00000000000000000000000000000000';

const required = (key: string, fallback?: string): string => {
  const val = Bun.env[key] ?? fallback;
  if (val === undefined) {
    console.error(`[config] required env var ${key} is missing`);
    process.exit(1);
  }
  return val;
};

const daemonKey = required('key');

if (daemonKey === ALL_ZEROS || daemonKey.length < 16) {
  console.error('[config] FATAL: daemon key is insecure (default or too short). Set a unique key in .env');
  process.exit(1);
}

const config = {
  remote: required('remote', 'localhost'),
  key: daemonKey,
  port: parseInt(required('port', '3002'), 10),
  debug: Bun.env.DEBUG === 'true',
  version: required('version', '3.0.0'),
  statsInterval: parseInt(Bun.env.STATS_INTERVAL ?? '10000', 10),
  containerRuntime: (Bun.env.CONTAINER_RUNTIME || 'docker') as 'docker' | 'podman',
  allowedIps:
    Bun.env.ALLOWED_IPS?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? [],
  tlsCertPath: Bun.env.TLS_CERT ?? null,
  tlsKeyPath: Bun.env.TLS_KEY ?? null,
} as const;

export default config;
