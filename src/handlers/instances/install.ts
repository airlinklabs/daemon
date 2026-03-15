import path from "path";
import fs from "fs";
import logger from "../../utils/logger";

const installLogsPath = path.join(__dirname, "../../../storage/install_logs.json");

function readInstallLogs(): Record<string, string> {
  if (!fs.existsSync(installLogsPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(installLogsPath, "utf-8"));
  } catch {
    return {};
  }
}

function writeInstallLogs(logs: Record<string, string>): void {
  fs.writeFileSync(installLogsPath, JSON.stringify(logs, null, 2), "utf-8");
}

export function setServerState(containerId: string, state: string): void {
  const logs = readInstallLogs();
  logs[containerId] = state;
  writeInstallLogs(logs);
}

export function getServerState(containerId: string): string | undefined {
  return readInstallLogs()[containerId];
}

export function getAllServerStates(): Record<string, string> {
  return readInstallLogs();
}

export function removeServerState(containerId: string): void {
  const logs = readInstallLogs();
  if (logs[containerId]) {
    delete logs[containerId];
    writeInstallLogs(logs);
  }
}
