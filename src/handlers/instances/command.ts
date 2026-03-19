import { docker } from './utils';
import logger from '../../utils/logger';

export const sendCommandToContainer = async (id: string, command: string): Promise<void> => {
  try {
    const container = docker.getContainer(id);
    const info = await container.inspect().catch(() => null);

    if (!info || !info.State.Running) {
      logger.warn(`Container ${id} is not running — cannot send command.`);
      return;
    }

    // Attach a new stdin stream to the container and write the command to it.
    // Docker allows multiple concurrent attach streams on the same container,
    // so this does not interfere with the log stream the console WS is reading.
    // The running process reads from its own stdin and sees the command exactly
    // as if a user typed it in a terminal.
    //
    // The previous approach (/proc/1/fd/0 via exec) fails in yolks containers
    // because PID 1 is the entrypoint script which exits after launching the
    // server via gosu — by the time the server is running, /proc/1/fd/0 either
    // belongs to a dead process or is remapped to something unrelated.
    const stream = await container.attach({
      stream: true,
      stdin: true,
      stdout: false,
      stderr: false,
    });

    stream.write(command + '\n');
    stream.end();

    logger.debug(`Command sent to container ${id}: ${command}`);
  } catch (error) {
    logger.error(`Failed to send command to container ${id}:`, error);
  }
};
