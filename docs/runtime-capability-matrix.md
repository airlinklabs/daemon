# Runtime Capability Matrix

This document declares every supported container runtime cell and its enforcement status. The panel consumes the daemon's capability report to hide/disable unsupported options.

## Supported Cells

| Dimension | Docker (rootful) | Podman (rootful) | Podman (rootless) |
|---|---|---|---|
| Engine | Docker Engine API v1.40+ (via Dockerode) | Podman API v4.0+ (Docker-compatible compat API) | Same as Podman rootful |
| Mode | rootful, systemd-managed | rootful, user-owned service | rootless, user namespace, slirp4netns/pasta |
| Host | Linux, cgroup v1/v2, overlay2/btrfs/zfs | Linux, cgroup v2 (v1 partial), overlay fuse-overlayfs | Linux, cgroup v2 delegated, no NET_ADMIN by default |
| Endpoint | `/var/run/docker.sock` (validated) | `/run/podman/podman.sock` (validated) | `$XDG_RUNTIME_DIR/podman/podman.sock` (validated) |
| Security baseline | No privileged, no host PID/NET/IPC, no socket bind, no arbitrary caps, no writable host mounts except `/home/container` | Same | Same + user namespace remapping expected |

## Operations

| Operation | Docker | Podman rootful | Podman rootless | Notes |
|---|---|---|---|---|
| pull | enforced | enforced | enforced | Progress events forwarded |
| create | enforced | enforced | enforced | With validated HostConfig |
| start/stop/kill/delete | enforced | enforced | enforced | Graceful stop -> SIGTERM -> SIGKILL |
| exec (console) | enforced | enforced | enforced | FIFO-based stdin injection |
| attach/logs | enforced | enforced | enforced | Docker multiplexed stream |
| events | enforced | enforced | enforced | Container lifecycle events |
| stats | enforced | enforced | enforced | CPU/memory from Docker stats API |
| images | enforced | enforced | enforced | Image inspect for entrypoint detection |
| ports | enforced | enforced | enforced | HostConfig PortBindings |
| mounts | enforced | enforced | enforced | Validated bind mounts only |

## Resource Limits

| Limit | Docker rootful | Podman rootful | Podman rootless | Enforcement |
|---|---|---|---|---|
| Memory | enforced | enforced | enforced | Docker HostConfig `Memory` (bytes) |
| CPU | enforced | enforced | enforced | Docker HostConfig `NanoCpus` |
| PIDs | enforced | enforced | enforced | Docker HostConfig `PidsLimit=256` |
| Swap | enforced | enforced | enforced | Docker HostConfig `MemorySwap` |
| Storage | **advisory** (soft 30s poll) | **advisory** (soft 30s poll) | **advisory** (soft 30s poll) | `StorageOpt` is Docker overlay2-only; fallback is directory-size polling |
| Network rate | **advisory** (tc inside container) | **unsupported** | **unsupported** | Requires NET_ADMIN + `tc` binary in image |
| BlkioWeight | enforced (500) | enforced (500) | enforced (500) | Docker HostConfig `BlkioWeight` |
| OomKillDisable | enforced (false) | enforced (false) | enforced (false) | Never disable OOM killer |

## Limit Enforcement Classification

- **enforced**: The runtime natively enforces this limit. If the runtime rejects the option, container creation fails.
- **advisory**: The daemon implements a best-effort policy (e.g., background polling). The panel shows enforcement status and failure reason.
- **unsupported**: The runtime cannot enforce this limit in this mode. The panel hides the control and explains why.

## Panel Consumption

The daemon exposes `GET /capabilities` (HMAC-authenticated) returning a versioned JSON report:

```json
{
  "version": 1,
  "runtime": "docker",
  "apiVersion": "1.40",
  "rootless": false,
  "socketValid": true,
  "cgroupVersion": 2,
  "storageDriver": "overlay2",
  "limits": {
    "memory": { "enforced": true },
    "cpu": { "enforced": true },
    "pids": { "enforced": true },
    "swap": { "enforced": true },
    "storage": { "enforced": false, "reason": "advisory — soft polling only" },
    "networkRate": { "enforced": false, "reason": "requires NET_ADMIN + tc" }
  },
  "operations": {
    "pull": true, "create": true, "start": true, "stop": true,
    "kill": true, "delete": true, "exec": true, "logs": true,
    "events": true, "stats": true, "ports": true, "mounts": true
  }
}
```

The panel must:
1. Query `/capabilities` on mount and after runtime restart.
2. Disable the Storage input when `storage.enforced === false` and show the advisory explanation.
3. Hide the Network Rate input when `networkRate.enforced === false`.
4. Show a warning banner when any limit is advisory.
5. Never accept a requested control the daemon cannot enforce.
