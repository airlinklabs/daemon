import { docker } from "./utils";
import { sendCommandToContainer } from "./command";
import { emitContainerEvent } from "./eventBus";
import logger from "../../utils/logger";

const GRACEFUL_TIMEOUT_MS = 20000;
const POLL_INTERVAL_MS    = 500;

export const stopContainer = async (id: string, stopCmd?: string): Promise<void> => {
  const container = docker.getContainer(id);
  const info = await container.inspect().catch(() => null);

  if (!info || !info.State.Running) {
    return;
  }

  emitContainerEvent(id, { type: 'stopping', message: 'Stopping server' });

  // Step 1: send the game-specific stop command (e.g. "stop" for Minecraft).
  // This gives the server a chance to save state before we kill it.
  if (stopCmd && stopCmd !== 'kill') {
    try {
      await sendCommandToContainer(id, stopCmd);
    } catch (err) {
      logger.warn(`Failed to send stop command to ${id}: ${err}`);
    }

    const deadline = Date.now() + GRACEFUL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      const current = await container.inspect().catch(() => null);
      if (!current || !current.State.Running) {
        emitContainerEvent(id, { type: 'stopped', message: 'Server stopped' });
        return;
      }
    }
  }

  // Step 2: the process did not exit on its own — force kill then remove.
  // We stop (SIGTERM + wait) rather than kill (SIGKILL) so the process has
  // one last chance to flush buffers, then we force-remove regardless.
  try {
    await container.stop({ t: 5 });
  } catch (err: any) {
    if (err?.statusCode !== 304 && err?.statusCode !== 404) {
      logger.warn(`container.stop() for ${id}: ${err?.message}`);
    }
  }

  try {
    await container.remove({ force: true });
  } catch (err: any) {
    if (err?.statusCode !== 404) {
      logger.warn(`container.remove() after stop for ${id}: ${err?.message}`);
    }
  }

  emitContainerEvent(id, { type: 'stopped', message: 'Server stopped' });
};
