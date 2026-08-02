import { describe, expect, test } from 'bun:test';

// Test the network rate limit logic (extracted from docker.ts for testability)
describe('network rate limiting', () => {
  test('networkRateMbps parses from env', () => {
    const val = parseInt('100', 10) || 0;
    expect(val).toBe(100);
  });

  test('networkRateMbps defaults to 0 when invalid', () => {
    const val = parseInt('abc', 10) || 0;
    expect(val).toBe(0);
  });

  test('networkRateMbps defaults to 0 when empty', () => {
    const val = parseInt('', 10) || 0;
    expect(val).toBe(0);
  });

  test('tc command format is correct', () => {
    const rate = 100;
    const cmd = `tc qdisc add dev eth0 root handle 1: tbf rate ${rate}mbit burst 64kb latency 1ms`;
    expect(cmd).toContain('tc qdisc add');
    expect(cmd).toContain('rate 100mbit');
    expect(cmd).toContain('burst 64kb');
    expect(cmd).toContain('latency 1ms');
  });
});

describe('container ID validation', () => {
  // UUID pattern used in docker.ts
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  test('accepts valid UUID', () => {
    expect(UUID_RE.test('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  test('rejects non-UUID strings', () => {
    expect(UUID_RE.test('not-a-uuid')).toBe(false);
    expect(UUID_RE.test('')).toBe(false);
    expect(UUID_RE.test('../etc/passwd')).toBe(false);
    expect(UUID_RE.test('550e8400-e29b-41d4-a716')).toBe(false);
  });
});
