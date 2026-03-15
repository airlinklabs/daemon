import { docker } from "./utils";
import { sendCommandToContainer } from "./command";
import { deleteContainer } from "./delete";
import logger from "../../utils/logger";

export const stopContainer = async (id: string, stopCmd?: string): Promise<void> => {
  const container = docker.getContainer(id);
  const containerInfo = await container.inspect().catch(() => null);

  if (!containerInfo || !containerInfo.State.Running) {
    logger.info(`Container ${id} is not running.`);
    return;
  }

  if (stopCmd) {
    await sendCommandToContainer(id, stopCmd);
  }

  await container.stop();
  logger.info(`Container ${id} stopped successfully.`);
  await deleteContainer(id);
};
