// This code was written by thavanish(https://github.com/thavanish) for airlinklabs
// port of the original attach.ts
// the only change: ws type is ServerWebSocket<WsData> not ws.WebSocket
// readyState === 1 means OPEN in both

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
      // ws.send() in Bun accepts Buffer directly — no .toString() needed
      // the panel's xterm writes binary chunks as-is which preserves ANSI codes
      if (ws.readyState === 1) ws.send(chunk);
    });

    logStream.on('error', (err: Error) => {
      logger.error(`log stream error for ${id}`, err);
    });

    logStream.on('end', () => {
      logger.debug(`log stream ended for ${id}`);
      if (ws.readyState === 1) ws.close(1000, 'stream ended');
    });

    // store a cleanup fn so wsClose can destroy the stream on disconnect
    // this prevents dockerode log streams from leaking when the panel disconnects
    (ws.data as WsData & { _logCleanup?: () => void })._logCleanup = () => {
      try {
        (logStream as unknown as { destroy(): void }).destroy();
      } catch {}
    };

    logger.debug(`attached to container ${id}`);
  } catch (err) {
    logger.debug(`attach skipped for ${id}: ${err instanceof Error ? err.message : err}`);
    if (ws.readyState === 1) ws.close(1000, 'container not available');
  }
}
