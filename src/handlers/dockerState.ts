import logger from '../logger';

// In-memory map of container ID/name to running state. Rebuilt from Docker's
// state on boot and kept in sync via event streaming. Not persisted to disk.

const stateMap = new Map<string, boolean>();

// Crash detection: maps container ID to a callback invoked when the container
// exits unexpectedly (non-zero exit, not a stop/kill by daemon).
const crashCallbacks = new Map<string, (id: string, exitCode: number) => void>();

const DOCKER_EVENT_RECONNECT_ERROR_MS = 5_000;
const DOCKER_EVENT_RECONNECT_END_MS = 2_000;

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}

export function applyContainerEvent(stateMap: Map<string, boolean>, action: string, id: string, name?: string): void {
  switch (action) {
    case 'start':
    case 'restart':
      stateMap.set(id, true);
      if (name) stateMap.set(name, true);
      break;
    case 'create':
    case 'pause':
    case 'die':
    case 'stop':
      stateMap.set(id, false);
      if (name) stateMap.set(name, false);
      break;
    case 'destroy':
      stateMap.delete(id);
      if (name) stateMap.delete(name);
      break;
    default:
      break;
  }
}

export function applyContainerList(
  stateMap: Map<string, boolean>,
  containers: Array<{ Id: string; State: string; Names?: string[] }>,
): void {
  for (const c of containers) {
    const running = c.State === 'running';
    stateMap.set(c.Id, running);
    const name = (c.Names?.[0] || '').replace(/^\//, '');
    if (name) stateMap.set(name, running);
  }
}

export function isContainerRunning(id: string): boolean | null {
  return stateMap.get(id) ?? null;
}

export function setContainerRunning(id: string, running: boolean): void {
  stateMap.set(id, running);
}

export function forgetContainer(id: string): void {
  stateMap.delete(id);
  crashCallbacks.delete(id);
}

// Register a callback for when a container exits unexpectedly.
// Returns an unsubscribe function.
export function onContainerCrash(id: string, cb: (id: string, exitCode: number) => void): () => void {
  crashCallbacks.set(id, cb);
  return () => {
    crashCallbacks.delete(id);
  };
}

// The runtime is passed in to avoid a circular dependency between docker.ts
// (which owns the runtime) and this module (which manages state).
type Runtime = {
  listContainers: (opts?: { all?: boolean }) => Promise<Array<{ Id: string; State: string; Names?: string[] }>>;
  getEvents: (opts?: object) => Promise<NodeJS.ReadableStream>;
};

export function initContainerStateMap(runtime: Runtime): Promise<void> {
  const syncState = async (): Promise<void> => {
    try {
      const containers = await runtime.listContainers({ all: true });
      stateMap.clear();
      applyContainerList(stateMap, containers);
      logger.info(`found ${containers.length} containers on boot`);
    } catch (err) {
      logger.error('could not map containers from docker', err);
    }
  };

  const subscribe = async (): Promise<void> => {
    try {
      const stream = await runtime.getEvents({
        filters: JSON.stringify({ type: ['container'] }),
      });

      await syncState();

      stream.on('data', (chunk: Buffer) => {
        try {
          const event = JSON.parse(chunk.toString()) as {
            Action: string;
            id: string;
            Actor?: { Attributes?: { name?: string; exitCode?: string } };
            status?: string;
          };
          applyContainerEvent(stateMap, event.Action, event.id, event.Actor?.Attributes?.name ?? '');

          // Crash detection: die event with non-zero exit code means unexpected exit.
          // The daemon-initiated stop events (stop/kill) are handled separately.
          if (event.Action === 'die' && crashCallbacks.has(event.id)) {
            // Parse exit code from Docker event attributes if available
            const exitCode = Number(event.Actor?.Attributes?.exitCode ?? event.status ?? '1');
            if (exitCode !== 0) {
              const cb = crashCallbacks.get(event.id);
              if (cb) {
                logger.warn(`container ${event.id} crashed with exit code ${exitCode}`);
                cb(event.id, exitCode);
              }
            }
          }
        } catch (err) {
          logger.debug(`dropped malformed docker event: ${getErrorMessage(err)}`);
        }
      });

      stream.on('error', (err: Error) => {
        logger.error('docker event stream had a bad time, reconnecting in 5s', err);
        setTimeout(subscribe, DOCKER_EVENT_RECONNECT_ERROR_MS);
      });

      stream.on('end', () => {
        logger.warn('docker event stream dropped, reconnecting in 2s');
        setTimeout(subscribe, DOCKER_EVENT_RECONNECT_END_MS);
      });

      logger.info('docker event stream connected');
    } catch (err) {
      logger.error('could not watch docker events, trying again in 5s', err);
      setTimeout(subscribe, DOCKER_EVENT_RECONNECT_ERROR_MS);
    }
  };

  return syncState().then(() => subscribe());
}
