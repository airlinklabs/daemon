import { describe, expect, test } from 'bun:test';
import {
  applyContainerEvent,
  applyContainerList,
  buildHostConfig,
  parseEnvironmentVariables,
  parsePortBindings,
} from '../../src/handlers/docker';
import { isValidStateTransition } from '../../src/handlers/installState';

describe('container state cache transitions', () => {
  test('start and restart mark the container + name as running', () => {
    const m = new Map<string, boolean>();
    applyContainerEvent(m, 'start', 'id-1', 'name-1');
    expect(m.get('id-1')).toBe(true);
    expect(m.get('name-1')).toBe(true);

    // restart flips a previously-stopped container back to running
    const m2 = new Map<string, boolean>([['id-1', false]]);
    applyContainerEvent(m2, 'restart', 'id-1');
    expect(m2.get('id-1')).toBe(true);
  });

  test('die/stop/pause/create mark the container as not running', () => {
    for (const action of ['die', 'stop', 'pause', 'create']) {
      const m = new Map<string, boolean>([['id', true]]);
      applyContainerEvent(m, action, 'id', 'name');
      expect(m.get('id')).toBe(false);
      expect(m.get('name')).toBe(false);
    }
  });

  test('destroy removes the container and name from the cache', () => {
    const m = new Map<string, boolean>([['id', true], ['name', true]]);
    applyContainerEvent(m, 'destroy', 'id', 'name');
    expect(m.has('id')).toBe(false);
    expect(m.has('name')).toBe(false);
  });

  test('unknown actions carry no state signal and are ignored', () => {
    const m = new Map<string, boolean>([['id', true]]);
    applyContainerEvent(m, 'kill', 'id');
    expect(m.get('id')).toBe(true);
  });
});

describe('applyContainerList (docker.listContainers mapping)', () => {
  test('sets running state by full ID and by name', () => {
    const m = new Map<string, boolean>();
    applyContainerList(m, [
      { Id: 'id-running', State: 'running', Names: ['/srv-1'] },
      { Id: 'id-exited', State: 'exited', Names: ['/srv-2'] },
      { Id: 'id-noname', State: 'running', Names: [] },
    ]);
    expect(m.get('id-running')).toBe(true);
    expect(m.get('srv-1')).toBe(true);
    expect(m.get('id-exited')).toBe(false);
    expect(m.get('srv-2')).toBe(false);
    expect(m.get('id-noname')).toBe(true);
  });

  test('a stopped container must never overwrite a post-list runtime signal with running=true', () => {
    const m = new Map<string, boolean>();
    applyContainerEvent(m, 'start', 'id-running', 'srv-1');
    applyContainerList(m, [
      // docker has not re-listed yet; the authoritative list wins only for IDs present
      { Id: 'id-exited', State: 'exited', Names: ['/srv-2'] },
    ]);
    expect(m.get('id-running')).toBe(true);
    expect(m.get('srv-1')).toBe(true);
  });
});

describe('buildHostConfig (resource limits reach HostConfig)', () => {
  const base = {
    volumePath: '/volumes/abc',
    portBindings: { '25565/tcp': [{ HostPort: '25565' }] } as { '25565/tcp': [{ HostPort: string }] },
    Memory: 2048,
    Cpu: 150,
    Storage: 10240,
    Swap: 0,
    mounts: [{ source: '/opt/data', target: '/data', readOnly: true }],
    runtimeName: 'docker',
    networkRateMbps: 0,
  };

  test('converts MB memory to bytes and CPU % to NanoCPUs', () => {
    const hc = buildHostConfig(base) as { Memory: number; NanoCpus: number };
    expect(hc.Memory).toBe(2048 * 1024 * 1024);
    expect(hc.NanoCpus).toBe(1_500_000_000); // 150% of one CPU
    expect(buildHostConfig({ ...base, Cpu: 100 }).NanoCpus).toBe(1_000_000_000); // 100% = one CPU
  });

  test('maps Swap semantics (0 → equal to Memory, -1 → unlimited, >0 → memory+swap)', () => {
    expect(buildHostConfig({ ...base, Swap: 0 }).MemorySwap).toBe(2048 * 1024 * 1024);
    expect(buildHostConfig({ ...base, Swap: -1 }).MemorySwap).toBe(-1);
    expect(buildHostConfig({ ...base, Swap: 512 }).MemorySwap).toBe((2048 + 512) * 1024 * 1024);
  });

  test('mounts are bound and read-only mounts carry :ro', () => {
    const hc = buildHostConfig(base) as { Binds: string[] };
    expect(hc.Binds[0]).toBe('/volumes/abc:/home/container');
    expect(hc.Binds).toContain('/opt/data:/data:ro');
  });

  test('port bindings reach HostConfig', () => {
    const hc = buildHostConfig(base) as { PortBindings: Record<string, [{ HostPort: string }]> };
    expect(hc.PortBindings['25565/tcp'][0].HostPort).toBe('25565');
  });

  test('StorageOpt is set only for the docker runtime, never podman', () => {
    const dockerHc = buildHostConfig(base) as { StorageOpt?: { size: string } };
    expect(dockerHc.StorageOpt?.size).toBe('10240M');
    expect(buildHostConfig({ ...base, runtimeName: 'podman' }).StorageOpt).toBeUndefined();
    expect(buildHostConfig({ ...base, Storage: 0 }).StorageOpt).toBeUndefined();
  });

  test('NET_ADMIN CapAdd granted only when throttling on the docker runtime', () => {
    const hc = buildHostConfig({ ...base, networkRateMbps: 100 }) as { CapAdd?: string[] };
    expect(hc.CapAdd).toContain('NET_ADMIN');
    expect(buildHostConfig({ ...base, networkRateMbps: 0 }).CapAdd).toBeUndefined();
    expect(buildHostConfig({ ...base, networkRateMbps: 100, runtimeName: 'podman' }).CapAdd).toBeUndefined();
  });
});

