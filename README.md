# Airlink Daemon

**The thing that actually runs your game servers -_-**

![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-141323?style=for-the-badge&logo=bun&logoColor=white)
[![License](https://img.shields.io/github/license/AirlinkLabs/daemon)](https://github.com/AirlinkLabs/daemon/blob/main/LICENSE)
[![Discord](https://img.shields.io/discord/1302020587316707420)](https://discord.gg/ujXyxwwMHc)

---

## What is this?

The Airlink Daemon is a lightweight agent that runs on each node server. It listens for commands from the panel, manages Docker containers, streams console output, handles file operations, and exposes SFTP access. It does the dirty work so the panel can stay pretty -_-

**What it handles:**
- Container lifecycle (create, start, stop, kill, delete)
- File system operations (list, read, write, upload, download, zip/unzip)
- SFTP credential management
- Live console streaming over WebSocket
- Container stats and status monitoring
- Backup creation, restore, and download
- Minecraft server query (player lists)
- Security radar scanning
- HMAC-signed authentication (nobody gets in without the key)

---

## Prerequisites

- Bun v1.0 or later
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

### Step 3 — Install and build

```bash
bun install
bun run build
```

### Step 4 — Register with the panel

1. Log into your Airlink Panel as an admin
2. Go to **Admin → Nodes → Create**
3. Copy the configure command and paste it in the terminal

### Step 5 — Start

```bash
./airlinkd
```

Or with the built binary:

```bash
bun run start
```

The daemon is now listening for panel commands. It will obediently do whatever the panel tells it to -_-

---

## Configuration

The daemon reads its configuration from command-line arguments or environment variables:

| Argument | Env Variable | Description |
|----------|-------------|-------------|
| `args[0]` | `remote` | Panel URL (e.g. `http://192.168.1.10:3000`) |
| `args[1]` | `key` | Authentication key (must match the panel's node key) |
| `args[2]` | `port` | Port to listen on (default: 3002) |

---

## Security

Every request to the daemon goes through a multi-layer auth pipeline:

1. **IP Allowlist** — only approved panel IPs get through
2. **Basic Auth** — `Authorization: Basic <base64(Airlink:<key>)>`
3. **HMAC-SHA256** — request signature verification with nonce-based replay protection

The panel signs every request. The daemon verifies every signature. No signature, no service -_-

See the [API Specsheet](../panel/docs/specsheet.md#hmac-protocol) for the full HMAC protocol details.

---

## API Reference

The daemon exposes 37 HTTP routes and 3 WebSocket endpoints. See the [API Specsheet](../panel/docs/specsheet.md#daemon-routes) for the complete route catalog.

**Quick reference:**

| Category | Endpoints | Description |
|----------|-----------|-------------|
| System | `GET /`, `GET /stats`, `GET /healthz` | Daemon identity, stats, health check |
| Containers | 9 routes | Install, start, stop, kill, delete, status, stats, command |
| Backups | 5 routes | Create, restore, delete, download, upload |
| Filesystem | 13 routes | List, read, write, upload, download, zip, rename, etc. |
| SFTP | 3 routes | Credentials create/revoke, status |
| Minecraft | 1 route | Player list query |
| Radar | 2 routes | Security scan, zip results |
| WebSocket | 3 endpoints | Console, status, lifecycle events |

---

## Development

```bash
# Install deps
bun install

# Run tests
bun test

# Typecheck
bunx tsc --noEmit

# Build for production
bun run build
```

---

## How It Fits Together

```
┌──────────────┐      HTTP/HMAC       ┌──────────────┐      Docker API      ┌──────────────┐
│   Browser    │ ──────────────────▶  │ Panel (Bun)  │ ──────────────────▶  │ Daemon (Bun) │
│              │ ◀─── session/cookie  │  Port 3000   │ ◀─── JSON responses  │  Port 3002   │
└──────────────┘                      └──────────────┘                      └──────┬───────┘
                                                                                   │
                                                                             ┌─────▼──────┐
                                                                             │   Docker   │
                                                                             │ Containers │
                                                                             └────────────┘
```

The panel is the brain. The daemon is the hands. Together, they run your game servers -_-

---

## Links

- Panel: [github.com/airlinklabs/panel](https://github.com/airlinklabs/panel)
- Website: [airlinklabs.xyz](https://airlinklabs.xyz/)
- Docs: [airlinklabs.xyz/docs/quick-start](https://airlinklabs.xyz/docs/quick-start/)
- Discord: [discord.gg/ujXyxwwMHc](https://discord.gg/ujXyxwwMHc)

---

## License

MIT — see [`LICENSE`](LICENSE) for details.
