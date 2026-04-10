import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import {
  createBackup,
  createInstaller,
  deleteContainerAndVolume,
  docker,
  getContainerStats,
  getContainerState,
  initContainer,
  isContainerRunning,
  killContainer,
  restoreBackup,
  sendCommandToContainer,
  startContainer,
  stopContainer,
} from "../handlers/docker";
import afs from "../handlers/fs";
import logger from "../logger";
import { getServerState, setServerState } from "../handlers/installState";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const loadJson = (filePath: string): any[] => {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, "utf-8");
    return content.trim() ? JSON.parse(content) : [];
  } catch {
    return [];
  }
};

const saveJson = (filePath: string, data: unknown): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
};

export async function handleContainerInstaller(req: Request): Promise<Response> {
  const body = await req.json() as { id?: string; script?: string; container?: string; entrypoint?: string; env?: Record<string, string> };
  if (!body.id) return json({ error: "Container ID is required." }, 400);
  if (!body.script || !body.container) return json({ error: "Script and Container are required." }, 400);
  const env = typeof body.env === "object" && body.env ? { ...body.env } : {};
  try {
    initContainer(body.id);
    await setServerState(body.id, "installing");
    await createInstaller(body.id, body.container, body.script, env, body.entrypoint || "bash");
    return json({ message: `Container ${body.id} installed successfully.` });
  } catch (error) {
    await setServerState(body.id, "failed");
    return json({ error: `Failed to install container ${body.id}.` }, 500);
  }
}

export async function handleContainerInstall(req: Request): Promise<Response> {
  const body = await req.json() as { id?: string; image?: string; scripts?: Array<{ url: string; fileName: string; ALVKT?: boolean }>; env?: Record<string, string> };
  if (!body.id) return json({ error: "Container ID is required." }, 400);
  const environmentVariables = typeof body.env === "object" && body.env ? { ...body.env } : {};

  try {
    await setServerState(body.id, "installing");
    initContainer(body.id);

    if (body.image) {
      try {
        await docker.getImage(body.image).inspect();
      } catch {
        const pullStream = await docker.pull(body.image);
        await new Promise<void>((resolve, reject) => {
          docker.modem.followProgress(pullStream, (err: Error | null) => (err ? reject(err) : resolve()));
        });
      }
    }

    if (body.scripts && Array.isArray(body.scripts)) {
      const alc = loadJson(path.join(process.cwd(), "storage/alc.json"));
      const locationsPath = path.join(process.cwd(), "storage/alc/locations.json");
      const filesDir = path.join(process.cwd(), "storage/alc/files");
      const locations = loadJson(locationsPath);

      await Promise.all(body.scripts.map(async (script) => {
        const resolvedUrl = script.url.replace(/\$ALVKT\((\w+)\)/g, (_, variableName: string) => environmentVariables[variableName] || "");
        const alcEntry = (alc as Array<{ Name: string; lasts: number }>).find((entry) => entry.Name === script.fileName);
        if (alcEntry) {
          const existingLocation = locations.find((loc: any) => loc.Name === script.fileName && loc.url === resolvedUrl);
          const cachedFilePath = existingLocation?.id ? path.join(filesDir, existingLocation.id) : "";
          if (existingLocation) {
            await afs.copy(body.id!, cachedFilePath, "/", script.fileName);
          } else {
            await afs.download(body.id!, resolvedUrl, script.fileName);
            const tempPath = await afs.getDownloadPath(body.id!, script.fileName);
            const cacheId = randomUUID();
            fs.copyFileSync(tempPath, path.join(filesDir, cacheId));
            locations.push({ Name: script.fileName, url: resolvedUrl, id: cacheId });
            saveJson(locationsPath, locations);
          }
        } else {
          await afs.download(body.id!, resolvedUrl, script.fileName, script.ALVKT === true ? environmentVariables : undefined);
        }
      }));
    }

    await setServerState(body.id, "installed");
    return json({ message: `Container ${body.id} installed successfully.` });
  } catch (error) {
    logger.error(`Error installing container ${body.id}`, error);
    await setServerState(body.id, "failed");
    return json({ error: `Failed to install container ${body.id}.` }, 500);
  }
}

export async function handleContainerInstallStatus(_req: Request, params: Record<string, string>): Promise<Response> {
  const id = params.id;
  if (!id) return json({ error: "Container ID is required." }, 400);
  const state = await getServerState(id);
  if (!state) return json({ message: `No install state found for container ${id}.` }, 404);
  return json({ containerId: id, state });
}

