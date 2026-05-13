import Docker from 'dockerode';
import logger from '../logger';

export interface ContainerRuntime {
  name: string;
  getContainer(id: string): Docker.Container;
  listContainers(opts?: Docker.ContainerListOptions): Promise<Docker.ContainerInfo[]>;
  getEvents(opts?: Docker.GetEventsOptions): Promise<NodeJS.ReadableStream>;
  pull(image: string, opts?: any): Promise<NodeJS.ReadableStream>;
  createContainer(opts: Docker.ContainerCreateOptions): Promise<Docker.Container>;
  getImage(name: string): Docker.Image;
  modem: any;
}

export class DockerRuntime implements ContainerRuntime {
  private docker: Docker;
  name = 'docker';

  constructor(socketPath: string) {
    this.docker = new Docker({ socketPath });
  }

  getContainer(id: string): Docker.Container {
    return this.docker.getContainer(id);
  }

  listContainers(opts?: Docker.ContainerListOptions): Promise<Docker.ContainerInfo[]> {
    return this.docker.listContainers(opts);
  }

  getEvents(opts?: Docker.GetEventsOptions): Promise<NodeJS.ReadableStream> {
    return this.docker.getEvents(opts);
  }

  pull(image: string, opts?: any): Promise<NodeJS.ReadableStream> {
    return this.docker.pull(image, opts);
  }

  createContainer(opts: Docker.ContainerCreateOptions): Promise<Docker.Container> {
    return this.docker.createContainer(opts);
  }

  getImage(name: string): Docker.Image {
    return this.docker.getImage(name);
  }

  get modem(): any {
    return this.docker.modem;
  }
}

export class PodmanRuntime implements ContainerRuntime {
  private podman: Docker;
  name = 'podman';

  constructor(socketPath: string) {
    this.podman = new Docker({ socketPath });
    logger.info('using podman runtime (podman API is docker-compatible)');
  }

  getContainer(id: string): Docker.Container {
    return this.podman.getContainer(id);
  }

  listContainers(opts?: Docker.ContainerListOptions): Promise<Docker.ContainerInfo[]> {
    return this.podman.listContainers(opts);
  }

  getEvents(opts?: Docker.GetEventsOptions): Promise<NodeJS.ReadableStream> {
    return this.podman.getEvents(opts);
  }

  pull(image: string, opts?: any): Promise<NodeJS.ReadableStream> {
    return this.podman.pull(image, opts);
  }

  createContainer(opts: Docker.ContainerCreateOptions): Promise<Docker.Container> {
    return this.podman.createContainer(opts);
  }

  getImage(name: string): Docker.Image {
    return this.podman.getImage(name);
  }

  get modem(): any {
    return this.podman.modem;
  }
}

export function createRuntime(type: 'docker' | 'podman' = 'docker'): ContainerRuntime {
  const socketPath =
    type === 'docker'
      ? process.platform === 'win32'
        ? '//./pipe/docker_engine'
        : '/var/run/docker.sock'
      : '/run/podman/podman.sock';

  logger.info(`initializing ${type} runtime at ${socketPath}`);

  return type === 'docker' ? new DockerRuntime(socketPath) : new PodmanRuntime(socketPath);
}