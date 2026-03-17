import { IncomingMessage, Server as HttpServer } from 'http';
import WebSocket, { Server } from 'ws';
import { attachToContainerWithWS } from './attach';
import { getContainerStats, getContainerState } from './utils';
import { sendCommandToContainer } from './command';
import { onContainerEvent } from './eventBus';
import { isContainerRunning } from './containerState';
import { validateContainerId } from '../../utils/validation';
import config from "../../utils/config";
import logger from "../../utils/logger";

// Store all active WebSocket connections
const activeConnections: Set<WebSocket> = new Set();


// WebSocket server instance
let webSocketServer: Server | null = null;

export const initializeWebSocketServer = (server: HttpServer): void => {
    webSocketServer = new Server({ server });

    webSocketServer.on('connection', (ws: WebSocket, req: IncomingMessage) => {
        // Add connection to active connections set
        activeConnections.add(ws);
        let isAuthenticated = false;
        let intervalHandler: NodeJS.Timeout | null = null;

        ws.on('message', async (message: WebSocket.RawData) => {
            let msg: { event: string; args?: string[]; command?: string } | null = null;
            const messageString = message.toString();

            try {
                msg = JSON.parse(messageString);
            } catch (error) {
                ws.send(JSON.stringify({ error: 'Invalid JSON format' }));
                return;
            }

            const urlParts = req.url?.split('/') || [];
            const route = urlParts[1];
            const containerId = urlParts[2];

            if (config.DEBUG) {
                logger.debug('WebSocket URL parts:', urlParts);
            }

            if (!containerId) {
                ws.send(JSON.stringify({ error: 'Container ID is required in the URL' }));
                ws.close(1008, 'Container ID required');
                return;
            }

            if (!validateContainerId(containerId)) {
                ws.send(JSON.stringify({ error: 'Invalid container ID' }));
                ws.close(1008, 'Invalid container ID');
                return;
            }

            if (!msg || !msg.event) {
                ws.send(JSON.stringify({ error: 'Invalid message format' }));
                ws.close(1008, 'Invalid message format');
                return;
            }

            if (msg.event === 'auth' && msg.args && msg.args[0] === config.key) {
                if (!isAuthenticated) {
                    isAuthenticated = true;
                    if (config.DEBUG) {
                        logger.debug(`Client authenticated for container ${containerId}`);
                    }

                    if (route === 'container') {
                        await attachToContainerWithWS(containerId, ws);
                    } else if (route === 'containerstatus') {
                        // Send initial state immediately using in-memory map or inspect()
                        async function sendState() {
                            if (ws.readyState !== WebSocket.OPEN) return;
                            // Fast path: check in-memory state map first
                            const knownRunning = isContainerRunning(containerId);
                            if (knownRunning !== null) {
                                ws.send(JSON.stringify({ event: 'state', data: { running: knownRunning } }));
                            } else {
                                // Unknown — fall back to inspect()
                                const state = await getContainerState(containerId);
                                if (ws.readyState === WebSocket.OPEN) {
                                    ws.send(JSON.stringify({ event: 'state', data: state }));
                                }
                            }
                        }

                        async function sendStats() {
                            if (ws.readyState !== WebSocket.OPEN) return;
                            // Stats are completely independent of state.
                            // Failure here must never change the status indicator.
                            try {
                                const stats = await getContainerStats(containerId);
                                if (stats && ws.readyState === WebSocket.OPEN) {
                                    ws.send(JSON.stringify({ event: 'stats', data: stats }));
                                }
                            } catch {
                                // Stats unavailable — send nothing, caller keeps previous values
                            }
                        }

                        await sendState();
                        await sendStats();

                        // Poll state every 3s (fast, just inspect()) and stats every 5s (slow)
                        let stateTick = 0;
                        intervalHandler = setInterval(async () => {
                            stateTick++;
                            await sendState();
                            if (stateTick % 2 === 0) await sendStats();  // stats every ~6s
                        }, 3000);

                        ws.on('close', () => {
                            if (intervalHandler) clearInterval(intervalHandler);
                            if (config.DEBUG) {
                                logger.debug(`Connection closed for containerstatus/${containerId}`);
                            }
                        });
                    } else if (route === 'containerevents') {
                        // Stream real lifecycle events for this container
                        const unsubscribe = onContainerEvent(containerId, (event) => {
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({ event: 'lifecycle', data: event }));
                            }
                        });

                        ws.on('close', () => {
                            unsubscribe();
                            if (config.DEBUG) {
                                logger.debug(`Lifecycle event stream closed for ${containerId}`);
                            }
                        });
                    } else {
                        ws.send(JSON.stringify({ error: `Invalid route: ${route}` }));
                        ws.close(1008, 'Invalid route');
                    }
                }
            } else if (!isAuthenticated) {
                ws.send(JSON.stringify({ error: 'Authentication required' }));
                ws.close(1008, 'Authentication required');
                return;
            }

            if (isAuthenticated && msg.event === 'CMD' && route === 'container') {
                if (config.DEBUG) {
                    logger.debug(`Command received for container ${containerId}: ${msg.command}`);
                }
                if (msg.command) {
                    sendCommandToContainer(containerId, msg.command);
                }
            }
        });

        ws.on('close', () => {
            isAuthenticated = false;
            if (intervalHandler) clearInterval(intervalHandler);
            // Remove from active connections
            activeConnections.delete(ws);
        });

        ws.on('error', (error: Error) => {
            logger.error('WebSocket error:', error);
        });
    });

    logger.info('WebSocket server initialized.');
};

/**
 * Close all active WebSocket connections
 */
export const closeAllWebSocketConnections = (): void => {
    logger.info(`Closing ${activeConnections.size} active WebSocket connections...`);

    // Close all active connections
    for (const ws of activeConnections) {
        try {
            if (ws.readyState === WebSocket.OPEN) {
                ws.close(1000, 'Server shutting down');
            }
        } catch (error) {
            logger.error('Error closing WebSocket connection:', error);
        }
    }

    // Clear the set
    activeConnections.clear();

    // Close the WebSocket server if it exists
    if (webSocketServer) {
        try {
            webSocketServer.close();
            logger.info('WebSocket server closed');
        } catch (error) {
            logger.error('Error closing WebSocket server:', error);
        }
    }
};