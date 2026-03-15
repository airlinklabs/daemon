import { docker } from './utils';
import WebSocket, { Server } from 'ws';
import logger from '../../utils/logger';

export const attachToContainerWithWS = async (id: string, ws: WebSocket): Promise<void> => {
    try {
        logger.info(`Attaching to container ${id}...`);
        const container = docker.getContainer(id);

        const logStream = await container.logs({
            follow: true,
            stdout: true,
            stderr: true,
            tail: 100
        });

        logStream.on('data', chunk => {
            ws.send(chunk.toString());
        });

        ws.on('close', () => {
            logger.info(`WebSocket connection closed for container ${id}`);
        });

        logger.success(`Attached to container ${id} successfully.`);
    } catch (error) {
        logger.error(`Failed to attach to container ${id}:`, error);

        if (ws.readyState === WebSocket.OPEN) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            ws.send(JSON.stringify({ error: `Failed to attach to container ${id}: ${errorMessage}` }));
        }
    }
};