describe('parsePortBindings', () => {
  test('parses hostPort:containerPort with a default tcp protocol', () => {
    const { portBindings, exposedPorts } = parsePortBindings('25565:25565');
    expect(portBindings['25565/tcp']).toEqual([{ HostPort: '25565' }]);
    expect(exposedPorts['25565/tcp']).toEqual({});
  });

  test('parses udp protocol and multiple bindings', () => {
    const { portBindings } = parsePortBindings('8080:80,6553:19132/udp');
    expect(portBindings['80/tcp'][0].HostPort).toBe('8080');
    expect(portBindings['19132/udp'][0].HostPort).toBe('6553');
  });

  test('drops malformed entries without throwing', () => {
    const { portBindings } = parsePortBindings('25565,no-split-here,nan:25565,25565:abc,::bad');
    expect(Object.keys(portBindings)).toHaveLength(0);
  });

  test('returns empty maps for empty input', () => {
    const { portBindings, exposedPorts } = parsePortBindings('');
    expect(portBindings).toEqual({});
    expect(exposedPorts).toEqual({});
  });
});

describe('parseEnvironmentVariables', () => {
  test('passes environment through unchanged on non-darwin platforms', () => {
    const env = { START: 'java -jar server.jar', X: '1' };
    const out = parseEnvironmentVariables(env);
    expect(out).toEqual(env);
  });

  test('returns a copy, not the original object', () => {
    const env = { A: '1' };
    const out = parseEnvironmentVariables(env);
    expect(out).not.toBe(env);
  });
});

describe('install state transitions (determinism)', () => {
  test('first write from unknown is always allowed', () => {
    for (const s of ['installing', 'reinstalling', 'installed', 'failed']) {
      expect(isValidStateTransition(undefined, s)).toBe(true);
    }
  });

  test('installing finishes as installed or failed', () => {
    expect(isValidStateTransition('installing', 'installed')).toBe(true);
    expect(isValidStateTransition('installing', 'failed')).toBe(true);
    // a container being installed can be superseded by a reinstall
    expect(isValidStateTransition('installing', 'reinstalling')).toBe(true);
  });

  test('reinstalling finishes as installed or failed', () => {
    expect(isValidStateTransition('reinstalling', 'installed')).toBe(true);
    expect(isValidStateTransition('reinstalling', 'failed')).toBe(true);
  });

  test('installed can only be reinstalled, never reverted to installing', () => {
    expect(isValidStateTransition('installed', 'reinstalling')).toBe(true);
    expect(isValidStateTransition('installed', 'installing')).toBe(false);
    expect(isValidStateTransition('installed', 'installed')).toBe(true); // idempotent
  });

  test('failed can return to installing/reinstalling, never jump to installed', () => {
    expect(isValidStateTransition('failed', 'installing')).toBe(true);
    expect(isValidStateTransition('failed', 'reinstalling')).toBe(true);
    expect(isValidStateTransition('failed', 'installed')).toBe(false);
  });

  test('no contradictory installing/failed/running states are legal', () => {
    // a fully installed container must not report 'installing'
    expect(isValidStateTransition('installed', 'installing')).toBe(false);
    // a failed container must not report 'installed'
    expect(isValidStateTransition('failed', 'installed')).toBe(false);
    // a running/installed/succeeded install must not report 'failed'
    expect(isValidStateTransition('installed', 'failed')).toBe(false);
  });
});