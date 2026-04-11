// bun loads .env automatically, no dotenv needed

const required = (key: string, fallback?: string): string => {
  const val = Bun.env[key] ?? fallback;
  if (val === undefined) {
    console.error(`[config] required env var ${key} is missing`);
    process.exit(1);
  }
  return val;
};

const config = {
  remote:        required('remote', 'localhost'),
  key:           required('key', '00000000000000000000000000000000'),
  port:          parseInt(required('port', '3002'), 10),
  debug:         Bun.env['DEBUG'] === 'true',
  version:       required('version', '3.0.0'),
  statsInterval: parseInt(Bun.env['STATS_INTERVAL'] ?? '10000', 10),
  allowedIps:    Bun.env['ALLOWED_IPS']?.split(',').map(s => s.trim()).filter(Boolean) ?? [],
  tlsCertPath:   Bun.env['TLS_CERT'] ?? null,
  tlsKeyPath:    Bun.env['TLS_KEY'] ?? null,
} as const;

export default config;
