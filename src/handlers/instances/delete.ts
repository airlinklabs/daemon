import fs from "fs";
import path from "path";
import { docker } from "./utils";
import logger from "../../utils/logger";

export const deleteContainer = async (id: string): Promise<void> => {
  try {
    await docker.getContainer(id).remove({ force: true });
    logger.info(`Container ${id} deleted.`);
  } catch (err: any) {
    if (err?.statusCode !== 404) {
      logger.warn(`deleteContainer for ${id}: ${err?.message}`);
    }
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
