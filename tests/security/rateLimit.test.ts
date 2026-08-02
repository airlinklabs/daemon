import { describe, expect, test } from 'bun:test';
import { checkRateLimit } from '../../src/security/rateLimit';

describe('Rate limiting', () => {
  test('allows requests under the limit', () => {
    const ip = '192.168.1.100';
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit(ip, 10)).toBeNull();
    }
  });

  test('blocks requests over the limit', () => {
    const ip = '192.168.1.101';
    for (let i = 0; i < 10; i++) {
      checkRateLimit(ip, 10);
    }
    const result = checkRateLimit(ip, 10);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(429);
  });

  test('returns Retry-After header', () => {
    const ip = '192.168.1.102';
    for (let i = 0; i < 11; i++) checkRateLimit(ip, 10);
    const result = checkRateLimit(ip, 10);
    expect(result!.headers.get('Retry-After')).not.toBeNull();
  });

  test('different IPs have separate limits', () => {
    const ip1 = '192.168.1.103';
    const ip2 = '192.168.1.104';
    for (let i = 0; i < 5; i++) checkRateLimit(ip1, 5);
    expect(checkRateLimit(ip1, 5)).not.toBeNull(); // ip1 blocked
    expect(checkRateLimit(ip2, 5)).toBeNull(); // ip2 still allowed
  });

  test('different limits work', () => {
    const ip = '192.168.1.105';
    for (let i = 0; i < 3; i++) checkRateLimit(ip, 2);
    expect(checkRateLimit(ip, 2)).not.toBeNull(); // limit 2, already exceeded
  });

  test('returns JSON error body', async () => {
    const ip = '192.168.1.106';
    for (let i = 0; i < 11; i++) checkRateLimit(ip, 10);
    const result = checkRateLimit(ip, 10);
    const body = await result!.json();
    expect(body.error).toBe('rate limit exceeded');
  });
});
