import type { ServerWebSocket } from 'bun';
import { docker } from '../handlers/docker';
import logger from '../logger';
import type { WsData } from './server';

export async function attachToContainer(id: string, ws: ServerWebSocket<WsData>): Promise<void> {
  try {
    const container = docker.getContainer(id);

    // container was created with Tty:true so docker sends a raw stream, no mux header
    // tail:100 gives the panel the last 100 lines immediately on connect
    const logStream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: 100,
    });

    logStream.on('data', (chunk: Buffer) => {
      if (ws.readyState === 1) ws.send(chunk);
    });

    logStream.on('error', (err: Error) => {
      logger.error(`log stream error for ${id}`, err);
    });

    logStream.on('end', () => {
      if (ws.readyState === 1) ws.close(1000, 'stream ended');
    });

    // destroy the log stream when the ws closes — same pattern as express
    // avoids dockerode log streams leaking when the panel disconnects
    ws.data._logCleanup = () => {
      try {
        (logStream as unknown as { destroy(): void }).destroy();
      } catch {}
    };
  } catch {
    // container doesn't exist yet or has stopped — close cleanly without sending
    // any text to the terminal (xterm would render it as container output)
    if (ws.readyState === 1) ws.close(1000, 'container not available');
  }
}
