import { EventEmitter } from 'events';

export type ContainerEvent =
  | { type: 'pulling';       message: string }
  | { type: 'creating';      message: string }
  | { type: 'starting';      message: string }
  | { type: 'started';       message: string }
  | { type: 'stopping';      message: string }
  | { type: 'stopped';       message: string }
  | { type: 'killed';        message: string }
  | { type: 'error';         message: string };

const bus = new EventEmitter();
bus.setMaxListeners(100);

export function emitContainerEvent(containerId: string, event: ContainerEvent) {
    bus.emit(`container:${containerId}`, event);
}

export function onContainerEvent(
    containerId: string,
    handler: (event: ContainerEvent) => void
): () => void {
    const key = `container:${containerId}`;
    bus.on(key, handler);
    return () => bus.off(key, handler);
}
