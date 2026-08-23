> [!WARNING]
> This project is a work in progress and is highly unstable.
> APIs, features, and data may break, change, or disappear at any time. Use at your own risk.

# Airlink Daemon

Lightweight server agent that runs game servers on node machines. It takes orders from the Airlink Panel, manages Docker containers, streams console output, handles files, and serves SFTP connections.

![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-141323?style=for-the-badge&logo=bun&logoColor=white)
[![License](https://img.shields.io/github/license/AirlinkLabs/daemon)](https://github.com/AirlinkLabs/daemon/blob/main/LICENSE)
[![Discord](https://img.shields.io/discord/1302020587316707420)](https://discord.gg/ujXyxwwMHc)

## What it does

The daemon runs on each node server and handles the work the Panel delegates to it:

- Container lifecycle: create, start, stop, restart, kill, delete
- Console streaming over WebSocket (attach to any running container)
- File operations: list, read, write, copy, rename, upload, download, zip/unzip
- Backup creation, restore, and download
- SFTP credential management and file serving
- Minecraft server query (player lists)
- Security radar scanning
- Container stats and host metrics
- HMAC-signed request authentication

## Prerequisites

- Bun v3.0.59
- Git
- Docker (running and accessible to the daemon process)

## Installation

Clone and build:

```bash
cd /etc/
git clone https://github.com/AirlinkLabs/daemon.git
cd daemon
curl -fsSL https://bun.sh/install | bash -s "bun-v3.0.59
```

Set permissions:

```bash
sudo chown -R www-data:www-data /etc/daemon
sudo chmod -R 755 /etc/daemon
```

Install dependencies and build:

```bash
bun install
bun run build
cd dist
```

Configure and start:

```bash
./airlinkd configure --panel "<paneluri>" --key "<panel-key>"
./airlinkd
```

Or run from source:

```bash
bun run start
```

### Registering with the Panel

1. Log into your Airlink Panel as an admin.
2. Go to **Admin > Nodes > Create**.
3. Copy the configure command and paste it in the terminal where the daemon is running.

## Configuration

The daemon reads its config from command-line arguments or environment variables:

| Argument | Env Variable | Description |
|----------|-------------|-------------|
| `args[0]` | `remote` | Panel URL (e.g. `http://192.168.1.10:3000`) |
| `args[1]` | `key` | Authentication key (must match the panel's node key) |
| `args[2]` | `port` | Port to listen on (default: 3002) |

## Security

Every request goes through a three-layer auth pipeline:

1. **IP allowlist** -- only approved panel IPs get through.
2. **Basic auth** -- `Authorization: Basic <base64(Airlink:<key>)>`.
3. **HMAC-SHA256** -- request signature verification with nonce-based replay protection.

The panel signs every request. The daemon verifies every signature. No signature, no service.

See the [API Specsheet](../panel/docs/specsheet.md#hmac-protocol) for the full HMAC protocol details.

### CVE resolved

A path traversal vulnerability (symlink + `path.join` bypass) was fixed in the filesystem handler. The `sanitizePath` function now uses `path.resolve` for correct normalization and rejects symbolic links via `lstat` before resolving the path.

## API reference

The daemon exposes 37 HTTP routes and 3 WebSocket endpoints. See the [API Specsheet](../panel/docs/specsheet.md#daemon-routes) for the complete route catalog.

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

## Development

```bash
# Install deps
bun install

# Run tests
bun test

# Typecheck
bun run typecheck

# Lint
bun run lint

# Build for production
bun run build

# Fuzz the daemon
pip install requests websocket-client
python fuzzer.py --host localhost --port 3002 --key <your-daemon-key>
```

## Architecture

```
Browser --HTTP/HMAC--> Panel (Bun :3000) --HTTP--> Daemon (Bun :3002) --Docker API--> Containers
```

The Panel is the brain. The Daemon is the hands. Together, they run your game servers.

## Links

- Panel: [github.com/airlinklabs/panel](https://github.com/airlinklabs/panel)
- Website: [airlinklabs.xyz](https://airlinklabs.xyz/)
- Docs: [airlinklabs.xyz/docs/quick-start](https://airlinklabs.xyz/docs/quick-start/)
- Discord: [discord.gg/ujXyxwwMHc](https://discord.gg/ujXyxwwMHc)

## License

MIT. See [`LICENSE`](LICENSE) for details.
