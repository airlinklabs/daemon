import { join } from 'node:path';

const logsPath = join(process.cwd(), 'storage/install_logs.json');

export interface InstallStatus {
  state: string;
  error?: string;
}

async function readState(): Promise<Record<string, InstallStatus>> {
  try {
    const file = Bun.file(logsPath);
    const text = await file.text();
    const parsed = JSON.parse(text);
    const entries = Object.entries(parsed).map(([id, value]) => {
      if (value && typeof value === 'object') {
        return [id, value] as [string, InstallStatus];
      }
      // legacy flat string format
      return [id, { state: String(value) }] as [string, InstallStatus];
    });
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

async function writeState(data: Record<string, InstallStatus>): Promise<void> {
  await Bun.write(logsPath, JSON.stringify(data, null, 2));
}

export async function setServerState(containerId: string, state: string, error?: string): Promise<void> {
  const logs = await readState();
  logs[containerId] = error ? { state, error } : { state };
  await writeState(logs);
}

export async function getServerState(containerId: string): Promise<string | undefined> {
  const logs = await readState();
  return logs[containerId]?.state;
}

export async function getInstallStatus(containerId: string): Promise<InstallStatus | undefined> {
  const logs = await readState();
  return logs[containerId];
}

export async function getAllServerStates(): Promise<Record<string, string>> {
  const logs = await readState();
  return Object.fromEntries(Object.entries(logs).map(([id, s]) => [id, s.state]));
}

export async function removeServerState(containerId: string): Promise<void> {
  const logs = await readState();
  if (logs[containerId]) {
    delete logs[containerId];
    await writeState(logs);
  }
}
