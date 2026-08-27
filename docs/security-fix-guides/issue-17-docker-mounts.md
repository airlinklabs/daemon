# Issue #17 implementation guide — restrict Docker host bind mounts

Reference guide for #17. The goal is to turn host mounts into an explicit privileged capability rather than relying on a small lexical denylist.

## Code surface

- `src/handlers/dockerConfig.ts` validates mount configuration.
- `src/schemas/container.ts` defines the incoming mount shape.
- `src/handlers/docker.ts` maps the accepted source into Docker `HostConfig.Binds`.

## Security model to establish

Use an allowlist of daemon-owned host roots that may be exposed. Do not attempt to enumerate every forbidden host path.

For every source path:

1. Parse as a host filesystem path.
2. Reject null bytes, malformed paths, and path aliases that leave the allowed root.
3. Canonicalize existing ancestors before policy evaluation.
4. Use path-component comparisons, not raw `startsWith` checks.
5. Define a safe policy for nonexistent paths; avoid a validation/creation race where possible.
6. Reject Unix sockets and host control-plane files unless a feature explicitly requires them.

## Cases that must be decided and tested

- `/etc`, `/home`, `/var/lib`, `/proc`, `/sys`, `/dev`;
- `/run`, `/var/run`, and the Docker Unix socket;
- symlink aliases into an allowed or forbidden tree;
- relative paths and traversal attempts;
- prefix-lookalikes such as `/procfoo`;
- mount sources that disappear or are replaced after validation.

## Defense in depth

The API/UI should identify host mounts as privileged. Validation should be backed by the daemon's filesystem jail where appropriate, and Docker configuration should be inspected before container creation.

## Acceptance criteria

An untrusted container configuration cannot cause an arbitrary host path to be mounted. The policy is explicit, canonicalization-aware, documented, and covered by regression tests.
