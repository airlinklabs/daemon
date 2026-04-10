const required = (key: string, fallback?: string): string => {
  const value = Bun.env[key] ?? fallback;
  if (value === undefined) {
    console.error(`[config] missing required env var ${key}`);
    process.exit(1);
  }
  return value;
};

const config = {
  remote: required("remote", "localhost"),
  key: required("key", "00000000000000000000000000000000"),
  port: Number.parseInt(required("port", "3002"), 10),
  debug: Bun.env.DEBUG === "true",
  version: required("version", "3.0.0"),
  statsInterval: Number.parseInt(Bun.env.STATS_INTERVAL ?? "10000", 10),
  requireHmac: Bun.env.REQUIRE_HMAC !== "false",
  allowedIps:
    Bun.env.ALLOWED_IPS?.split(",").map((part: string) => part.trim()).filter(Boolean) ?? [],
  behindProxy: Bun.env.BEHIND_PROXY === "true",
  tlsCertPath: Bun.env.TLS_CERT || null,
  tlsKeyPath: Bun.env.TLS_KEY || null,
} as const;

export default config;
