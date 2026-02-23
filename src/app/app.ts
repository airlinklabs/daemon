import http from "http";
import express, { Application } from "express";
import compression from "compression";
import bodyParser from "body-parser";
import config from "../utils/config";
import { registerRoutes } from "./routes";
import { basicAuthMiddleware, logLoginAttempts } from "./middleware";
import { errorHandler } from "../utils/errorHandler";
import { initializeWebSocketServer, closeAllWebSocketConnections } from "../handlers/instances/initializeWebSocket";
import { init } from "./init";
import { initLogger } from '../handlers/stats';
import logger from '../utils/logger';
import { docker } from '../handlers/instances/utils';
import { saveStats } from '../handlers/stats';
import { startSftpServer } from '../handlers/sftp/sftpServer';

const app: Application = express();
const server = http.createServer(app);

// Handle graceful shutdown
let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  logger.info(`Received ${signal}. Starting graceful shutdown...`);

  try {
    // Close all WebSocket connections
    logger.info('Closing WebSocket connections...');
    closeAllWebSocketConnections();

    // Save current stats before shutdown
    logger.info('Saving system stats...');
    try {
      const finalStats = await import('../handlers/stats').then(m => m.getCurrentStats());
      saveStats(finalStats);
    } catch (statsError) {
      logger.error('Error saving final stats:', statsError);
    }

    // Close HTTP server
    logger.info('Closing HTTP server...');
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    // Disconnect from Docker
    logger.info('Disconnecting from Docker...');
    try {
      await docker.ping();
      logger.info('Docker connection is active, disconnecting...');
      // No explicit disconnect method in dockerode, but we can ensure no new connections are made
    } catch (dockerError) {
      logger.warn('Docker connection already closed or unavailable');
    }

    logger.success('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during graceful shutdown:', error);
    process.exit(1);
  }
}

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

// Handle uncaught exceptions and unhandled rejections
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection', `Promise: ${promise}, Reason: ${reason}`);
});

(async () => {
  try {
    initLogger();
    await init();
    
    app.use(bodyParser.json({
      limit: '100mb'
    }));
    app.use(bodyParser.urlencoded({
      limit: '100mb',
      parameterLimit: 100000,
      extended: true
    }));
    app.use(bodyParser.raw({
      limit: '100mb',
      type: 'application/octet-stream'
    }));
    app.use(bodyParser.text({
      limit: '100mb'
    }));
    app.use(compression());
    app.use(basicAuthMiddleware);
    app.use(logLoginAttempts);

    registerRoutes(app);

    app.use(errorHandler);

    initializeWebSocketServer(server);

    const { port } = config;
    setTimeout(() => {
      server.listen(port, () => {
        logger.info(`Daemon is running on port ${port}`);
      }); 
    }, 1000);
    // sftp port
    const sftpPort = config.port + 1;
    startSftpServer(sftpPort);
    
  } catch (error) {
    logger.error("Failed to start the server:", error);
    process.exit(1);
  }
})();
