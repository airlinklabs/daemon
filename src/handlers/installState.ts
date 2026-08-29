import { existsSync } from "node:fs";
import { join } from "node:path";
import config from "../config";
import logger from "../logger";
import { getPaths } from "../paths";

const defaultLogsPath = join(
  getPaths(config.paths).storageRoot,
  "install_logs.json",
);
let logsPath = defaultLogsPath;

// Test-only seam: lets unit tests point the state file at a writable temp path
// instead of the daemon's real state file (which the test user may not own).
export function setInstallStateFileForTest(path: string): void {
  logsPath = path;
}

export type InstallStateName =
  "installing" | "reinstalling" | "installed" | "failed";

export interface InstallStatus {
  state: string;
  error?: string;
}

// Legal state transitions — a container cannot jump between arbitrary states.
const LEGAL_TRANSITIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  installing: new Set(["installed", "failed", "reinstalling"]),
  reinstalling: new Set(["installed", "failed"]),
  installed: new Set(["reinstalling"]),
  failed: new Set(["installing", "reinstalling"]),
};

export function isValidStateTransition(
  from: string | undefined,
  to: string,
): boolean {
  // Same-state rewrites (double-clicked install button, error handler that
  // re-records the same failure) are idempotent no-ops, not contradictions.
  if (from === to) return true;
  // First-ever write: any install-lifecycle state is a valid starting point.
  if (from === undefined) return true;
  return LEGAL_TRANSITIONS[from]?.has(to) ?? false;
}

async function readState(): Promise<Record<string, InstallStatus>> {
  // First boot: no state file yet, return empty map.
  if (!existsSync(logsPath)) return {};

  let text: string;
  try {
    text = await Bun.file(logsPath).text();
  } catch (err) {
    logger.warn(
      `could not read install state file ${logsPath}: ${String(err)}`,
    );
    return {};
  }

  try {
    const parsed = JSON.parse(text);
    const entries = Object.entries(parsed).map(([id, value]) => {
      if (value && typeof value === "object") {
        return [id, value] as [string, InstallStatus];
      }
      // legacy flat string format
      return [id, { state: String(value) }] as [string, InstallStatus];
    });
    return Object.fromEntries(entries);
  } catch (err) {
    logger.warn(
      `install state file ${logsPath} is malformed, treating as empty: ${String(err)}`,
    );
    return {};
  }
}

async function writeState(data: Record<string, InstallStatus>): Promise<void> {
  await Bun.write(logsPath, JSON.stringify(data, null, 2));
}

// Serialize writes through a promise chain to prevent races.
let writeChain: Promise<void> = Promise.resolve();

export async function setServerState(
  containerId: string,
  state: string,
  error?: string,
): Promise<void> {
  // Capture errors from the chain without rejecting it.
  let thrownError: Error | undefined;
  writeChain = writeChain
    .catch(() => {}) // recover from prior chain errors
    .then(async () => {
      const logs = await readState();
      const current = logs[containerId]?.state;

      if (!isValidStateTransition(current, state)) {
        const message = `refusing invalid install state transition ${current ?? "(none)"} -> ${state} for ${containerId}`;
        logger.error(message);
        thrownError = new Error(message);
        return;
      }

      logs[containerId] = error ? { state, error } : { state };
      await writeState(logs);
    });
  await writeChain;
  if (thrownError) throw thrownError;
}

export async function getServerState(
  containerId: string,
): Promise<string | undefined> {
  const logs = await readState();
  return logs[containerId]?.state;
}

export async function getInstallStatus(
  containerId: string,
): Promise<InstallStatus | undefined> {
  const logs = await readState();
  return logs[containerId];
}

export async function getAllServerStates(): Promise<Record<string, string>> {
  const logs = await readState();
  return Object.fromEntries(
    Object.entries(logs).map(([id, s]) => [id, s.state]),
  );
}

export async function removeServerState(containerId: string): Promise<void> {
  const logs = await readState();
  if (logs[containerId]) {
    delete logs[containerId];
    await writeState(logs);
  }
}
