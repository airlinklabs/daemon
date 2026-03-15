import express from "express";
import path from "path";
import fs from "fs";
import logger from "../utils/logger";

export function registerRoutes(app: express.Application): void {
  const routesDir = path.join(__dirname, "../routes");

  fs.readdirSync(routesDir)
    .filter((file) => file.endsWith(".js"))
    .forEach((file) => {
      try {
        const { default: router } = require(path.join(routesDir, file));
        if (typeof router === "function") {
          app.use("/", router);
        }
      } catch (error) {
        logger.error(`Error loading router ${file}:`, error as Error);
        process.exit(1);
      }
    });
}
