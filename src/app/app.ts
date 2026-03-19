import http from "http";
import express, { Application, Request, Response, NextFunction } from "express";
import compression from "compression";
import bodyParser from "body-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import config from "../utils/config";
import { registerRoutes } from "./routes";
import { basicAuthMiddleware, logLoginAttempts, ipAllowlistMiddleware } from "./middleware";
import { hmacVerificationMiddleware } from "./hmacMiddleware";
import { errorHandler } from "../utils/errorHandler";
import { initializeWebSocketServer, closeAllWebSocketConnections } from "../handlers/instances/initializeWebSocket";
import { init } from "./init";
import { initLogger, getCurrentStats, saveStats } from '../handlers/stats';
import logger from '../utils/logger';

const app: Application = express();
const server = http.createServer(app);

// Handle graceful shutdown
let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  logger.debug(`Received ${signal}. Starting graceful shutdown...`);

  try {
    // Close all WebSocket connections
    logger.debug('Closing WebSocket connections...');
    closeAllWebSocketConnections();

    // Save current stats before shutdown
    logger.debug('Saving system stats...');
    try {
      const finalStats = await getCurrentStats();
      saveStats(finalStats);
    } catch (statsError) {
      logger.error('Error saving final stats:', statsError);
    }

    // Close HTTP server
    logger.debug('Closing HTTP server...');
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    logger.debug('Graceful shutdown completed');
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
    await (await import('../handlers/instances/containerState')).initContainerStateMap();
    
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

    // Security headers — daemon is an internal API but defence-in-depth still matters
    app.use(helmet({
      contentSecurityPolicy: false, // not serving HTML
      crossOriginEmbedderPolicy: false,
    }));

    // Reject requests that don't carry the basic-auth header at all before
    // they touch any route logic — cuts down on noise from scanners
    // IP allowlist runs first — rejects non-whitelisted IPs before any auth logic
    app.use(ipAllowlistMiddleware);
    app.use(basicAuthMiddleware);
    app.use(logLoginAttempts);
    app.use(hmacVerificationMiddleware);

    // Conservative rate limit — the panel is the only legitimate caller,
    // so 300 req/min per IP is generous and still blocks brute force
    app.use(rateLimit({
      windowMs: 60 * 1000,
      max: 300,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many requests' },
    }));

    // Block requests with a content-type we don't handle
    app.use((req: Request, res: Response, next: NextFunction) => {
      const ct = req.headers['content-type'] || '';
      if (req.method !== 'GET' && req.method !== 'DELETE' &&
          ct && !ct.startsWith('application/json') &&
          !ct.startsWith('application/octet-stream') &&
          !ct.startsWith('text/') &&
          !ct.startsWith('multipart/')) {
        res.status(415).json({ error: 'Unsupported media type' });
        return;
      }
      next();
    });

    await registerRoutes(app);

    app.use(errorHandler);

    initializeWebSocketServer(server);

    const { port } = config;
    setTimeout(() => {
      server.listen(port, () => {
        logger.info(`Daemon is running on port ${port}`);
      });
    }, 1000);
  } catch (error) {
    logger.error("Failed to start the server:", error);
    process.exit(1);
  }
})();