export async function handleContainerStart(req: Request): Promise<Response> {
  const body = await req.json() as { id?: string; image?: string; ports?: string; env?: Record<string, string>; Memory?: number; Cpu?: number; StartCommand?: string };
  if (!body.id || !body.image) return json({ error: "Container ID and Image are required." }, 400);
  const env = typeof body.env === "object" && body.env ? { ...body.env } : {};
  let startCommand = body.StartCommand ?? "";
  startCommand = startCommand.replace(/\{\{(\w+)\}\}/g, (_, name: string) => env[name] ?? "");
  startCommand = startCommand.replace(/\$ALVKT\((\w+)\)/g, (_, name: string) => env[name] ?? "");
  if (startCommand) {
    env.START = startCommand;
    env.STARTUP = startCommand;
  }
  await startContainer(body.id, body.image, env, body.ports ?? "", body.Memory ?? 0, body.Cpu ?? 0);
  return json({ message: `Container ${body.id} started successfully.` });
}

export async function handleContainerStop(req: Request): Promise<Response> {
  const body = await req.json() as { id?: string; stopCmd?: string };
  if (!body.id) return json({ error: "Container ID is required." }, 400);
  await stopContainer(body.id, body.stopCmd);
  return json({ message: `Container ${body.id} stopped successfully.` });
}

export async function handleContainerKill(req: Request): Promise<Response> {
  const body = await req.json() as { id?: string };
  if (!body.id) return json({ error: "Container ID is required." }, 400);
  await killContainer(body.id);
  return json({ message: `Container ${body.id} killed successfully.` });
}

export async function handleContainerCommand(req: Request): Promise<Response> {
  const body = await req.json() as { id?: string; command?: string };
  if (!body.id || !body.command) return json({ error: "Container ID and Command are required." }, 400);
  await sendCommandToContainer(body.id, body.command);
  return json({ message: `Command sent to container ${body.id}: ${body.command}` });
}

export async function handleContainerDelete(req: Request): Promise<Response> {
  const body = await req.json() as { id?: string };
  if (!body.id) return json({ error: "Container ID is required." }, 400);
  await deleteContainerAndVolume(body.id);
  return json({ message: `Container ${body.id} deleted successfully.` });
}

export async function handleContainerStatus(req: Request): Promise<Response> {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return json({ error: "Container ID is required." }, 400);
  const knownRunning = isContainerRunning(id);
  if (knownRunning !== null) return json({ running: knownRunning, exists: true, source: "cache" });
  const state = await getContainerState(id);
  return json({ running: state.running, exists: state.startedAt !== null, startedAt: state.startedAt });
}

export async function handleContainerStats(req: Request): Promise<Response> {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return json({ error: "Container ID is required." }, 400);
  const stats = await getContainerStats(id);
  if (!stats) return json({ running: false, exists: false });
  return json(stats);
}

export async function handleContainerBackup(req: Request): Promise<Response> {
  const body = await req.json() as { id?: string; name?: string };
  if (!body.id) return json({ error: "Container ID is required." }, 400);
  if (!body.name) return json({ error: "Backup name is required." }, 400);
  return json(await createBackup(body.id, body.name));
}

export async function handleContainerRestore(req: Request): Promise<Response> {
  const body = await req.json() as { id?: string; backupPath?: string };
  if (!body.id || !body.backupPath) return json({ error: "Backup path is required." }, 400);
  await restoreBackup(body.id, body.backupPath);
  return json({ message: "Backup restored successfully." });
}

export async function handleContainerBackupDelete(req: Request): Promise<Response> {
  const body = await req.json() as { id?: string; backupPath?: string };
  if (!body.id || !body.backupPath) return json({ error: "Backup path is required." }, 400);
  fs.rmSync(path.resolve(body.backupPath), { force: true });
  return json({ message: "Backup deleted successfully." });
}

export async function handleContainerBackupDownload(req: Request): Promise<Response> {
  const backupPath = new URL(req.url).searchParams.get("backupPath");
  if (!backupPath) return json({ error: "Backup path is required." }, 400);
  return new Response(Bun.file(path.resolve(backupPath)), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${path.basename(backupPath)}"`,
    },
  });
}
