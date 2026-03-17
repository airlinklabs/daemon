import { Request, Response, NextFunction } from "express";
import basicAuth from "express-basic-auth";
import config from "../utils/config";
import logger from "../utils/logger";

export const basicAuthMiddleware = basicAuth({
    users: {
      Airlink: config.key,
    },
    challenge: true,
});

// Optional IP allowlist — set ALLOWED_IPS=1.2.3.4,5.6.7.8 in the daemon env
// to restrict which IPs can reach the daemon. Leave unset to allow all.
export const ipAllowlistMiddleware = (req: Request, res: Response, next: NextFunction) => {
    const raw = process.env.ALLOWED_IPS;
    if (!raw) return next();

    const allowed = raw.split(",").map(s => s.trim()).filter(Boolean);
    if (allowed.length === 0) return next();

    const clientIp = req.ip || req.socket.remoteAddress || "";
    const normalised = clientIp.replace(/^::ffff:/, "");

    if (allowed.includes(normalised)) return next();

    logger.warn(`Blocked connection from ${normalised} — not in ALLOWED_IPS`);
    res.status(403).json({ error: "Access denied" });
};

export const logLoginAttempts = (req: Request, res: Response, next: () => void) => {
    const authorizationHeader = req.headers.authorization;

    if (config.DEBUG) {
      if (authorizationHeader) {
        const base64Credentials = authorizationHeader.split(" ")[1];
        const credentials = Buffer.from(base64Credentials, "base64").toString("ascii");
        const [username] = credentials.split(":");
        logger.debug(`Login attempt: Username = ${username}, Password = [REDACTED]`);
      } else {
        logger.debug("Login attempt: No Authorization header provided");
      }
    }

    next();
};
