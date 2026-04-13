// This code was written by thavanish(https://github.com/thavanish) for airlinklabs
// simple pub/sub for container lifecycle events
// EventEmitter would also work but a plain Map is cleaner to reason about

type EventType =
  | 'pulling'
  | 'creating'
  | 'starting'
  | 'started'
  | 'stopping'
  | 'stopped'
  | 'killed'
  | 'installing'
  | 'installed'
  | 'error';

export type ContainerEvent = { type: EventType; message: string };
type Handler = (event: ContainerEvent) => void;

const subs = new Map<string, Set<Handler>>();

export function emit(containerId: string, event: ContainerEvent): void {
  const handlers = subs.get(containerId);
  if (!handlers) return;
  for (const h of handlers) h(event);
}

export function subscribe(containerId: string, handler: Handler): () => void {
  if (!subs.has(containerId)) subs.set(containerId, new Set());
  subs.get(containerId)?.add(handler);
  return () => subs.get(containerId)?.delete(handler);
}
