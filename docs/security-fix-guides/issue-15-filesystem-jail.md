# Issue #15 implementation guide — filesystem jail race safety

Reference guide for fixing #15. This branch intentionally documents the target design instead of pretending a speculative security patch is production-ready.

## Current code to replace

- `src/security/pathJail.ts`: `jailPath`, `jailRename`, `secureUnlink`
- `src/security/secureOpen.ts`: `secureOpenRead`, `secureOpenWrite`

The current pattern is effectively `validate/realpath -> ordinary pathname syscall`. `secureUnlink` is especially clear: secure-open + `fstat` + close + `unlink(path)`. `jailRename` validates both names and then calls ordinary `rename`.

## Target design

1. Treat the jail root as a directory object, not a string prefix.
2. Prefer directory-FD-relative operations.
3. On Linux, use `openat2` with the containment constraints required by the threat model, including `RESOLVE_BENEATH` and `RESOLVE_NO_SYMLINKS` where appropriate.
4. Implement remove/rename without closing the security anchor and then trusting a mutable absolute path.
5. Give non-Linux fallback code explicit guarantees and limitations.
6. Make secure APIs accept jail-relative paths so callers cannot pass a pre-resolved path around the boundary.

## Regression matrix

Test existing/missing files and parents, final/intermediate symlinks, traversal, absolute paths, null bytes, long paths, hard links, and concurrent replacement.

Race tests should repeatedly swap an ancestor or target with a symlink while the protected operation runs and assert an outside sentinel is never read, written, renamed, or deleted.

## Acceptance criteria

No security-sensitive operation relies on `realpath()` or a string-prefix check as the final containment guarantee. Linux and fallback paths have explicit tests and documented guarantees.
