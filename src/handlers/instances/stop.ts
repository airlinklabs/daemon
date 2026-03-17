import { docker } from "./utils";
import { sendCommandToContainer } from "./command";
import { emitContainerEvent } from "./eventBus";

export const stopContainer = async (id: string, stopCmd?: string): Promise<void> => {
  const container = docker.getContainer(id);
  const containerInfo = await container.inspect().catch(() => null);

  if (!containerInfo || !containerInfo.State.Running) {
    return;
  }

  emitContainerEvent(id, { type: 'stopping', message: 'Stopping server' });

  // If the image has a console stop command, send it and give the process
  // a short window to shut down cleanly before we force-kill it.
  if (stopCmd) {
    emitContainerEvent(id, { type: 'stopping', message: `Sending stop command` });
    await sendCommandToContainer(id, stopCmd);

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1000));
      const info = await container.inspect().catch(() => null);
      if (!info || !info.State.Running) break;
    }
  }

  // Force-remove the container. This sends SIGKILL immediately and deletes
  // the container in one step — the process cannot survive this regardless
  // of what the image is doing.
  await container.remove({ force: true });
  emitContainerEvent(id, { type: 'stopped', message: 'Server stopped' });
};
