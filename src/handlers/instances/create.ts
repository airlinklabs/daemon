import { docker, parsePortBindings, parseEnvironmentVariables, initContainer } from "./utils";
import { emitContainerEvent } from "./eventBus";
import { setServerState } from "./install";
import logger from "../../utils/logger";
import fs from "fs";
import path from "path";

export const startContainer = async (
  id: string,
  image: string,
  env: Record<string, string> = {},
  ports: string = "",
  Memory: number,
  Cpu: number
): Promise<void> => {
  emitContainerEvent(id, { type: 'pulling', message: 'Preparing environment' });

  // Always force-remove any container with this name before creating a new one.
  // remove({force:true}) works even if the container is running or paused.
  // We ignore 404 (already gone) and let any other error bubble up.
  try {
    await docker.getContainer(id).remove({ force: true });
  } catch (err: any) {
    if (err?.statusCode !== 404) {
      logger.warn(`Could not remove existing container ${id}: ${err?.message}`);
    }
  }

  const volumePath = initContainer(id);

  const portBindings = parsePortBindings(ports);
  const modifiedEnv  = parseEnvironmentVariables(env);

  // Log port bindings (safe — no host paths or secrets)
  const portSummary = Object.entries(portBindings)
    .map(([container, host]) => {
      const binding = Array.isArray(host) && host[0] ? `${(host[0] as any).HostPort} -> ${container}` : container;
      return binding;
    })
    .join(', ');
  if (portSummary) {
    emitContainerEvent(id, { type: 'pulling', message: `Port bindings: ${portSummary}` });
  }

  // Check image presence
  let imageExists = false;
  try {
    await docker.getImage(image).inspect();
    imageExists = true;
    } catch {
    imageExists = false;
    emitContainerEvent(id, { type: 'pulling', message: `Image not found locally — will pull from registry` });
  }

  if (!imageExists) {
    emitContainerEvent(id, { type: 'pulling', message: `Pulling ${image}` });
    const stream = await docker.pull(image);

    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(
        stream,
        (err) => {
          if (err) {
            emitContainerEvent(id, { type: 'error', message: `Pull failed: ${err.message}` });
            return reject(new Error(`Failed to pull image: ${err.message}`));
          }
          emitContainerEvent(id, { type: 'pulling', message: `Image ${image} pulled successfully` });
          resolve();
        },
        (event: any) => {
          if (!event) return;

          // Minimal pull progress — only emit the top-level status lines
          const status: string = event.status || '';
          if (status === 'Status' && event.id) {
            emitContainerEvent(id, { type: 'pulling', message: event.id });
          }
        }
      );
    });
  }

  // Container creation
  emitContainerEvent(id, { type: 'creating', message: 'Creating container' });

  // Pre-write eula=true so Minecraft servers don't exit on first boot.
  const eulaPath = path.join(volumePath, 'eula.txt');
  if (!fs.existsSync(eulaPath) || !fs.readFileSync(eulaPath, 'utf8').includes('eula=true')) {
    fs.writeFileSync(eulaPath, '#By installing Minecraft you agree to the EULA\neula=true\n', 'utf8');
  }

  // Write a wrapper script into the volume (which is always a writable bind
  // mount from the host) that patches /etc/passwd and /etc/hostname before
  // handing off to the original image entrypoint. Every write inside the
  // container's root filesystem uses || true so a read-only rootfs won't
  // block startup — the hostname is also set via Docker's Hostname field
  // as a belt-and-braces fallback that needs no filesystem writes at all.
  //
  // The one thing we deliberately omit is writing to /proc/sys/kernel/hostname
  // — that requires CAP_SYS_ADMIN and fails silently in unprivileged containers.
  // Docker's Hostname field covers that case.

  const imageInspect = await docker.getImage(image).inspect().catch(() => null);
  const rawEntrypoint = imageInspect?.Config?.Entrypoint ?? [];
  const rawCmd        = imageInspect?.Config?.Cmd ?? [];
  const originalEntrypoint: string[] = Array.isArray(rawEntrypoint) ? rawEntrypoint : [rawEntrypoint];
  const originalCmd: string[]        = Array.isArray(rawCmd)        ? rawCmd        : [rawCmd];

  const quoted = (args: string[]) => args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  let execLine: string;
  if (originalEntrypoint.length > 0) {
    execLine = `exec ${quoted(originalEntrypoint)}${originalCmd.length > 0 ? ' ' + quoted(originalCmd) : ''}`;
  } else if (originalCmd.length > 0) {
    execLine = `exec ${quoted(originalCmd)}`;
  } else {
    execLine = 'exec /bin/sh';
  }

  const airlinkdDir = path.join(volumePath, '.airlinkd');
  if (!fs.existsSync(airlinkdDir)) {
    fs.mkdirSync(airlinkdDir, { recursive: true });
  }

  const wrapperLines = [
    '#!/bin/sh',
    '',
    '# Patch hostname — works via Docker Hostname field already, but this',
    '# also fixes $(cat /etc/hostname) inside shells that read it directly.',
    "echo 'airlinkd' > /etc/hostname 2>/dev/null || true",
    'hostname airlinkd 2>/dev/null || true',
    '',
    '# Rename uid 1000 in /etc/passwd so $(whoami) returns airlinkd.',
    '# yolks images use "container" as the username for uid 1000.',
    'if [ -f /etc/passwd ]; then',
    "  sed -i 's|^container:|airlinkd:|' /etc/passwd 2>/dev/null || true",
    "  sed -i 's|^user:|airlinkd:|'      /etc/passwd 2>/dev/null || true",
    "  sed -i 's|^app:|airlinkd:|'       /etc/passwd 2>/dev/null || true",
    'fi',
    '',
    '# Hand off to the original image entrypoint unchanged.',
    execLine,
  ];

  const wrapperPath = path.join(airlinkdDir, 'init.sh');
  fs.writeFileSync(wrapperPath, wrapperLines.join('\n') + '\n', { mode: 0o755, encoding: 'utf8' });

  modifiedEnv['PS1']    = 'airlinkd~ ';
  modifiedEnv['PROMPT'] = 'airlinkd~ ';
  modifiedEnv['prompt'] = 'airlinkd~ ';

  const exposedPorts = Object.keys(portBindings).reduce((acc, port) => {
    acc[port] = {};
    return acc;
  }, {} as Record<string, {}>);

  const container = await docker.createContainer({
    name: id,
    Image: image,
    Hostname: 'airlinkd',
    Env: Object.entries(modifiedEnv).map(([key, value]) => `${key}=${value}`),
    Entrypoint: ['/bin/sh', '/home/container/.airlinkd/init.sh'],
    WorkingDir: '/home/container',
    HostConfig: {
      Binds: [`${volumePath}:/home/container`],
      PortBindings: portBindings,
      Memory: Memory * 1024 * 1024,
      NanoCpus: Math.max(0.5, Cpu / 100) * 1e9,
      RestartPolicy: { Name: 'no' },
    },
    ExposedPorts: exposedPorts,
    AttachStdout: true,
    AttachStderr: true,
    AttachStdin: true,
    OpenStdin: true,
    Tty: true,
  });

  emitContainerEvent(id, { type: 'starting', message: 'Starting container' });

  await container.start();

  emitContainerEvent(id, { type: 'started', message: 'Server started' });
};

