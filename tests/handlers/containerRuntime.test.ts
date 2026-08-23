import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { MockContainerRuntime, MockPodmanRuntime } from '../helpers/mockRuntime';
import { rootlessPodmanSocket, detectCgroupVersion } from '../../src/handlers/containerRuntime';
import type { RuntimeCapabilities } from '../../src/handlers/containerRuntime';

// ── Mock Runtime Capabilities ────────────────────────────────────────────────

describe('MockContainerRuntime capabilities', () => {
  let runtime: MockContainerRuntime;

  beforeEach(() => {
    runtime = new MockContainerRuntime();
  });

  test('reports as docker by default', () => {
    const caps = runtime.capabilities();
    expect(caps.runtime).toBe('docker');
  });

  test('all operations are enabled', () => {
    const ops = runtime.capabilities().operations;
    for (const [key, val] of Object.entries(ops)) {
      expect(val).toBe(true);
    }
  });

  test('memory/cpu/pids/swap are enforced', () => {
    const limits = runtime.capabilities().limits;
    expect(limits.memory.enforced).toBe(true);
    expect(limits.memory.enforcement).toBe('enforced');
    expect(limits.cpu.enforced).toBe(true);
    expect(limits.cpu.enforcement).toBe('enforced');
    expect(limits.pids.enforced).toBe(true);
    expect(limits.pids.enforcement).toBe('enforced');
    expect(limits.swap.enforced).toBe(true);
    expect(limits.swap.enforcement).toBe('enforced');
  });

  test('storage and networkRate are advisory', () => {
    const limits = runtime.capabilities().limits;
    expect(limits.storage.enforced).toBe(false);
    expect(limits.storage.enforcement).toBe('advisory');
    expect(limits.networkRate.enforced).toBe(false);
    expect(limits.networkRate.enforcement).toBe('advisory');
  });

  test('blkioWeight and oomKillDisable are enforced', () => {
    const limits = runtime.capabilities().limits;
    expect(limits.blkioWeight.enforced).toBe(true);
    expect(limits.blkioWeight.enforcement).toBe('enforced');
    expect(limits.oomKillDisable.enforced).toBe(true);
    expect(limits.oomKillDisable.enforcement).toBe('enforced');
  });
});

// ── Podman-specific capability differences ──────────────────────────────────
// These test the documented Podman behavioral differences without a live runtime.

describe('Podman capability report', () => {
  function podmanCaps(rootless: boolean): RuntimeCapabilities {
    return {
      version: 1,
      runtime: 'podman',
      apiVersion: '4.9.0',
      rootless,
      socketValid: true,
      socketPath: rootless
        ? `/run/user/1000/podman/podman.sock`
        : '/run/podman/podman.sock',
      cgroupVersion: 2,
      storageDriver: 'overlay',
      limits: {
        memory: { enforced: true, enforcement: 'enforced' },
        cpu: { enforced: true, enforcement: 'enforced' },
        pids: { enforced: true, enforcement: 'enforced' },
        swap: { enforced: true, enforcement: 'enforced' },
        storage: {
          enforced: false,
          enforcement: 'advisory',
          reason: 'Podman does not support Docker StorageOpt; fallback is soft directory-size polling',
        },
        networkRate: {
          enforced: false,
          enforcement: rootless ? 'unsupported' : 'advisory',
          reason: rootless
            ? 'not supported in Podman rootless mode'
            : 'requires NET_ADMIN capability + tc binary in image',
        },
        blkioWeight: {
          enforced: !rootless,
          enforcement: rootless ? 'unsupported' : 'enforced',
          reason: rootless ? 'not supported in Podman rootless mode' : undefined,
        },
        oomKillDisable: {
          enforced: true,
          enforcement: 'enforced',
          reason: 'Podman uses --oom-score-adj instead of --oom-kill-disable',
        },
      },
      operations: {
        pull: true,
        create: true,
        start: true,
        stop: true,
        kill: true,
        delete: true,
        exec: true,
        logs: true,
        events: true,
        stats: true,
        ports: true,
        mounts: true,
      },
    };
  }

  test('Podman uses overlay (not overlay2)', () => {
    expect(podmanCaps(false).storageDriver).toBe('overlay');
  });

  test('Podman storage limit is always advisory (no StorageOpt)', () => {
    const caps = podmanCaps(false);
    expect(caps.limits.storage.enforced).toBe(false);
    expect(caps.limits.storage.enforcement).toBe('advisory');
    expect(caps.limits.storage.reason).toContain('StorageOpt');
  });

  test('Podman rootless: networkRate is unsupported', () => {
    const caps = podmanCaps(true);
    expect(caps.limits.networkRate.enforced).toBe(false);
    expect(caps.limits.networkRate.enforcement).toBe('unsupported');
    expect(caps.limits.networkRate.reason).toContain('rootless');
  });

  test('Podman rootless: blkioWeight is unsupported', () => {
    const caps = podmanCaps(true);
    expect(caps.limits.blkioWeight.enforced).toBe(false);
    expect(caps.limits.blkioWeight.enforcement).toBe('unsupported');
    expect(caps.limits.blkioWeight.reason).toContain('rootless');
  });

  test('Podman rootful: networkRate is advisory', () => {
    const caps = podmanCaps(false);
    expect(caps.limits.networkRate.enforcement).toBe('advisory');
    expect(caps.limits.networkRate.reason).toContain('NET_ADMIN');
  });

  test('Podman rootful: blkioWeight is enforced', () => {
    const caps = podmanCaps(false);
    expect(caps.limits.blkioWeight.enforced).toBe(true);
    expect(caps.limits.blkioWeight.enforcement).toBe('enforced');
  });

  test('Podman oomKillDisable has reason about --oom-score-adj', () => {
    const caps = podmanCaps(false);
    expect(caps.limits.oomKillDisable.enforced).toBe(true);
    expect(caps.limits.oomKillDisable.reason).toContain('oom-score-adj');
  });

  test('Podman cgroup version defaults to 2', () => {
    expect(podmanCaps(false).cgroupVersion).toBe(2);
  });
});

