import { join } from 'node:path';

const logsPath = join(process.cwd(), 'storage/install_logs.json');

async function readState(): Promise<Record<string, string>> {
  try {
    const file = Bun.file(logsPath);
    const text = await file.text();
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function writeState(data: Record<string, string>): Promise<void> {
  await Bun.write(logsPath, JSON.stringify(data, null, 2));
}

export async function setServerState(containerId: string, state: string): Promise<void> {
  const logs = await readState();
  logs[containerId] = state;
  await writeState(logs);
}

export async function getServerState(containerId: string): Promise<string | undefined> {
  const logs = await readState();
  return logs[containerId];
}

export async function getAllServerStates(): Promise<Record<string, string>> {
  return readState();
}

export async function removeServerState(containerId: string): Promise<void> {
  const logs = await readState();
  if (logs[containerId]) {
    delete logs[containerId];
    await writeState(logs);
  }
}
