# Issue #25 implementation guide — harden Docker volume initialization

`src/handlers/docker.ts` constructs volume paths and writes initialization/configuration files using ordinary filesystem APIs. The volume directory is not consistently anchored to a trusted directory object.

## Target design

- Resolve the volume root through the authoritative filesystem security API from #15/#24.
- Treat the configured volumes root as an anchored directory, not a string prefix.
- Validate container/volume identifiers at the API boundary but do not use identifier validation as the filesystem security boundary.
- Securely create/write `eula.txt`, `.airlinkd/init.sh`, and other initialization files relative to the trusted volume directory.
- Define behavior for an existing path that is a symlink, regular file, unexpected directory, or replacement during initialization.
- Ensure error cleanup cannot cross the volume root.

## Tests

Cover new/existing volumes, symlinked volume directories, replaced ancestors, file-vs-directory mismatches, concurrent replacement while initialization files are created, and cleanup after partial initialization. Use an outside sentinel to prove confinement.

## Acceptance

Volume initialization cannot write outside the configured volume root, even under concurrent filesystem manipulation, and uses the same secure primitives as other daemon-managed storage.
