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
  const existing = subs.get(containerId);
  if (existing) {
    existing.add(handler);
  } else {
    subs.set(containerId, new Set([handler]));
  }
  return () => {
    const current = subs.get(containerId);
    if (!current) return;
    current.delete(handler);
    // Drop the now-empty set so a container that stops being observed doesn't
    // linger in the map forever (was a slow leak across many container cycles).
    if (current.size === 0) subs.delete(containerId);
  };
}
