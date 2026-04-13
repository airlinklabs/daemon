// This code was written by thavanish(https://github.com/thavanish) for airlinklabs
// dockerode — no bun-native docker socket client exists, this is the best option

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Docker from 'dockerode';
import logger from '../logger';
import { emit } from '../ws/events';

export const docker = new Docker({
  socketPath: process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock',
});

// check docker is installed
export async function checkDocker(): Promise<void> {
  const proc = Bun.spawn(['docker', '--version'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  if (code !== 0) {
    logger.error('docker is not installed or not in PATH, bailing');
    process.exit(1);
  }
}

// check docker daemon is running
export async function checkDockerRunning(): Promise<void> {
  const proc = Bun.spawn(['docker', 'ps', '-q'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  if (code !== 0) {
    logger.error('docker is not running, start it and try again');
    process.exit(1);
  }
}

// in-memory map: containerId → whether it's running
// keyed by both full docker ID and by container name (which is the panel's UUID)
const stateMap = new Map<string, boolean>();

export async function initContainerStateMap(): Promise<void> {
  try {
    const containers = await docker.listContainers({ all: true });
    for (const c of containers) {
      stateMap.set(c.Id, c.State === 'running');
      const name = (c.Names?.[0] || '').replace(/^\//, '');
      if (name) stateMap.set(name, c.State === 'running');
    }
    logger.info(`seeded state map with ${containers.length} containers`);
  } catch (err) {
    logger.error('failed to seed container state map', err);
  }

  // subscribe to docker events — keeps map current without polling
  // holy fuck dockerode's event API is weird but this is the right way
  await subscribeToDockerEvents();
}

async function subscribeToDockerEvents(): Promise<void> {
  try {
    const stream = await docker.getEvents({
      filters: JSON.stringify({ type: ['container'] }),
    });

    stream.on('data', (chunk: Buffer) => {
      try {
        const event = JSON.parse(chunk.toString()) as {
          Action: string;
          id: string;
          Actor?: { Attributes?: { name?: string } };
        };
        const id = event.id;
        const name = event.Actor?.Attributes?.name ?? '';

        if (event.Action === 'start') {
          stateMap.set(id, true);
          if (name) stateMap.set(name, true);
        } else if (event.Action === 'die' || event.Action === 'stop') {
          stateMap.set(id, false);
          if (name) stateMap.set(name, false);
        } else if (event.Action === 'destroy') {
          stateMap.delete(id);
          if (name) stateMap.delete(name);
        }
      } catch {
        /* malformed event chunk, skip */
      }
    });

    stream.on('error', (err: Error) => {
      logger.error('docker event stream error — reconnecting in 5s', err);
      setTimeout(subscribeToDockerEvents, 5000);
    });

    stream.on('end', () => {
      logger.warn('docker event stream ended — reconnecting in 2s');
      setTimeout(subscribeToDockerEvents, 2000);
    });

    logger.info('docker event stream subscribed');
  } catch (err) {
    logger.error('failed to subscribe to docker events — retrying in 5s', err);
    setTimeout(subscribeToDockerEvents, 5000);
  }
}

// null means unknown — caller can fall back to inspect()
export function isContainerRunning(id: string): boolean | null {
  if (!stateMap.has(id)) return null;
  return stateMap.get(id)!;
}

export function setContainerRunning(id: string, running: boolean): void {
  stateMap.set(id, running);
}

// return shape — DO NOT CHANGE THIS
// the panel parses these exact field names in its server card components
export type ContainerStats = {
  running: boolean;
  exists: boolean;
  memory: { usage: number; limit: number; percentage: number };
  cpu: { percentage: number };
};

export async function getContainerStats(id: string): Promise<ContainerStats | null> {
  try {
    const container = docker.getContainer(id);
    const stats = await container.stats({ stream: false });

    const memUsage = (stats.memory_stats.usage as number) ?? 0;
    const memLimit = (stats.memory_stats.limit as number) ?? 1;
    const memCache = (stats.memory_stats.stats as { cache?: number })?.cache ?? 0;
    const memActual = memUsage - memCache;

    // same formula docker CLI uses
    const cpuDelta =
      (stats.cpu_stats.cpu_usage.total_usage as number) - (stats.precpu_stats.cpu_usage.total_usage as number);
    const sysDelta =
      (stats.cpu_stats.system_cpu_usage as number) - ((stats.precpu_stats.system_cpu_usage as number) ?? 0);
    const numCpus =
      (stats.cpu_stats.online_cpus as number) ??
      (stats.cpu_stats.cpu_usage.percpu_usage as number[] | undefined)?.length ??
      1;
    const cpuPercent = sysDelta > 0 ? (cpuDelta / sysDelta) * numCpus * 100 : 0;

    return {
      running: true,
      exists: true,
      memory: {
        usage: memActual,
        limit: memLimit,
        percentage: (memActual / memLimit) * 100,
      },
      cpu: { percentage: Math.min(100, cpuPercent) },
    };
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('no such container')) return null;
    return {
      running: false,
      exists: true,
      memory: { usage: 0, limit: 0, percentage: 0 },
      cpu: { percentage: 0 },
    };
  }
}

// inspect-only state check — never times out waiting for stats collection
export async function getContainerState(id: string): Promise<{ running: boolean; startedAt: string | null }> {
  try {
    const container = docker.getContainer(id);
    const info = await container.inspect().catch(() => null);
    if (!info) return { running: false, startedAt: null };
    return {
      running: info.State.Running === true,
      startedAt: info.State.StartedAt || null,
    };
  } catch {
    return { running: false, startedAt: null };
  }
}

// parse "hostPort:containerPort,hostPort:containerPort/udp" into dockerode PortBindings + ExposedPorts
export function parsePortBindings(ports: string): {
  portBindings: Record<string, [{ HostPort: string }]>;
  exposedPorts: Record<string, object>;
} {
  const portBindings: Record<string, [{ HostPort: string }]> = {};
  const exposedPorts: Record<string, object> = {};
  if (!ports?.trim()) return { portBindings, exposedPorts };

  for (const entry of ports.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const [hostPort, rest] = trimmed.split(':');
    if (!rest) continue;

    // format: containerPort or containerPort/proto
    const [containerPort, proto = 'tcp'] = rest.split('/');
    if (!hostPort || !containerPort || Number.isNaN(Number(hostPort)) || Number.isNaN(Number(containerPort))) {
      logger.warn(`invalid port mapping: ${trimmed}`);
      continue;
    }

    const key = `${containerPort}/${proto}`;
    portBindings[key] = [{ HostPort: hostPort }];
    exposedPorts[key] = {};
  }

  return { portBindings, exposedPorts };
}

export function parseEnvironmentVariables(env: Record<string, string>): Record<string, string> {
  const newEnv = { ...env };
  // macOS silicon needs this flag for java — on linux it's a no-op so it's harmless
  if (process.platform === 'darwin' && newEnv.START) {
    newEnv.START = newEnv.START.replace(/^(java\s+)/, '$1-XX:UseSVE=0 ');
  }
  return newEnv;
}

// creates the volume dir for a container if it doesn't exist, returns the path
export function initContainer(id: string): string {
  const volumesDir = resolve(process.cwd(), 'volumes');
  const volumePath = join(volumesDir, id);
  if (!existsSync(volumesDir)) mkdirSync(volumesDir, { recursive: true });
  if (!existsSync(volumePath)) mkdirSync(volumePath, { recursive: true });
  return volumePath;
}

// pull an image and stream progress over the events WS
export async function pullImageWithProgress(image: string, containerId: string): Promise<void> {
  emit(containerId, { type: 'pulling', message: `pulling image ${image}` });

  await new Promise<void>((resolve, reject) => {
    docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) {
        emit(containerId, {
          type: 'error',
          message: `pull failed: ${err.message}`,
        });
        reject(err);
        return;
      }

      docker.modem.followProgress(
        stream,
        (err: Error | null) => {
          if (err) {
            emit(containerId, {
              type: 'error',
              message: `pull error: ${err.message}`,
            });
            reject(err);
          } else {
            emit(containerId, { type: 'pulling', message: 'image pulled' });
            resolve();
          }
        },
        (event: { status: string; progress?: string; id?: string }) => {
          // don't spam the WS with every layer chunk — only send meaningful status changes
          if (event.status === 'Pull complete' || event.status === 'Already exists') {
            emit(containerId, {
              type: 'pulling',
              message: `layer ${event.id ?? ''}: ${event.status}`,
            });
          }
        },
      );
    });
  });
}

// start or restart a game server container
export async function startContainer(
  id: string,
  image: string,
  env: Record<string, string> = {},
  ports = '',
  Memory: number,
  Cpu: number,
): Promise<void> {
  emit(id, { type: 'pulling', message: 'preparing environment' });

  // force-remove any existing container with this name before creating a new one
  try {
    await docker.getContainer(id).remove({ force: true });
  } catch (err: unknown) {
    if ((err as { statusCode?: number })?.statusCode !== 404) {
      logger.warn(`could not remove existing container ${id}: ${(err as Error)?.message}`);
    }
  }

  const volumePath = initContainer(id);
  const { portBindings, exposedPorts } = parsePortBindings(ports);
  const modifiedEnv = parseEnvironmentVariables(env);

  const portSummary = Object.entries(portBindings)
    .map(([container, host]) => `${host[0].HostPort} -> ${container}`)
    .join(', ');
  if (portSummary) emit(id, { type: 'pulling', message: `port bindings: ${portSummary}` });

  // check if image is already local before pulling
  let imageExists = false;
  try {
    await docker.getImage(image).inspect();
    imageExists = true;
  } catch {
    imageExists = false;
    emit(id, {
      type: 'pulling',
      message: `image not found locally — pulling from registry`,
    });
  }

  if (!imageExists) {
    await pullImageWithProgress(image, id);
  }

  emit(id, { type: 'creating', message: 'creating container' });

  // pre-write eula=true so minecraft servers don't exit on first boot
  const eulaPath = join(volumePath, 'eula.txt');
  if (!existsSync(eulaPath) || !readFileSync(eulaPath, 'utf8').includes('eula=true')) {
    writeFileSync(eulaPath, '#By installing Minecraft you agree to the EULA\neula=true\n', 'utf8');
  }

  // write a wrapper script that patches /etc/hostname and /etc/passwd before
  // handing off to the original image entrypoint. belt-and-braces approach:
  // docker's Hostname field covers the kernel hostname, the script covers
  // shells that read /etc/hostname or run whoami.
  const imageInspect = await docker
    .getImage(image)
    .inspect()
    .catch(() => null);
  const rawEntrypoint = imageInspect?.Config?.Entrypoint ?? [];
  const rawCmd = imageInspect?.Config?.Cmd ?? [];
  const originalEntrypoint: string[] = Array.isArray(rawEntrypoint) ? rawEntrypoint : [rawEntrypoint];
  const originalCmd: string[] = Array.isArray(rawCmd) ? rawCmd : [rawCmd];

  const quoted = (args: string[]) => args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  let execLine: string;
  if (originalEntrypoint.length > 0) {
    execLine = `exec ${quoted(originalEntrypoint)}${originalCmd.length > 0 ? ` ${quoted(originalCmd)}` : ''}`;
  } else if (originalCmd.length > 0) {
    execLine = `exec ${quoted(originalCmd)}`;
  } else {
    execLine = 'exec /bin/sh';
  }

  const airlinkdDir = join(volumePath, '.airlinkd');
  if (!existsSync(airlinkdDir)) mkdirSync(airlinkdDir, { recursive: true });

  const wrapperLines = [
    '#!/bin/sh',
    '',
    "echo 'airlinkd' > /etc/hostname 2>/dev/null || true",
    'hostname airlinkd 2>/dev/null || true',
    '',
    'if [ -f /etc/passwd ]; then',
    "  sed -i 's|^container:|airlinkd:|' /etc/passwd 2>/dev/null || true",
    "  sed -i 's|^user:|airlinkd:|'      /etc/passwd 2>/dev/null || true",
    "  sed -i 's|^app:|airlinkd:|'       /etc/passwd 2>/dev/null || true",
    'fi',
    '',
    'for _rc in /home/container/.bashrc /root/.bashrc /etc/bash.bashrc; do',
    '  if [ -f "$_rc" ]; then',
    '    sed -i \'s/petrodactyl/airlinkd/g\' "$_rc" 2>/dev/null || true',
    '    grep -q \'PS1.*airlinkd\' "$_rc" 2>/dev/null || echo \'export PS1="container@airlinkd \\w \\\\$ "\' >> "$_rc"',
    '  fi',
    'done',
    '',
    'export PS1="container@airlinkd \\w \\$ "',
    '',
    execLine,
  ];

  writeFileSync(join(airlinkdDir, 'init.sh'), `${wrapperLines.join('\n')}\n`, {
    mode: 0o755,
    encoding: 'utf8',
  });

  modifiedEnv.PS1 = 'container@airlinkd \\w \\$ ';
  modifiedEnv.PROMPT = 'container@airlinkd \\w \\$ ';
  modifiedEnv.prompt = 'container@airlinkd \\w \\$ ';

  const container = await docker.createContainer({
    name: id,
    Image: image,
    Hostname: 'airlinkd',
    Env: Object.entries(modifiedEnv).map(([k, v]) => `${k}=${v}`),
    Entrypoint: ['/bin/sh', '/home/container/.airlinkd/init.sh'],
    WorkingDir: '/home/container',
    HostConfig: {
      Binds: [`${volumePath}:/home/container`],
      PortBindings: portBindings,
      Memory: Memory * 1024 * 1024, // panel sends MB, dockerode wants bytes
      NanoCpus: Math.floor((Cpu / 100) * 1e9), // panel sends 0-100%, dockerode wants NanoCPUs
      RestartPolicy: { Name: 'unless-stopped' },
    },
    ExposedPorts: exposedPorts,
    AttachStdout: true,
    AttachStderr: true,
    AttachStdin: true,
    OpenStdin: true,
    Tty: true,
  });

  emit(id, { type: 'starting', message: 'starting container' });
  await container.start();
  emit(id, { type: 'started', message: 'server started' });
}

// run an installer container that mounts the volume, runs a script, then exits
export async function createInstaller(
  id: string,
  image: string,
  script: string,
  env: Record<string, string> = {},
  entrypoint = 'bash',
): Promise<void> {
  // force-remove any leftover installer container
  try {
    await docker.getContainer(`installer_${id}`).remove({ force: true });
  } catch (err: unknown) {
    if ((err as { statusCode?: number })?.statusCode !== 404) {
      logger.warn(`could not remove existing installer container for ${id}: ${(err as Error)?.message}`);
    }
  }

  const volumePath = initContainer(id);
  const modifiedEnv = parseEnvironmentVariables(env);

  emit(id, { type: 'installing', message: 'preparing installer' });

  let imageExists = false;
  try {
    await docker.getImage(image).inspect();
    imageExists = true;
  } catch {
    imageExists = false;
  }

  if (!imageExists) {
    emit(id, {
      type: 'installing',
      message: `pulling installer image: ${image}`,
    });
    const stream = await docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(stream, (err: Error | null) => {
        if (err) return reject(new Error(`failed to pull installer image: ${err.message}`));
        resolve();
      });
    });
  }

  emit(id, { type: 'installing', message: 'running install script' });

  const container = await docker.createContainer({
    name: `installer_${id}`,
    Image: image,
    Entrypoint: [entrypoint, '-c', script.replace(/\r\n/g, '\n').replace(/\r/g, '\n')],
    Env: Object.entries(modifiedEnv).map(([k, v]) => `${k}=${v}`),
    AttachStdout: true,
    AttachStderr: true,
    HostConfig: {
      Binds: [`${volumePath}:/mnt/server`],
      AutoRemove: false,
      NetworkMode: 'host',
    },
  });

  // attach before start — guarantees we capture output from the first byte
  const attachStream = await container.attach({
    stream: true,
    stdout: true,
    stderr: true,
  });

  const installerLines: string[] = [];

  // docker non-TTY attach uses an 8-byte mux header per frame
  // parse frame by frame — multiple frames can arrive in one data event
  const logDone = new Promise<void>((resolve) => {
    let buf = Buffer.alloc(0);

    attachStream.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const frameSize = buf.readUInt32BE(4);
        if (buf.length < 8 + frameSize) break;
        const payload = buf.slice(8, 8 + frameSize).toString('utf8');
        buf = buf.slice(8 + frameSize);
        for (const line of payload.split('\n')) {
          // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping ANSI control bytes
          const clean = line.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim();
          if (clean) {
            installerLines.push(clean);
            emit(id, { type: 'installing', message: clean });
          }
        }
      }
    });

    attachStream.on('end', resolve);
    attachStream.on('error', resolve);
  });

  await container.start();

  const [result] = await Promise.all([container.wait(), logDone]);

  if (result.StatusCode !== 0) {
    logger.warn(`installer for ${id} exited with code ${result.StatusCode}`);
    for (const l of installerLines.slice(-20)) logger.warn(`  ${l}`);
    await container.remove({ force: true }).catch(() => {});
    throw new Error(`install script failed with exit code ${result.StatusCode}`);
  }

  emit(id, { type: 'installed', message: 'installation complete' });
  await container.remove({ force: true }).catch(() => {});
}

