# Issue #18 implementation guide — close the DNS rebinding window

Reference guide for #18.

## Current flow

`src/router.ts` resolves a hostname and validates returned addresses before `src/handlers/fs.ts` later passes the original hostname to `fetch()`.

That means the validated DNS result and the socket connection are separate events. Redirects are validated, but each hop can have the same problem.

## Target design

Bind SSRF policy to the actual connection:

- use a custom resolver/agent that refuses disallowed destination addresses for every socket attempt; or
- connect directly to the validated address while preserving Host/SNI/TLS semantics correctly; or
- otherwise guarantee the resolver result cannot change between validation and connection.

Keep redirects subject to the same policy. Do not weaken TLS certificate validation just to force an IP connection.

## Edge cases

Test IPv4, IPv6, IPv4-mapped IPv6, loopback, private/link-local ranges, unusual numeric IP forms, multiple DNS answers, connection retries, and redirect chains where DNS changes between hops. Audit whether HTTP proxy/environment settings can redirect the actual connection away from the validated destination.

## Regression test

A fake resolver should return a public IP during validation and a private IP for the subsequent connection. The request must fail before any connection to the private target occurs.

## Acceptance criteria

Every actual connection attempt is covered by the SSRF address policy. Passing hostname validation alone can never authorize a connection to a newly resolved disallowed address.
