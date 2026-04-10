const installLogsPath = `${process.cwd()}/storage/install_logs.json`;

async function readState(): Promise<Record<string, string>> {
  try {
    const text = await Bun.file(installLogsPath).text();
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function writeState(data: Record<string, string>): Promise<void> {
  await Bun.write(installLogsPath, JSON.stringify(data, null, 2));
}

export async function setServerState(containerId: string, state: string): Promise<void> {
  const logs = await readState();
  logs[containerId] = state;
  await writeState(logs);
}

export async function getServerState(containerId: string): Promise<string | undefined> {
  return (await readState())[containerId];
}

export async function removeServerState(containerId: string): Promise<void> {
  const logs = await readState();
  delete logs[containerId];
  await writeState(logs);
}
