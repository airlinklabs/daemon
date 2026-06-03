import Docker from 'dockerode';
import logger from '../logger';

export interface ContainerRuntime {
  name: string;
  getContainer(id: string): Docker.Container;
  listContainers(opts?: Docker.ContainerListOptions): Promise<Docker.ContainerInfo[]>;
  getEvents(opts?: Docker.GetEventsOptions): Promise<NodeJS.ReadableStream>;
  pull(image: string, opts?: object): Promise<NodeJS.ReadableStream>;
  createContainer(opts: Docker.ContainerCreateOptions): Promise<Docker.Container>;
  getImage(name: string): Docker.Image;
  modem: Docker['modem'];
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

  pull(image: string, opts?: object): Promise<NodeJS.ReadableStream> {
    return this.docker.pull(image, opts);
  }

  createContainer(opts: Docker.ContainerCreateOptions): Promise<Docker.Container> {
    return this.docker.createContainer(opts);
  }

  getImage(name: string): Docker.Image {
    return this.docker.getImage(name);
  }

  get modem(): Docker['modem'] {
    return this.docker.modem;
  }
}

export class PodmanRuntime implements ContainerRuntime {
  private podman: Docker;
  name = 'podman';

  constructor(socketPath: string) {
    this.podman = new Docker({ socketPath });
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

  pull(image: string, opts?: object): Promise<NodeJS.ReadableStream> {
    return this.podman.pull(image, opts);
  }

  createContainer(opts: Docker.ContainerCreateOptions): Promise<Docker.Container> {
    return this.podman.createContainer(opts);
  }

  getImage(name: string): Docker.Image {
    return this.podman.getImage(name);
  }

  get modem(): Docker['modem'] {
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

  logger.info('container runtime initialized', { runtime: type, socketPath });

  return type === 'docker' ? new DockerRuntime(socketPath) : new PodmanRuntime(socketPath);
}
