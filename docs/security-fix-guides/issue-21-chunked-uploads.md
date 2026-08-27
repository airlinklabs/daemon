# Issue #21 implementation guide — race-safe chunk upload finalization

`src/handlers/fsArchive.ts` validates a destination, writes a temporary pathname, then promotes it with ordinary `rename`. Atomic rename does not by itself preserve jail confinement.

## Target behavior

- Create the temporary file inside the destination directory using a secure temp-file primitive.
- Keep the destination directory anchored by the filesystem jail from #15.
- Perform promotion through the race-safe rename API.
- Define overwrite semantics explicitly.
- Ensure interrupted uploads cannot leave attacker-controlled temporary paths that later get reused.
- Prefer CSPRNG/dedicated temporary names over `Math.random()`.

## Tests

Race ancestor/destination replacement during finalization, symlink both target and parent, concurrent uploads to the same filename, existing-target replacement, and interrupted cleanup. Verify an outside sentinel remains unchanged.

## Acceptance

Chunk finalization has the same confinement guarantee as direct writes and cannot be redirected outside the volume between validation, temporary-file creation, and promotion.
