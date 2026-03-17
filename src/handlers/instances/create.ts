import { docker, parsePortBindings, parseEnvironmentVariables, initContainer } from "./utils";
import { deleteContainer } from "./delete";
import { emitContainerEvent } from "./eventBus";
import logger from "../../utils/logger";

export const startContainer = async (
  id: string,
  image: string,
  env: Record<string, string> = {},
  ports: string = "",
  Memory: number,
  Cpu: number
): Promise<void> => {
  emitContainerEvent(id, { type: 'pulling', message: 'Preparing environment' });

  // Check for existing container and remove it, prepare volume
  const existingContainer = docker.getContainer(id);
  const existingInfo = await existingContainer.inspect().catch(() => null);
  if (existingInfo) {
    emitContainerEvent(id, { type: 'pulling', message: `Removing existing container ${id}` });
    await existingContainer.remove({ force: true });
    emitContainerEvent(id, { type: 'pulling', message: `Container ${id} removed` });
  }

  const volumePath = initContainer(id);
  emitContainerEvent(id, { type: 'pulling', message: `Volume path: ${volumePath}` });

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
  emitContainerEvent(id, { type: 'pulling', message: `Checking for image: ${image}` });
  let imageExists = false;
  try {
    const imageInfo = await docker.getImage(image).inspect();
    imageExists = true;
    emitContainerEvent(id, { type: 'pulling', message: `Image found locally (${imageInfo.Id.slice(0, 19)})` });
    const sizeMB = (imageInfo.Size / 1024 / 1024).toFixed(1);
    emitContainerEvent(id, { type: 'pulling', message: `Image size: ${sizeMB} MB` });
  } catch {
    imageExists = false;
    emitContainerEvent(id, { type: 'pulling', message: `Image not found locally — will pull from registry` });
  }

  if (!imageExists) {
    emitContainerEvent(id, { type: 'pulling', message: `Pulling ${image}` });
    const stream = await docker.pull(image);

    await new Promise<void>((resolve, reject) => {
      const seenLayers = new Set<string>();

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

          const layerId = event.id ? event.id.slice(0, 12) : null;
          const status: string = event.status || '';
          const progressDetail = event.progressDetail;

          // Pull lifecycle phases — emit every status change
          if (status === 'Pulling from') {
            emitContainerEvent(id, { type: 'pulling', message: `Pulling from ${event.id || image}` });
          } else if (status === 'Pull complete' && layerId) {
            emitContainerEvent(id, { type: 'pulling', message: `Layer ${layerId}: pull complete` });
          } else if (status === 'Already exists' && layerId) {
            emitContainerEvent(id, { type: 'pulling', message: `Layer ${layerId}: already exists` });
          } else if (status === 'Downloading' && layerId && progressDetail?.total) {
            const pct = Math.round((progressDetail.current / progressDetail.total) * 100);
            // Throttle — only emit every 25% per layer to avoid flooding
            const bucket = Math.floor(pct / 25) * 25;
            const key = `${layerId}:${bucket}`;
            if (!seenLayers.has(key)) {
              seenLayers.add(key);
              const mb = (progressDetail.current / 1024 / 1024).toFixed(1);
              const totalMb = (progressDetail.total / 1024 / 1024).toFixed(1);
              emitContainerEvent(id, { type: 'pulling', message: `Layer ${layerId}: downloading ${mb}/${totalMb} MB (${pct}%)` });
            }
          } else if (status === 'Extracting' && layerId && progressDetail?.total) {
            const pct = Math.round((progressDetail.current / progressDetail.total) * 100);
            const key = `${layerId}:extract:${Math.floor(pct / 50) * 50}`;
            if (!seenLayers.has(key)) {
              seenLayers.add(key);
              emitContainerEvent(id, { type: 'pulling', message: `Layer ${layerId}: extracting (${pct}%)` });
            }
          } else if (status === 'Digest') {
            emitContainerEvent(id, { type: 'pulling', message: `Digest: ${event.id || ''}` });
          } else if (status === 'Status') {
            emitContainerEvent(id, { type: 'pulling', message: event.id || status });
          } else if (status && layerId && !['Waiting', 'Verifying Checksum'].includes(status)) {
            emitContainerEvent(id, { type: 'pulling', message: `Layer ${layerId}: ${status}` });
          } else if (status && !layerId && status !== 'Waiting') {
            emitContainerEvent(id, { type: 'pulling', message: status });
          }
        }
      );
    });
  }

  // Container creation
  emitContainerEvent(id, { type: 'creating', message: 'Creating container' });
  emitContainerEvent(id, { type: 'creating', message: `Image: ${image}` });
  emitContainerEvent(id, { type: 'creating', message: `Memory limit: ${Memory} MB` });
  emitContainerEvent(id, { type: 'creating', message: `CPU count: ${Cpu}` });

  const exposedPorts = Object.keys(portBindings).reduce((acc, port) => {
    acc[port] = {};
    return acc;
  }, {} as Record<string, {}>);

  const container = await docker.createContainer({
    name: id,
    Image: image,
    Env: Object.entries(modifiedEnv).map(([key, value]) => `${key}=${value}`),
    HostConfig: {
      Binds: [`${volumePath}:/app/data`],
      PortBindings: portBindings,
      Memory: Memory * 1024 * 1024,
      CpuCount: Cpu,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      ReadonlyRootfs: true,
    },
    ExposedPorts: exposedPorts,
    AttachStdout: true,
    AttachStderr: true,
    AttachStdin: true,
    OpenStdin: true,
    Tty: true,
  });

  emitContainerEvent(id, { type: 'creating', message: `Container created (${container.id.slice(0, 12)})` });
  emitContainerEvent(id, { type: 'starting', message: 'Starting container' });

  await container.start();

  emitContainerEvent(id, { type: 'starting', message: `Container ${container.id.slice(0, 12)} running` });
  emitContainerEvent(id, { type: 'started', message: 'Server process starting' });
};

export const createInstaller = async (
  id: string,
  image: string,
  script: string,
  env: Record<string, string> = {}
): Promise<void> => {
  await deleteContainer("installer_" + id);

  const volumePath = initContainer(id);
  const modifiedEnv = parseEnvironmentVariables(env);

  let imageExists = false;
  try {
    await docker.getImage(image).inspect();
    imageExists = true;
  } catch {
    imageExists = false;
  }

  if (!imageExists) {
    const stream = await docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(stream, (err) => {
        if (err) return reject(new Error(`Failed to pull image: ${err.message}`));
        resolve();
      });
    });
  }

  const container = await docker.createContainer({
    name: "installer_" + id,
    Image: image,
    Entrypoint: ["/bin/sh", "-c", script],
    Env: Object.entries(modifiedEnv).map(([key, value]) => `${key}=${value}`),
    HostConfig: {
      Binds: [`${volumePath}:/app/data`],
      AutoRemove: true,
      NetworkMode: "host",
    },
  });

  await container.start();
};
