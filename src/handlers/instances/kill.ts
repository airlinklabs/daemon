import { docker } from "./utils";
import { emitContainerEvent } from "./eventBus";
import logger from "../../utils/logger";

export const killContainer = async (id: string): Promise<void> => {
  const container = docker.getContainer(id);
  await container.remove({ force: true });
  emitContainerEvent(id, { type: 'killed', message: 'Container forcibly removed' });
};
