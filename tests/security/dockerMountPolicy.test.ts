import { describe, expect, test } from 'bun:test';
import { validateMounts } from '../../src/handlers/dockerConfig';

describe('Docker host mount policy', () => {
  const storageRoot = '/var/lib/airlinkd';

  test('rejects Docker control socket mounts', () => {
    expect(() => validateMounts([{ source: '/var/run/docker.sock', target: '/host.sock' }], storageRoot)).toThrow();
  });

  test('rejects sensitive host paths outside the current denylist', () => {
    expect(() => validateMounts([{ source: '/etc', target: '/host-etc' }], storageRoot)).toThrow();
    expect(() => validateMounts([{ source: '/home', target: '/host-home' }], storageRoot)).toThrow();
  });

  test('does not mistake prefix lookalikes for forbidden path components', () => {
    expect(() => validateMounts([{ source: '/procfoo', target: '/data' }], storageRoot)).not.toThrow();
  });
});
