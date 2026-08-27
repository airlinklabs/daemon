# Issue #15 implementation guide — filesystem jail race safety

This PR is a reference implementation guide for #15. It deliberately does not claim the current filesystem primitives are TOCTOU-safe.

## Current code to replace

- `src/security/pathJail.ts`: `jailPath`, `jailRename`, `secureUnlink`
- `src/security/secureOpen.ts`: `secureOpenRead`, `secureOpenWrite`

The current pattern is effectively `validate/realpath -> ordinary pathname syscall`. `secureUnlink` is especially clear: secure-open + `fstat` + close + `unlink(path)`. `jailRename` validates both names and then calls ordinary `rename`.

## Target design

1. Treat the jail root as a directory object, not a string prefix.
2. Prefer directory-FD-relative operations.
3. On Linux, use `openat2` with the containment constraints required by the threat model, including `RESOLVE_BENEATH` and `RESOLVE_NO_SYMLINKS` where appropriate.
4. Implement removal and rename without closing the security anchor and then trusting a mutable absolute path.
5. Give non-Linux fallback code explicitly weaker or equivalent semantics; do not document it as stronger than it is.
6. Make secure APIs accept jail-relative paths so callers cannot accidentally bypass the boundary with a pre-resolved absolute path.

## Validation matrix

Test existing files, missing files, existing parents, missing parents, symlinked final components, symlinked intermediate components, traversal input, absolute input, long input, null bytes, hard links, and concurrent replacement.

## Race tests

For every operation that claims confinement, run a worker that repeatedly swaps an ancestor/target with a symlink while the protected operation runs. Create an outside sentinel and assert it is never read, modified, renamed, or deleted.

## Acceptance criteria

No security-sensitive filesystem operation relies on a previous `realpath()` or string-prefix check as its final containment guarantee. Linux and fallback implementations have explicit tests and documented guarantees.
