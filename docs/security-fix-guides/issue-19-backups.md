# Issue #19 implementation guide — centralize backup storage security

Reference guide for #19.

## Problem

`src/routes/backups.ts` does not use one backup filesystem abstraction for all operations. Create/upload construct paths directly from `backupsRoot`, while restore/download/delete use centralized helpers.

This split means a future fix can harden one route while leaving another on a weaker path model.

## Target design

Introduce a backup storage service responsible for root discovery, container directory resolution, filename validation, temporary uploads, atomic promotion, reads, and deletion. Route handlers should deal only in logical IDs/names and never make security decisions with `join(backupsRoot, ...)` themselves.

Final operations should use the race-safe primitives from #15. Uploads should land in controlled temporary files and be promoted only after validation/complete write.

## Concurrency

Define behavior for two uploads to the same backup, upload vs delete, restore vs upload, and cleanup after interrupted uploads. Do not allow a stale pathname to be reused after another actor changes the directory.

## Tests

Cover symlinked `backups/<id>`, concurrent replacement during create/upload, traversal-like IDs and names, existing destination replacement, partial upload cleanup, and concurrent operations. Use an outside sentinel to prove containment.

## Acceptance criteria

Create, upload, restore, download, and delete share the same backup security boundary and no route directly reconstructs security-sensitive backup paths.
