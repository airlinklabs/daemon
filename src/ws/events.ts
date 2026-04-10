import { subscribe as subscribeToEvents } from "../handlers/docker";

export function subscribe(containerId: string, fn: (event: { type: string; message: string }) => void): () => void {
  return subscribeToEvents(containerId, fn);
}
