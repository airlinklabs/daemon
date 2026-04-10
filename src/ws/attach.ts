import type { ServerWebSocket } from "bun";
import type { WsData } from "./server";
import { docker } from "../handlers/docker";
import logger from "../logger";

export async function attachToContainer(id: string, ws: ServerWebSocket<WsData>): Promise<void> {
  try {
    const container = docker.getContainer(id);
    const logStream = await container.logs({ follow: true, stdout: true, stderr: true, tail: 100 });
    logStream.on("data", (chunk: Buffer) => {
      if (ws.readyState === 1) ws.send(chunk);
    });
    logStream.on("error", (err: Error) => logger.error(`log stream error for ${id}`, err));
    logStream.on("end", () => {
      if (ws.readyState === 1) ws.close(1000, "stream ended");
    });
    ws.data._logCleanup = () => {
      try {
        (logStream as { destroy?: () => void }).destroy?.();
      } catch {}
    };
  } catch (err) {
    logger.debug(`attach skipped for ${id}`, err);
    if (ws.readyState === 1) ws.close(1000, "container not available");
  }
}
