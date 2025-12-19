import { Router, Request, Response } from "express";
import afs from "../handlers/filesystem/fs";

import {
  initContainer,
  docker,
  getContainerStats,
} from "../handlers/instances/utils";
import { attachToContainer } from "../handlers/instances/attach";
import { startContainer, createInstaller } from "../handlers/instances/create";
import { stopContainer } from "../handlers/instances/stop";
import { killContainer } from "../handlers/instances/kill";
import { deleteContainerAndVolume } from "../handlers/instances/delete";
import { sendCommandToContainer } from "../handlers/instances/command";
import { setServerState, getServerState } from "../handlers/instances/install";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { create as tar_create, extract as tar_extract } from "tar";

const loadJson = (filePath: string) => {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const content = fs.readFileSync(filePath, "utf-8");
    return content.trim() ? JSON.parse(content) : [];
  } catch (error) {
    console.error(`Error loading JSON from ${filePath}:`, error);
    return [];
  }
};

const saveJson = (filePath: string, data: any) => {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (error) {
    console.error(`Error saving JSON to ${filePath}:`, error);
    throw error;
  }
};

const router = Router();

router.post("/container/installer", async (req: Request, res: Response) => {
  const { id, script, container, env } = req.body;

  if (!id) {
    res.status(400).json({ error: "Container ID is required." });
    return;
  }

  if (!script || !container) {
    res.status(400).json({ error: "Script and Container are required." });
    return;
  }

  let environmentVariables: Record<string, string> =
    typeof env === "object" && env !== null ? { ...env } : {};

  try {
    await initContainer(id);

    await createInstaller(id, container, script, environmentVariables);

    res
      .status(200)
      .json({ message: `Container ${id} installed successfully.` });
  } catch (error) {
    console.error(`Error installing container: ${error}`);
    res.status(500).json({ error: `Failed to install container ${id}.` });
  }
});

router.post("/container/install", async (req: Request, res: Response) => {
  const { id, scripts, env } = req.body;

  if (!id) {
    res.status(400).json({ error: "Container ID is required." });
    return;
  }

  let environmentVariables: Record<string, string> =
    typeof env === "object" && env !== null ? { ...env } : {};

  try {
    // Set state to "installing" at the start
    setServerState(id, "installing");

    await initContainer(id);

    if (scripts && Array.isArray(scripts)) {
      for (const script of scripts) {
        const { url, fileName } = script;

        if (!url || !fileName) {
          console.warn(`Invalid script entry: ${JSON.stringify(script)}`);
          continue;
        }

        // Replace ALVKT placeholders with environment variables
        const regex = /\$ALVKT\((\w+)\)/g;
        const resolvedUrl = url.replace(
          regex,
          (_: string, variableName: string) => {
            return environmentVariables[variableName] || "";
          }
        );

        if (!resolvedUrl) {
          console.warn(
            `Failed to resolve URL for script: ${JSON.stringify(script)}`
          );
          continue;
        }

        const alc = loadJson(path.join(__dirname, "../../storage/alc.json"));
        const locationsPath = path.join(
          __dirname,
          "../../storage/alc/locations.json"
        );
        const filesDir = path.join(__dirname, "../../storage/alc/files");
        const locations = loadJson(locationsPath);
        const alcEntry = (alc as { Name: string; lasts: number }[]).find(
          (entry) => entry.Name === fileName
        );

        try {
          if (alcEntry) {
            const existingLocation = locations.find(
              (loc: any) => loc.Name === fileName && loc.url === resolvedUrl
            );

            const randomNumber = Math.floor(Math.random() * 100000) + 1;
            const cachedFileId = `${fileName.replace(/\W+/g, "_")}_${
              alcEntry.lasts
            }_${randomNumber}`;
            const cachedFilePath2 = existingLocation?.id
              ? path.join(filesDir, existingLocation.id)
              : "";

            if (existingLocation) {
              console.log(
                `[CACHE] Using cached version of ${fileName} from ${resolvedUrl}`
              );
              await afs.copy(id, cachedFilePath2, "/", fileName);
            } else {
              console.log(
                `[DOWNLOAD] Caching new ${fileName} from ${resolvedUrl}`
              );
              await afs.download(id, resolvedUrl, fileName);
              const tempPath = await afs.getDownloadPath(id, fileName);
              fs.copyFileSync(tempPath, path.join(filesDir, cachedFileId));
              locations.push({
                Name: fileName,
                url: resolvedUrl,
                id: cachedFileId,
              });
              saveJson(locationsPath, locations);
            }
          } else {
            if (script.ALVKT === true) {
              await afs.download(
                id,
                resolvedUrl,
                fileName,
                environmentVariables
              );
            } else {
              await afs.download(id, resolvedUrl, fileName);
            }
          }

          console.log(
            `Downloaded ${fileName} from ${resolvedUrl} for container ${id}.`
          );
        } catch (error) {
          console.error(`Error downloading file "${fileName}": ${error}`);
          throw new Error(`Failed to download ${fileName}`);
        }
      }
    }

    // Mark container as installed in central log
    setServerState(id, "installed");

    res
      .status(200)
      .json({ message: `Container ${id} installed successfully.` });
  } catch (error) {
    console.error(`Error installing container: ${error}`);
    // Mark container as failed in central log
    setServerState(id, "failed");
    res.status(500).json({ error: `Failed to install container ${id}.` });
  }
});

