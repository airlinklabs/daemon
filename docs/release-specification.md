# Release Specification — airlinkd

> Version: 1.0 | Status: Active | Phase 10

## Supported OS/Arch Matrix

| Platform | Arch   | Target              | Status    |
|----------|--------|---------------------|-----------|
| Linux    | x64    | bun-linux-x64       | Supported |
| Linux    | arm64  | bun-linux-arm64     | Supported |
| Windows  | x64    | bun-windows-x64     | Supported |
| Windows  | arm64  | bun-windows-arm64   | Supported |
| macOS    | x64    | bun-darwin-x64      | Supported |
| macOS    | arm64  | bun-darwin-arm64    | Supported |

**Container runtime support (Docker/Podman): Linux only.** Windows and macOS binaries do
not include container runtime support. This is documented, not implied by binary existence.

## Bun Version

Pinned via `packageManager` field in `package.json`. Current: `bun@1.3.12`.
The build must fail if the running Bun version does not match `package.json`.

## Node/Native Dependency Policy

- **ssh2**: SSH transport is unused (daemon connects via local Docker socket only).
  The native crypto binding (`sshcrypto.node`) is stubbed at build time; ssh2 falls
  back to JS crypto. No `.node` files are shipped.
- **cpu-features**: Required by ssh2 but never called. Stubbed to return empty.
- **@opentui/core**: Uses per-platform renderer packages. Cross-target builds fetch
  these via lockfile-pinned dependencies into an isolated staging workspace — never
  into the developer's `node_modules/`.

## Embedded Default-Data Contract

Files shipped inside the binary are the git-tracked `storage/` directory contents
minus runtime state. The allowlist is maintained in `build.ts`:

**Included:**
- `storage/config.json` (default configuration template)
- `storage/fileSpecifier.json` (file extension categories)

**Excluded (runtime state, never bundled):**
- `sftp_host_ed25519` — generated on first start
- `alc/` — runtime ALC state
- `containerConfigs/` — runtime container configs
- `install_logs.json` — runtime install logs
- `systemStats.json` — runtime stats

The embedded manifest records each file's relative path, content SHA-256, and byte
size. On first run, the binary extracts these files to disk if missing. On subsequent
starts, missing individual files are re-extracted.

## Runtime External Files

The binary expects these paths at runtime (relative to `DAEMON_DATA_ROOT`):
- `.env` — created from embedded template on first run
- `storage/` — embedded defaults extracted on first run
- `logs/` — created on first run
- `volumes/` — created on first run
- `backups/` — created on first run
- `.airlinkd/logs/` — created on first run

## Artifact Naming

```
airlinkd-{platform}-{arch}[.exe]
```

Examples: `airlinkd-linux-x64`, `airlinkd-windows-x64.exe`, `airlinkd-macos-arm64`

The native-target artifact is also copied as `airlinkd` (no suffix) for convenience.

## Stable Channel

All releases are stable. No alpha/beta/rc channels. Version follows `package.json`
semver.

## Minimum OS/libc

- Linux: glibc 2.31+ (Debian 11 / Ubuntu 20.04+)
- Windows: Windows 10 x64+
- macOS: macOS 12+ (Monterey)

## Signing/Provenance

Currently unsigned. Signing will be added when CI credentials are available.
Checksums are SHA-256, generated as detached `.sha256` files alongside each artifact.

## Checksums

Each artifact gets a detached `{artifact}.sha256` file containing the hex-encoded
SHA-256 hash. The manifest also records the hash. The build fails if checksums
don't match.

## SBOM/License

SBOM not yet generated. License: see `LICENSE` in repository root. The manifest
includes a `license` field pointing to the repository license file.

## Rollback/Compatibility Rules

- Previous binary releases remain available on GitHub Releases.
- The binary is self-contained; no external runtime dependencies.
- Config format changes are backward-compatible (new fields added with defaults).
- Embedded storage extraction is idempotent — existing files are never overwritten.

## Build Commands

| Command                  | Purpose                                                  |
|--------------------------|----------------------------------------------------------|
| `generate-embedded`      | Generate `src/embedded.ts` from git-tracked storage/     |
| `generate-embedded --check` | Verify `src/embedded.ts` is up-to-date (CI)          |
| `verify`                 | Verify binary: version, --help, first-run, config        |
| `package --target T`     | Build binary for target T                                 |
| `smoke`                  | Run smoke tests on built binaries                         |
| `release-manifest`       | Generate `dist/manifest.json` + checksums                 |

## CI Flow

1. `bun install` (clean install from lockfile)
2. `generate-embedded --check` (fail if stale)
3. `typecheck` (fail if errors)
4. `package --target` for each target (fail on any target failure)
5. `verify` on native binary
6. `smoke` on native binary
7. `release-manifest` (generate checksums + manifest)
8. Upload artifacts to GitHub Release

## Determinism

The build is deterministic when:
- Same Bun version
- Same git commit (embedded files derived from git ls-files)
- Same `storage/` contents

The embedded asset manifest records the generator version and Bun version for
reproducibility tracking. Any intentional nondeterminism is documented in the
manifest.
