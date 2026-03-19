import { docker } from "./utils";
import { emitContainerEvent } from "./eventBus";
import logger from "../../utils/logger";

export const killContainer = async (id: string): Promise<void> => {
  try {
    await docker.getContainer(id).remove({ force: true });
  } catch (err: any) {
    if (err?.statusCode !== 404) {
      logger.warn(`killContainer for ${id}: ${err?.message}`);
    }
  }
  emitContainerEvent(id, { type: 'killed', message: 'Container forcibly removed' });
};
