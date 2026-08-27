# Issue #16 implementation guide — migrate native SFTP to the hardened filesystem boundary

Reference implementation guide for #16.

## Code surface

`src/handlers/sftpSubsystem.ts` handles OPEN/READ/WRITE/FSTAT/REMOVE/RMDIR/MKDIR/READDIR/RENAME. It currently validates a path with its local `rooted()` logic and then performs ordinary pathname operations.

## Target architecture

Make SFTP consume the authoritative descriptor-relative filesystem layer from #15. A single connection/session should hold a trusted root directory descriptor; SFTP paths should remain relative to that root.

For OPEN:
- resolve the requested path relative to the root FD;
- apply the requested access flags only after containment checks;
- return a handle containing the opened FD and metadata needed for SFTP;
- use `fstat`/descriptor operations instead of re-resolving the pathname.

For REMOVE/RMDIR/MKDIR/RENAME/READDIR:
- operate relative to trusted directory handles;
- enforce both source and destination confinement for rename;
- do not perform `check(path)` and then ordinary pathname syscalls.

## Symlink policy

Decide explicitly whether SFTP follows symlinks. The safest policy for a jailed management filesystem is to reject symlink traversal unless a concrete feature requires it. If symlinks are allowed, document exactly which operations may follow them and test them as a separate policy.

## Tests

Add protocol-level tests for symlinked ancestors, ancestor replacement during OPEN/WRITE/REMOVE/RENAME, FSTAT after path replacement, READDIR entries containing symlinks, source/destination races, and outside-root sentinel protection.

Run race tests repeatedly. Verify the same behavior on supported Linux/openat2 and fallback platforms.

## Acceptance criteria

SFTP has no independent weaker path-security model. Every filesystem operation uses the same documented jail invariant as HTTP filesystem access, and open handles remain authoritative after the initial lookup.