export async function stopContainer(id: string, stopCmd?: string): Promise<void> {
  const container = docker.getContainer(id);
  const info = await container.inspect().catch(() => null);
  if (!info?.State.Running) return;

  emit(id, { type: 'stopping', message: 'stopping server' });

  // send the game-specific stop command first (e.g. "stop" for minecraft)
  if (stopCmd && stopCmd !== 'kill') {
    try {
      await sendCommandToContainer(id, stopCmd);
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      logger.warn(`failed to send stop command to ${id}: ${err}`);
    }

    // wait up to 20s for the process to exit on its own
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const current = await container.inspect().catch(() => null);
      if (!current?.State.Running) {
        emit(id, { type: 'stopped', message: 'server stopped' });
        return;
      }
    }
  }

  // process didn't exit cleanly — force it
  try {
    await container.stop({ t: 5 });
  } catch (err: unknown) {
    const status = (err as { statusCode?: number })?.statusCode;
    if (status !== 304 && status !== 404) {
      logger.warn(`container.stop() for ${id}: ${(err as Error)?.message}`);
    }
  }

  try {
    await container.remove({ force: true });
  } catch (err: unknown) {
    if ((err as { statusCode?: number })?.statusCode !== 404) {
      logger.warn(`container.remove() after stop for ${id}: ${(err as Error)?.message}`);
    }
  }

  emit(id, { type: 'stopped', message: 'server stopped' });
}

