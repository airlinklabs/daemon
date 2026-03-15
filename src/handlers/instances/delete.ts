import fs from "fs";
import path from "path";
import { docker } from "./utils";
import logger from "../../utils/logger";

export const deleteContainer = async (id: string): Promise<void> => {
  const container = docker.getContainer(id);
  const containerInfo = await container.inspect().catch(() => null);
  if (containerInfo) {
    await container.remove({ force: true });
    logger.info(`Container ${id} deleted.`);
  }
};

export const deleteContainerAndVolume = async (id: string): Promise<void> => {
  await deleteContainer(id);

  const volumePath = path.resolve("volumes", id);
  if (fs.existsSync(volumePath)) {
    fs.rmSync(volumePath, { recursive: true, force: true });
    logger.info(`Volume for ${id} deleted.`);
  }
};