export const createInstaller = async (
  id: string,
  image: string,
  script: string,
  env: Record<string, string> = {},
  entrypoint: string = "bash"
): Promise<void> => {
  // Force-remove any leftover installer container. Same pattern as startContainer.
  try {
    await docker.getContainer("installer_" + id).remove({ force: true });
  } catch (err: any) {
    if (err?.statusCode !== 404) {
      logger.warn(`Could not remove existing installer container for ${id}: ${err?.message}`);
    }
  }

  const volumePath = initContainer(id);
  const modifiedEnv = parseEnvironmentVariables(env);

  emitContainerEvent(id, { type: 'installing', message: 'Preparing installer' });

  let imageExists = false;
  try {
    await docker.getImage(image).inspect();
    imageExists = true;
  } catch {
    imageExists = false;
  }

  if (!imageExists) {
    emitContainerEvent(id, { type: 'installing', message: `Pulling installer image: ${image}` });
    const stream = await docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(stream, (err) => {
        if (err) return reject(new Error(`Failed to pull installer image: ${err.message}`));
        resolve();
      });
    });
  }

  emitContainerEvent(id, { type: 'installing', message: 'Running install script' });

  const container = await docker.createContainer({
    name: "installer_" + id,
    Image: image,
    Entrypoint: [entrypoint, "-c", script.replace(/\r\n/g, '\n').replace(/\r/g, '\n')],
    Env: Object.entries(modifiedEnv).map(([key, value]) => `${key}=${value}`),
    AttachStdout: true,
    AttachStderr: true,
    HostConfig: {
      Binds: [`${volumePath}:/mnt/server`],
      AutoRemove: false,
      NetworkMode: "host",
    },
  });

  // Attach before start — guarantees we capture output from the first byte.
  // container.logs() after start misses output from fast-exiting containers.
  const attachStream = await container.attach({
    stream: true,
    stdout: true,
    stderr: true,
  });

  const installerLines: string[] = [];

  // Docker non-TTY attach uses an 8-byte mux header per frame.
  // Parse frame by frame — multiple frames can arrive in one data event.
  const logDone = new Promise<void>((resolve) => {
    let buf = Buffer.alloc(0);

    attachStream.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const frameSize = buf.readUInt32BE(4);
        if (buf.length < 8 + frameSize) break;
        const payload = buf.slice(8, 8 + frameSize).toString('utf8');
        buf = buf.slice(8 + frameSize);
        payload.split('\n').forEach(line => {
          const clean = line.replace(/[\x00-\x08\x0b-\x1f]/g, '').trim();
          if (clean) {
            installerLines.push(clean);
            emitContainerEvent(id, { type: 'installing', message: clean });
          }
        });
      }
    });

    attachStream.on('end', resolve);
    attachStream.on('error', resolve);
  });

  await container.start();

  const [result] = await Promise.all([container.wait(), logDone]);

  if (result.StatusCode !== 0) {
    logger.warn(`Installer for ${id} exited with code ${result.StatusCode}. Last output:`);
    installerLines.slice(-20).forEach(l => logger.warn(`  ${l}`));
    await container.remove({ force: true }).catch(() => {});
    setServerState(id, 'failed');
    throw new Error(`Install script failed with exit code ${result.StatusCode}`);
  }

  emitContainerEvent(id, { type: 'installed', message: 'Installation complete' });

  await container.remove({ force: true }).catch(() => {});

  setServerState(id, 'installed');
};
