# Issue #20 implementation guide — bind file authorization to the secure object

Reference guide for #20.

## Download tokens

`src/routes/filesystem.ts` stores an absolute `filePath` inside the token. Consumption later checks the path and calls `Bun.file(path)`. Backup downloads have similar semantics.

The token can therefore be cryptographically valid while the filesystem object behind its pathname has changed.

### Target design

At token consumption:
- resolve the logical path relative to the intended jail;
- securely open the file under the jail;
- verify type/size against policy using the open descriptor;
- stream/read from that descriptor or an equivalent stable file object;
- preserve token expiry and single-use behavior.

Do not use a prior `existsSync()` or `realpath()` result as the final authorization check.

## Config-file writes

`src/handlers/configFiles.ts` performs `resolve`/prefix checks and then uses ordinary read/write calls. Migrate both read and write to the shared secure filesystem API.

Define explicit behavior for symlinks, replacement of existing files, file-vs-directory confusion, and concurrent changes.

## Tests

Mint a token, replace the target/ancestor, then consume it. Replace config targets with symlinks and race the write with directory replacement. Verify outside sentinels never change.

## Acceptance criteria

Authorization is bound to the intended jailed object at the moment of use. No download or config write relies on a previously validated mutable pathname as its final security boundary.
