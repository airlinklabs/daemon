import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const router = readFileSync(new URL('../../src/router.ts', import.meta.url), 'utf8');
const server = readFileSync(new URL('../../src/server.ts', import.meta.url), 'utf8');

describe('proxy trust contract', () => {
  test('HTTP and WebSocket paths should share one effective-IP resolver', () => {
    expect(router).toContain('resolveEffectiveClientIp');
    expect(server).toContain('resolveEffectiveClientIp');
  });

  test('private peer status alone must not authorize X-Forwarded-For', () => {
    expect(router).not.toMatch(/isPrivateIp\(socketIp\)[\s\S]{0,220}x-forwarded-for/);
  });
});
