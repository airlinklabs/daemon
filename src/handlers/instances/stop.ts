import { docker } from "./utils";
import { sendCommandToContainer } from "./command";
import { deleteContainer } from "./delete";
import { emitContainerEvent } from "./eventBus";
import logger from "../../utils/logger";

export const stopContainer = async (id: string, stopCmd?: string): Promise<void> => {
  const container = docker.getContainer(id);
  const containerInfo = await container.inspect().catch(() => null);

  if (!containerInfo || !containerInfo.State.Running) {
    return;
  }

  emitContainerEvent(id, { type: 'stopping', message: 'Sending stop command' });

  if (stopCmd) {
    await sendCommandToContainer(id, stopCmd);
  }

  await container.stop();
  emitContainerEvent(id, { type: 'stopped', message: 'Container stopped' });
  await deleteContainer(id);
};
