import type { ServerWebSocket } from "bun";
import config from "../config";
import logger from "../logger";
import { validateContainerId } from "../validation";
import { sendCommandToContainer } from "../handlers/docker";
import { attachToContainer } from "./attach";
import { startStatusPolling, stopStatusPolling } from "./status";
import { subscribe } from "./events";

export type WsData = {
  route: "container" | "containerstatus" | "containerevents";
  containerId: string;
  authed: boolean;
  timer?: ReturnType<typeof setInterval>;
  unsub?: () => void;
  _logCleanup?: () => void;
};

const openConnections = new Set<ServerWebSocket<WsData>>();
const MAX_WS = 500;

export function getOpenConnections(): Set<ServerWebSocket<WsData>> {
  return openConnections;
}

export function buildWsData(req: Request): WsData | null {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const route = parts[0];
  const containerId = parts[1];
  if (!containerId || !validateContainerId(containerId)) return null;
  if (route !== "container" && route !== "containerstatus" && route !== "containerevents") return null;
  return { route, containerId, authed: false };
}

export function wsOpen(ws: ServerWebSocket<WsData>): void {
  if (openConnections.size >= MAX_WS) {
    ws.close(1013, "too many connections");
    return;
  }
  openConnections.add(ws);
  logger.debug(`ws open: ${ws.data.route}/${ws.data.containerId}`);
}

export function wsMessage(ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
  let msg: { event: string; args?: string[]; command?: string } | null = null;
  try {
    msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
  } catch {
    ws.send(JSON.stringify({ error: "invalid json" }));
    return;
  }

  if (!msg?.event) {
    ws.send(JSON.stringify({ error: "missing event field" }));
    return;
  }

  if (msg.event === "auth") {
    const key = msg.args?.[0];
    if (key !== config.key) {
      ws.send(JSON.stringify({ error: "invalid key" }));
      ws.close(1008, "auth failed");
      return;
    }
    ws.data.authed = true;
    ws.send(JSON.stringify({ event: "auth", status: "ok" }));
    if (ws.data.route === "container") {
      void attachToContainer(ws.data.containerId, ws);
    } else if (ws.data.route === "containerstatus") {
      ws.data.timer = startStatusPolling(ws.data.containerId, ws);
    } else {
      ws.data.unsub = subscribe(ws.data.containerId, (event) => {
        if (ws.readyState === 1) ws.send(JSON.stringify(event));
      });
    }
    return;
  }

  if (!ws.data.authed) {
    ws.send(JSON.stringify({ error: "not authenticated" }));
    return;
  }

  if (msg.event === "CMD") {
    if (ws.data.route !== "container") {
      ws.send(JSON.stringify({ error: "CMD only valid on /container route" }));
      return;
    }
    if (!msg.command) {
      ws.send(JSON.stringify({ error: "missing command" }));
      return;
    }
    void sendCommandToContainer(ws.data.containerId, msg.command).catch((err) => {
      logger.error(`command send failed for ${ws.data.containerId}`, err);
    });
  }
}

export function wsClose(ws: ServerWebSocket<WsData>, code: number, _reason: string): void {
  openConnections.delete(ws);
  if (ws.data.timer) stopStatusPolling(ws.data.timer);
  if (ws.data.unsub) ws.data.unsub();
  if (ws.data._logCleanup) ws.data._logCleanup();
  logger.debug(`ws closed: ${ws.data.route}/${ws.data.containerId} code=${code}`);
}
