# Issue #23 implementation guide — unify archive extraction security

Backup restore and generic archive extraction currently follow different security models. `src/handlers/fsArchive.ts` performs explicit member validation and post-extraction containment checks, while `src/routes/backups.ts` uses a separate tar extraction path.

## Target design

Use one archive validation/extraction service for every untrusted archive. Validate normalized member paths before extraction; reject absolute/traversal names; define explicit symlink/hardlink policy; extract only into an isolated staging directory; verify the complete extracted tree remains inside staging; and only then promote into the live volume.

Promotion must use the hardened filesystem operations from #15.

## Fixtures

Include `../` entries, absolute names, symlinks outside staging, nested symlinks, hardlinks, duplicate/conflicting entries, normalization tricks, and file/directory collisions. Rejected archives must leave the live volume unchanged and clean staging state.

## Acceptance

Backup restore and generic extraction share one explicit security policy. No archive entry can escape staging, and untrusted partial extraction never reaches a live volume.
