# Airlink Daemon

**Node agent for Airlink Panel — v3.0.0**

The daemon runs on each node server and handles container lifecycle, resource monitoring, file management, and SFTP. The panel communicates with it over HTTP using basic auth and optional HMAC request signing.

---

## Overview

Each physical or virtual machine that hosts game servers runs one daemon instance. The panel registers the machine as a node and sends commands to it. The daemon executes them against Docker, streams console output back over WebSocket, and exposes a file system API for the panel's file manager.

---

## Prerequisites

- npm v9 or later
- Git
- Docker (running and accessible to the daemon process)

---

## Installation

## Manual

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

### Step 3 — Build 

```bash
npm run build
```


### Step 5 — Register with the panel

1. Log into your Airlink Panel as an admin
2. Go to **Admin → Nodes → Create**
3. Copy the configure command and paste it in the terminal

### Step 6 — Start

just execue the binary and the daemon is now good to go
---

## Links

- Panel: [github.com/airlinklabs/panel](https://github.com/airlinklabs/panel)
- Website: [airlinklabs.github.io/home](https://airlinklabs.github.io/home/)
- Docs: [airlinklabs.github.io/home/docs/quickstart](https://airlinklabs.github.io/home/docs/quickstart/)
- Discord: [discord.gg/ujXyxwwMHc](https://discord.gg/ujXyxwwMHc)

---

## License

MIT — see [`LICENSE`](LICENSE) for details.