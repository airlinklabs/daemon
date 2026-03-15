import { docker } from "./utils";
import logger from "../../utils/logger";

export const killContainer = async (id: string): Promise<void> => {
  const container = docker.getContainer(id);
  await container.remove({ force: true });
  logger.info(`Container ${id} killed.`);
};