router.get("/container/status/:id", (req: Request, res: Response) => {
  const { id } = req.params;

  if (!id) {
    res.status(400).json({ error: "Container ID is required." });
    return;
  }

  const state = getServerState(id);

  if (!state) {
    res
      .status(404)
      .json({ message: `No install state found for container ${id}.` });
    return;
  }

  res.status(200).json({ containerId: id, state });
});

router.post("/container/start", async (req: Request, res: Response) => {
  const { id, image, ports, env, Memory, Cpu, StartCommand } = req.body;

  console.log(req.body);

  if (!id || !image) {
    res.status(400).json({ error: "Container ID and Image are required." });
    return;
  }

  let environmentVariables: Record<string, string> =
    typeof env === "object" && env !== null ? { ...env } : {};

  const regex = /\$ALVKT\((\w+)\)/g;
  let updatedStartCommand = StartCommand;
  updatedStartCommand = updatedStartCommand.replace(
    regex,
    (_: string, variableName: string) => {
      if (environmentVariables[variableName]) {
        return environmentVariables[variableName];
      } else {
        console.warn(
          `Variable "${variableName}" not found in environmentVariables.`
        );
        return "";
      }
    }
  );

  if (updatedStartCommand) {
    environmentVariables["START"] = updatedStartCommand;
  }

  try {
    await startContainer(id, image, environmentVariables, ports, Memory, Cpu);
    res.status(200).json({ message: `Container ${id} started successfully.` });
  } catch (error) {
    console.error(`Error starting container: ${error}`);
    res.status(500).json({ error: `Failed to start container ${id}.` });
  }
});

router.post("/container/stop", async (req: Request, res: Response) => {
  const { id, stopCmd } = req.body;

  if (!id) {
    res.status(400).json({ error: "Container ID is required." });
    return;
  }

  try {
    await stopContainer(id, stopCmd);
    res.status(200).json({ message: `Container ${id} stopped successfully.` });
  } catch (error) {
    console.error(`Error stopping container: ${error}`);
    res.status(500).json({ error: `Failed to stop container ${id}.` });
  }
});

router.delete("/container/kill", async (req: Request, res: Response) => {
  const { id } = req.body;

  if (!id) {
    res.status(400).json({ error: "Container ID is required." });
    return;
  }

  try {
    await killContainer(id);
    res.status(200).json({ message: `Container ${id} killed successfully.` });
  } catch (error) {
    console.error(`Error killing container: ${error}`);
    res.status(500).json({ error: `Failed to kill container ${id}.` });
  }
});

