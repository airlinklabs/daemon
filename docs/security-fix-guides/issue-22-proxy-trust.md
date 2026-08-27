# Issue #22 implementation guide — unify proxy trust and client IP resolution

`src/server.ts` and `src/router.ts` independently derive the effective client IP. Both have a legacy mode where a private peer can justify trusting `X-Forwarded-For` when explicit trusted proxies are not configured.

## Target design

Create one resolver taking `(peerIp, forwardedChain, trustedProxyPolicy)` and use it for HTTP and WebSocket. Trust forwarding headers only when the immediate peer is explicitly trusted; parse multi-hop chains from the trusted edge inward; reject malformed values; define duplicate-header behavior; and fail closed/disable forwarding trust when proxy configuration is incomplete.

All rate limiting, allowlists, logging, and WebSocket policy should use the same resolved identity.

## Tests

Cover trusted/untrusted public and private peers, one/multiple hops, duplicate/malformed headers, missing headers, `BEHIND_PROXY` with no trusted list, IPv4/IPv6, and identical HTTP/WebSocket metadata.

## Acceptance

There is one documented implementation and an untrusted peer cannot spoof the identity consumed by security controls.
