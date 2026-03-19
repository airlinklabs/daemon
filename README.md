# Airlink Daemon

**Node agent for Airlink Panel — v2.0.0-rc1**

The daemon runs on each node server and handles container lifecycle, resource monitoring, file management, and SFTP. The panel communicates with it over HTTP using basic auth and optional HMAC request signing.

---

## Overview

Each physical or virtual machine that hosts game servers runs one daemon instance. The panel registers the machine as a node and sends commands to it. The daemon executes them against Docker, streams console output back over WebSocket, and exposes a file system API for the panel's file manager.

---

## Prerequisites

- Node.js v18 or later
- npm v9 or later
- Git
- Docker (running and accessible to the daemon process)

---

## Installation

### Step 1 — Clone the repository

```bash
cd /etc/
git clone https://github.com/AirlinkLabs/daemon.git
cd daemon
```

### Step 2 — Set permissions

```bash
sudo chown -R www-data:www-data /etc/daemon
sudo chmod -R 755 /etc/daemon
```

### Step 3 — Install dependencies

```bash
npm install
```

### Step 4 — Configure environment

```bash
cp example.env .env
```

Edit `.env` and set at minimum:

| Variable | Description |
|----------|-------------|
| `PORT` | Port the daemon listens on (default: `3001`) |
| `KEY` | Shared secret — must match the key you enter in the panel when creating the node |
| `SFTP_PORT` | Port for the built-in SFTP server (default: `3003`) |
| `REQUIRE_HMAC` | Set to `true` to enforce HMAC request signing (see Security below) |

### Step 5 — Build

```bash
npm run build
```

### Step 6 — Register with the panel

1. Log into your Airlink Panel as an admin
2. Go to **Admin → Nodes → Create**
3. Enter the daemon's address, port, and the `KEY` value from your `.env`
4. Copy the generated configuration snippet and paste it into your `.env` if prompted

### Step 7 — Start

```bash
npm start
```

### Running with pm2

```bash
npm install -g pm2
pm2 start dist/app/app.js --name airlink-daemon
pm2 save
pm2 startup
```

---

## Security

### Basic auth

Every request to the daemon must include HTTP basic auth credentials with `Airlink` as the username and the node `KEY` as the password. The panel sends these automatically.

### HMAC request signing (new in 2.0.0-rc1)

The daemon now ships with `hmacMiddleware` — a second layer of request verification on top of basic auth. When enabled, the panel signs every outbound request with an HMAC-SHA256 signature derived from the request method, path, body, and a Unix timestamp. The daemon verifies the signature and rejects requests where the timestamp is more than 30 seconds old (replay protection).

**Permissive mode (default)** — requests without HMAC headers are logged and allowed through. This keeps the daemon compatible with older panel versions.

**Strict mode** — set `REQUIRE_HMAC=true` in `.env`. Requests without valid HMAC headers are rejected with `401`. Use this when both the panel and daemon are on 2.0.0-rc1 or later.

The signing algorithm:
```
payload  = "{timestamp}:{METHOD}:{path}:{body}"
signature = HMAC-SHA256(KEY, payload)
headers  = X-Airlink-Timestamp, X-Airlink-Signature
```

---

## Architecture

```
src/
├── app/
│   ├── app.ts              — Express setup and graceful shutdown
│   ├── hmacMiddleware.ts   — HMAC request signature verification (new)
│   ├── init.ts             — Startup sequence
│   ├── middleware.ts       — Basic auth, body parsing, logging
│   └── routes.ts           — Dynamic async route loader
├── handlers/
│   ├── instances/          — Container lifecycle (create, start, stop, kill, delete, attach)
│   ├── filesystem/         — File read/write/delete/rename
│   ├── minecraft/          — Player count fetching via server-status protocol
│   ├── radar/              — VirusTotal file scanning
│   ├── sftp/               — Built-in SFTP server
│   └── stats.ts            — CPU/RAM/disk metrics with per-period filtering
├── routes/
│   ├── core.ts             — Health check, system stats
│   ├── instances.ts        — Container control endpoints
│   ├── fileSystem.ts       — File manager endpoints
│   ├── minecraft.ts        — Player data endpoint
│   ├── radar.ts            — File scan endpoint
│   └── sftp.ts             — SFTP credential endpoints
└── utils/
    ├── config.ts           — Environment config loader
    ├── errorHandler.ts     — Global error handler
    ├── fileSpecifier.ts    — Safe path resolution
    ├── logger.ts           — Structured logger
    └── validation.ts       — Input validation helpers
```

---

## What's new in 2.0.0-rc1

**HMAC request signing** — A new `hmacMiddleware` module verifies an HMAC-SHA256 signature on every incoming request. This prevents requests from being replayed or forged even if the basic auth key is leaked. The panel's `daemonRequest` utility sends matching signed headers automatically. Strict enforcement is opt-in via `REQUIRE_HMAC=true`.

**Async route loader** — `routes.ts` now uses `await import()` instead of synchronous `require()`. This is more correct for a Node.js ESM-compatible codebase and avoids blocking the event loop during startup.

**Stats API cleanup** — `getStatsForPeriod` is now a named export rather than an inline closure inside `getSystemStats`. The core route uses the cleaner exported function directly. `getCurrentStats` and `saveStats` are also properly exported so `app.ts` can import them directly instead of using a dynamic `import()` at shutdown.

**Leaner shutdown** — The graceful shutdown sequence no longer attempts to `ping()` Docker before exit (the connection has no explicit disconnect method anyway) and downgraded noisy `logger.info` shutdown messages to `logger.debug` so production logs aren't flooded on every restart.

---

## Links

- Panel: [github.com/airlinklabs/panel](https://github.com/airlinklabs/panel)
- Website: [airlinklabs.github.io/home](https://airlinklabs.github.io/home/)
- Docs: [airlinklabs.github.io/home/docs/quickstart](https://airlinklabs.github.io/home/docs/quickstart/)
- Discord: [discord.gg/ujXyxwwMHc](https://discord.gg/ujXyxwwMHc)

---

## License

MIT — see [`LICENSE`](LICENSE) for details.