router.post("/container/attach", async (req: Request, res: Response) => {
  const { id } = req.body;

  if (!id) {
    res.status(400).json({ error: "Container ID is required." });
    return;
  }

  try {
    attachToContainer(id);
    res.status(200).json({ message: `Attached to container ${id}.` });
  } catch (error) {
    console.error(`Error attaching to container: ${error}`);
    res.status(500).json({ error: `Failed to attach to container ${id}.` });
  }
});

router.post("/container/command", async (req: Request, res: Response) => {
  const { id, command } = req.body;

  if (!id || !command) {
    res.status(400).json({ error: "Container ID and Command are required." });
    return;
  }

  try {
    sendCommandToContainer(id, command);
    res
      .status(200)
      .json({ message: `Command sent to container ${id}: ${command}` });
  } catch (error) {
    console.error(`Error sending command to container: ${error}`);
    res
      .status(500)
      .json({ error: `Failed to send command to container ${id}.` });
  }
});

router.delete("/container", async (req: Request, res: Response) => {
  const { id } = req.body;

  if (!id) {
    res.status(400).json({ error: "Container ID is required." });
    return;
  }
  try {
    await deleteContainerAndVolume(id);
    res.status(200).json({ message: `Container ${id} deleted successfully.` });
  } catch (error) {
    console.error(`Error deleting container: ${error}`);
    res.status(500).json({ error: `Failed to delete container ${id}.` });
  }
});

router.get("/container/status", async (req: Request, res: Response) => {
  const id = req.query.id as string;

  if (!id) {
    res.status(400).json({ error: "Container ID is required." });
    return;
  }

  try {
    const container = docker.getContainer(id);
    const containerInfo = await container.inspect().catch(() => null);

    if (!containerInfo) {
      res.status(200).json({ running: false, exists: false });
      return;
    }

    res.status(200).json({
      running: containerInfo.State.Running,
      exists: true,
      status: containerInfo.State.Status,
      startedAt: containerInfo.State.StartedAt,
      finishedAt: containerInfo.State.FinishedAt,
    });
  } catch (error) {
    console.error(`Error getting container status: ${error}`);
    res
      .status(500)
      .json({ error: `Failed to get status for container ${id}.` });
  }
});

router.get("/container/stats", async (req: Request, res: Response) => {
  const id = req.query.id as string;

  if (!id) {
    res.status(400).json({ error: "Container ID is required." });
    return;
  }

  try {
    const stats = await getContainerStats(id);

    if (!stats) {
      res.status(200).json({ running: false, exists: false });
      return;
    }

    res.status(200).json(stats);
  } catch (error) {
    console.error(`Error getting container stats: ${error}`);
    res.status(500).json({ error: `Failed to get stats for container ${id}.` });
  }
});

