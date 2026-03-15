import { docker, parsePortBindings, parseEnvironmentVariables, initContainer } from "./utils";
import { deleteContainer } from "./delete";
import logger from "../../utils/logger";

export const startContainer = async (
  id: string,
  image: string,
  env: Record<string, string> = {},
  ports: string = "",
  Memory: number,
  Cpu: number
): Promise<void> => {
  await deleteContainer(id);

  const volumePath = initContainer(id);
  const portBindings = parsePortBindings(ports);
  const modifiedEnv = parseEnvironmentVariables(env);

  // Only pull if the image isn't already present locally
  let imageExists = false;
  try {
    await docker.getImage(image).inspect();
    imageExists = true;
  } catch {
    imageExists = false;
  }

  if (!imageExists) {
    logger.info(`Pulling image ${image}...`);
    const stream = await docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(stream, (err) => {
        if (err) return reject(new Error(`Failed to pull image: ${err.message}`));
        logger.info(`Image ${image} pulled successfully.`);
        resolve();
      });
    });
  } else {
    logger.info(`Image ${image} already present, skipping pull.`);
  }

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

  await container.start();
  logger.info(`Container ${id} started successfully.`);
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

  // Only pull if the image isn't already present locally
  let imageExists = false;
  try {
    await docker.getImage(image).inspect();
    imageExists = true;
  } catch {
    imageExists = false;
  }

  if (!imageExists) {
    logger.info(`Pulling image ${image}...`);
    const stream = await docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(stream, (err) => {
        if (err) return reject(new Error(`Failed to pull image: ${err.message}`));
        logger.info(`Image ${image} pulled successfully.`);
        resolve();
      });
    });
  } else {
    logger.info(`Image ${image} already present, skipping pull.`);
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
  logger.info(`Installer container installer_${id} started successfully.`);
};
