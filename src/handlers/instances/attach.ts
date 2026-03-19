import { docker } from './utils';
import WebSocket from 'ws';
import logger from '../../utils/logger';

export const attachToContainerWithWS = async (id: string, ws: WebSocket): Promise<void> => {
    try {
        const container = docker.getContainer(id);

        // container.logs() with follow:true is the correct way to stream output
        // from an already-running container. Because the container was created
        // with Tty:true, Docker sends a raw stream — no 8-byte mux header — so
        // we can forward each chunk as-is. ANSI sequences, CR/LF, and TUI
        // control codes are preserved.
        const logStream = await container.logs({
            follow: true,
            stdout: true,
            stderr: true,
            tail:   100,
        });

        logStream.on('data', (chunk: Buffer) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(chunk);
            }
        });

        logStream.on('error', (err: Error) => {
            logger.error(`Log stream error for container ${id}:`, err);
        });

        logStream.on('end', () => {
            logger.debug(`Log stream ended for ${id} — closing WS so client reattaches`);
            // Closing here forces the panel proxy to reconnect, which triggers a
            // new auth → attachToContainerWithWS call once the container is back up.
            if (ws.readyState === WebSocket.OPEN) {
                ws.close(1000, 'stream ended');
            }
        });

        ws.on('close', () => {
            try { (logStream as any).destroy(); } catch {}
        });

        logger.debug(`Attached to container ${id} successfully.`);
    } catch (error) {
        // Container doesn't exist yet (still starting) or has already stopped.
        // Close the WS cleanly — do not send any error text to the client terminal.
        logger.debug(`Attach skipped for container ${id}: ${error instanceof Error ? error.message : error}`);
        if (ws.readyState === WebSocket.OPEN) {
            ws.close(1000, 'container not available');
        }
    }
};
