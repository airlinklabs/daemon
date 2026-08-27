# Issue #24 implementation guide — consolidate filesystem security APIs

The repository has overlapping security helpers in `src/security/pathJail.ts` and `src/security/secureOpen.ts`, plus route-local path construction and validation.

## Target refactor

Create one authoritative filesystem-security facade with documented operations for open/read/write/create/remove/rmdir/rename/mkdir/enumerate. Keep pure input parsing separate from security-sensitive filesystem operations.

Callers should provide jail-relative logical paths. Avoid APIs that return a pre-resolved absolute path and leave callers responsible for preserving its security properties.

Migrate SFTP, backups, config writes, chunked uploads, and Docker initialization to the same facade. After migration, use type-aware/project-wide analysis to confirm stale exports such as `secureReadFileSync`, `secureWriteFileSync`, `hasOpenat2`, `validatePort`, `requireContainerId`, `backupsPathFor`, `getServerState`, `getAllServerStates`, `flushStatsPersistence`, `clearNonceCache`, and `clearRateLimit` before deletion; preserve intentional public/test compatibility exports.

## Acceptance

There is one obvious secure API for filesystem operations, the guarantees of each primitive are documented, and route code cannot accidentally bypass the central boundary by reconstructing paths.