router.post("/container/backup", async (req: Request, res: Response) => {
  const { id, name } = req.body;

  if (!id) {
    res.status(400).json({ error: "Container ID is required." });
    return;
  }

  if (!name) {
    res.status(400).json({ error: "Backup name is required." });
    return;
  }

  try {
    const volumePath = path.resolve(`volumes/${id}`);

    if (!fs.existsSync(volumePath)) {
      res.status(404).json({ error: "Container volume not found." });
      return;
    }

    const backupsDir = path.resolve("backups", id);
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }

    const backupUuid = uuidv4();
    const backupFileName = `${backupUuid}.tar.gz`;
    const backupPath = path.join(backupsDir, backupFileName);

    console.log(`Creating backup for container ${id} at ${backupPath}`);

    await tar_create(
      {
        gzip: true,
        file: backupPath,
        cwd: volumePath,
        filter: (filePath) => {
          let normalizedPath = filePath.split(path.sep).join("/");
          if (normalizedPath.startsWith("./")) {
            normalizedPath = normalizedPath.slice(2);
          }
          return !(
            normalizedPath === "node_modules" ||
            normalizedPath.endsWith("/node_modules") ||
            normalizedPath.includes("/node_modules/")
          );
        },
      },
      ["."]
    );

    const stats = fs.statSync(backupPath);
    const fileSizeInBytes = stats.size;

    console.log(
      `Backup created successfully: ${backupPath} (${fileSizeInBytes} bytes)`
    );

    res.status(200).json({
      success: true,
      message: "Backup created successfully",
      backup: {
        uuid: backupUuid,
        name: name,
        filePath: `backups/${id}/${backupFileName}`,
        size: fileSizeInBytes,
        createdAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error(`Error creating backup for container ${id}:`, error);
    res.status(500).json({
      error: `Failed to create backup: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    });
  }
});

router.post("/container/restore", async (req: Request, res: Response) => {
  const { id, backupPath } = req.body;

  if (!id) {
    res.status(400).json({ error: "Container ID is required." });
    return;
  }

  if (!backupPath) {
    res.status(400).json({ error: "Backup path is required." });
    return;
  }

  try {
    const fullBackupPath = path.resolve(backupPath);

    if (!fs.existsSync(fullBackupPath)) {
      res.status(404).json({ error: "Backup file not found." });
      return;
    }

    const volumePath = path.resolve(`volumes/${id}`);

    try {
      const container = docker.getContainer(id);
      const containerInfo = await container.inspect().catch(() => null);
      if (containerInfo && containerInfo.State.Running) {
        console.log(`Stopping container ${id} for restore...`);
        await stopContainer(id);
      }
    } catch (error) {
      console.warn(`Could not stop container ${id}:`, error);
    }

    if (fs.existsSync(volumePath)) {
      fs.rmSync(volumePath, { recursive: true, force: true });
    }
    fs.mkdirSync(volumePath, { recursive: true });

    console.log(`Restoring backup from ${fullBackupPath} to ${volumePath}`);

    await tar_extract({
      file: fullBackupPath,
      cwd: volumePath,
    });

    console.log(`Backup restored successfully to container ${id}`);

    res.status(200).json({
      success: true,
      message: "Backup restored successfully",
    });
  } catch (error) {
    console.error(`Error restoring backup for container ${id}:`, error);
    res.status(500).json({
      error: `Failed to restore backup: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    });
  }
});

router.delete("/container/backup", async (req: Request, res: Response) => {
  const { backupPath } = req.body;

  if (!backupPath) {
    res.status(400).json({ error: "Backup path is required." });
    return;
  }

  try {
    const fullBackupPath = path.resolve(backupPath);

    if (!fs.existsSync(fullBackupPath)) {
      res.status(404).json({ error: "Backup file not found." });
      return;
    }

    fs.unlinkSync(fullBackupPath);
    console.log(`Backup file deleted: ${fullBackupPath}`);

    res.status(200).json({
      success: true,
      message: "Backup deleted successfully",
    });
  } catch (error) {
    console.error(`Error deleting backup:`, error);
    res.status(500).json({
      error: `Failed to delete backup: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    });
  }
});

router.get(
  "/container/backup/download",
  async (req: Request, res: Response) => {
    const { backupPath } = req.query;

    if (!backupPath || typeof backupPath !== "string") {
      res.status(400).json({ error: "Backup path is required." });
      return;
    }

    try {
      const fullBackupPath = path.resolve(backupPath);

      if (!fs.existsSync(fullBackupPath)) {
        res.status(404).json({ error: "Backup file not found." });
        return;
      }

      const fileName = path.basename(fullBackupPath);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${fileName}"`
      );
      res.setHeader("Content-Type", "application/gzip");

      const fileStream = fs.createReadStream(fullBackupPath);
      fileStream.pipe(res);

      fileStream.on("error", (error) => {
        console.error("Error streaming backup file:", error);
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to download backup file" });
        }
      });
    } catch (error) {
      console.error(`Error downloading backup:`, error);
      res.status(500).json({
        error: `Failed to download backup: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      });
    }
  }
);

export default router;