// ── rootlessPodmanSocket ─────────────────────────────────────────────────────

describe('rootlessPodmanSocket', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('uses XDG_RUNTIME_DIR when set', () => {
    process.env.XDG_RUNTIME_DIR = '/run/user/1001';
    expect(rootlessPodmanSocket()).toBe('/run/user/1001/podman/podman.sock');
  });

  test('falls back to /run/user/<uid> when XDG_RUNTIME_DIR is unset', () => {
    delete process.env.XDG_RUNTIME_DIR;
    const result = rootlessPodmanSocket();
    // Should contain the pattern /run/user/<something>/podman/podman.sock
    expect(result).toMatch(/^\/run\/user\/\d+\/podman\/podman\.sock$/);
  });

  test('XDG_RUNTIME_DIR takes precedence over uid fallback', () => {
    process.env.XDG_RUNTIME_DIR = '/custom/runtime';
    expect(rootlessPodmanSocket()).toBe('/custom/runtime/podman/podman.sock');
  });
});

// ── detectCgroupVersion ──────────────────────────────────────────────────────

describe('detectCgroupVersion', () => {
  test('returns a number (1 or 2)', () => {
    const v = detectCgroupVersion();
    expect(v === 1 || v === 2).toBe(true);
  });
});

// ── MockPodmanRuntime ────────────────────────────────────────────────────────

describe('MockPodmanRuntime', () => {
  test('reports as podman', () => {
    const runtime = new MockPodmanRuntime();
    expect(runtime.name).toBe('podman');
    expect(runtime.capabilities().runtime).toBe('podman');
  });

  test('rootful: blkioWeight enforced, networkRate advisory', () => {
    const caps = new MockPodmanRuntime(false).capabilities();
    expect(caps.limits.blkioWeight.enforced).toBe(true);
    expect(caps.limits.blkioWeight.enforcement).toBe('enforced');
    expect(caps.limits.networkRate.enforcement).toBe('advisory');
  });

  test('rootless: blkioWeight and networkRate unsupported', () => {
    const caps = new MockPodmanRuntime(true).capabilities();
    expect(caps.limits.blkioWeight.enforced).toBe(false);
    expect(caps.limits.blkioWeight.enforcement).toBe('unsupported');
    expect(caps.limits.networkRate.enforcement).toBe('unsupported');
  });

  test('storage is always advisory', () => {
    const caps = new MockPodmanRuntime(false).capabilities();
    expect(caps.limits.storage.enforced).toBe(false);
    expect(caps.limits.storage.enforcement).toBe('advisory');
  });

  test('createContainer strips StorageOpt', async () => {
    const runtime = new MockPodmanRuntime();
    await runtime.createContainer({
      Image: 'test',
      HostConfig: { StorageOpt: { size: '10G' } },
    });
    expect(runtime.lastCreateOpts.HostConfig?.StorageOpt).toBeUndefined();
  });

  test('rootless createContainer strips NET_ADMIN', async () => {
    const runtime = new MockPodmanRuntime(true);
    await runtime.createContainer({
      Image: 'test',
      HostConfig: { CapAdd: ['NET_ADMIN', 'SYS_ADMIN'] },
    });
    expect(runtime.lastCreateOpts.HostConfig.CapAdd).toEqual(['SYS_ADMIN']);
  });

  test('rootful createContainer keeps NET_ADMIN', async () => {
    const runtime = new MockPodmanRuntime(false);
    await runtime.createContainer({
      Image: 'test',
      HostConfig: { CapAdd: ['NET_ADMIN', 'SYS_ADMIN'] },
    });
    expect(runtime.lastCreateOpts.HostConfig.CapAdd).toEqual(['NET_ADMIN', 'SYS_ADMIN']);
  });

  test('socket path differs by rootless mode', () => {
    expect(new MockPodmanRuntime(false).socketPath).toBe('/run/podman/podman.sock');
    expect(new MockPodmanRuntime(true).socketPath).toBe('/run/user/1000/podman/podman.sock');
  });

  test('storage driver is overlay', () => {
    expect(new MockPodmanRuntime().capabilities().storageDriver).toBe('overlay');
  });
});
