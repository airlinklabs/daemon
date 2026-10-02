import express from "express";
import path from "path";
import fs from "fs";
import logger from "../utils/logger";

export async function registerRoutes(app: express.Application): Promise<void> {
  const routesDir = path.join(__dirname, "../routes");

  const files = fs.readdirSync(routesDir).filter((file) => {
    // Support ts-node dev runtime (.ts) and compiled runtime (.js) without
    // loading declaration maps or source maps.
    if (file.endsWith(".d.ts") || file.endsWith(".map")) {
      return false;
    }
    return file.endsWith(".ts") || file.endsWith(".js");
  });

  for (const file of files) {
    try {
      const mod = await import(path.join(routesDir, file));
      const router = mod.default;
      if (typeof router === "function") {
        app.use("/", router);
      }
    } catch (error) {
      logger.error(`Error loading router ${file}:`, error as Error);
      process.exit(1);
    }
  }
}
