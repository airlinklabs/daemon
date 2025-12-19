import path from "path";
import fs from "fs";

const installLogsPath = path.join(
  __dirname,
  "../../../storage/install_logs.json"
);

/**
 * Reads the current install logs from file.
 */
function readInstallLogs(): Record<string, string> {
  if (!fs.existsSync(installLogsPath)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(installLogsPath, "utf-8"));
  } catch (err) {
    console.error("Failed to read install logs:", err);
    return {};
  }
}

/**
 * Writes the install logs to file.
 */
function writeInstallLogs(logs: Record<string, string>) {
  fs.writeFileSync(installLogsPath, JSON.stringify(logs, null, 2), "utf-8");
}

/**
 * Updates the state of a specific container/server.
 * @param containerId The ID of the container/server
 * @param state The state to set ("installed", "installing", "failed", etc.)
 */
export function setServerState(containerId: string, state: string) {
  const logs = readInstallLogs();
  logs[containerId] = state;
  writeInstallLogs(logs);
}

/**
 * Gets the state of a specific container/server.
 * @param containerId The ID of the container/server
 * @returns The current state or undefined if not found
 */
export function getServerState(containerId: string): string | undefined {
  const logs = readInstallLogs();
  return logs[containerId];
}

/**
 * Gets all server install logs.
 */
export function getAllServerStates(): Record<string, string> {
  return readInstallLogs();
}

/**
 * Removes a server entry from the logs.
 * @param containerId The ID of the container/server to remove
 */
export function removeServerState(containerId: string) {
  const logs = readInstallLogs();
  if (logs[containerId]) {
    delete logs[containerId];
    writeInstallLogs(logs);
  }
}