export async function killContainer(id: string): Promise<void> {
  try {
    await docker.getContainer(id).remove({ force: true });
  } catch (err: unknown) {
    if ((err as { statusCode?: number })?.statusCode !== 404) {
      logger.warn(`killContainer for ${id}: ${(err as Error)?.message}`);
    }
  }
  emit(id, { type: 'killed', message: 'container forcibly removed' });
}

export async function deleteContainer(id: string): Promise<void> {
  try {
    await docker.getContainer(id).remove({ force: true });
    logger.info(`container ${id} deleted`);
  } catch (err: unknown) {
    if ((err as { statusCode?: number })?.statusCode !== 404) {
      logger.warn(`deleteContainer for ${id}: ${(err as Error)?.message}`);
    }
  }
}

export async function deleteContainerAndVolume(id: string): Promise<void> {
  await deleteContainer(id);
  const volumePath = resolve(process.cwd(), 'volumes', id);
  if (existsSync(volumePath)) {
    rmSync(volumePath, { recursive: true, force: true });
    logger.info(`volume for ${id} deleted`);
  }
}

export async function sendCommandToContainer(id: string, command: string): Promise<void> {
  try {
    const container = docker.getContainer(id);
    const info = await container.inspect().catch(() => null);
    if (!info?.State.Running) {
      logger.warn(`container ${id} is not running — cannot send command`);
      return;
    }

    // attach a new stdin stream and write the command to it
    // docker allows multiple concurrent attach streams on the same container
    const stream = await container.attach({
      stream: true,
      stdin: true,
      stdout: false,
      stderr: false,
    });
    stream.write(`${command}\n`);
    stream.end();

    logger.debug(`command sent to container ${id}: ${command}`);
  } catch (error) {
    logger.error(`failed to send command to container ${id}`, error);
  }
}
