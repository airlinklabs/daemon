import { existsSync } from "node:fs";
import {
  getLogBuffer,
  getLogHistory,
  listLogArchives,
  readLogArchive,
  resolveLogArchivePath,
} from "../handlers/logHistory";
import logger from "../logger";
import { createDownloadToken } from "../security/downloadTokens";
import {
  apiError,
  json,
  logArchiveDownloadBodyCodes,
  logArchiveDownloadBodySchema,
  parseJsonBody,
  validateContainerId,
} from "./instancesShared";

export async function handleContainerLogs(
  _req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const { id } = params;
  if (!id)
    return apiError("container_not_found", "container ID is required", 400);
  if (!validateContainerId(id))
    return apiError("container_not_found", "invalid container ID", 400);
  const t0 = performance.now();
  const lines = getLogBuffer(id);
  logger.info(
    `log buffer served for container ${id}: ${lines.length} lines in ${(performance.now() - t0).toFixed(1)}ms`,
  );
  return json({ lines });
}

export async function handleContainerLogHistory(
  req: Request,
): Promise<Response> {
  const id = new URL(req.url).searchParams.get("id");
  if (!id)
    return apiError("container_not_found", "container ID is required", 400);
  if (!validateContainerId(id))
    return apiError("container_not_found", "invalid container ID", 400);
  const t0 = performance.now();
  const logs = await getLogHistory(id);
  logger.info(
    `log history served for container ${id}: ${logs.length} entries in ${(performance.now() - t0).toFixed(1)}ms`,
  );
  return json({ containerId: id, logs });
}

export async function handleContainerLogArchives(
  req: Request,
): Promise<Response> {
  const id = new URL(req.url).searchParams.get("id");
  if (!id)
    return apiError("container_not_found", "container ID is required", 400);
  if (!validateContainerId(id))
    return apiError("container_not_found", "invalid container ID", 400);
  const archives = await listLogArchives(id);
  logger.info(
    `log archives listed for container ${id}: ${archives.length} archives`,
  );
  return json({ logs: archives });
}

export async function handleContainerLogArchiveRead(
  req: Request,
): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const id = params.get("id");
  const file = params.get("file");
  if (!id)
    return apiError("container_not_found", "container ID is required", 400);
  if (!validateContainerId(id))
    return apiError("container_not_found", "invalid container ID", 400);
  if (!file) return apiError("invalid_request", "file is required", 400);
  const t0 = performance.now();
  const lines = await readLogArchive(id, file);
  if (!lines) {
    logger.warn(
      `log archive read failed for container ${id}: file ${file} not found`,
    );
    return apiError("not_found", "log archive not found", 404);
  }
  logger.info(
    `log archive read for container ${id}: file=${file} lines=${lines.length} in ${(performance.now() - t0).toFixed(1)}ms`,
  );
  return json({ lines });
}

function safeFileName(name: string): string {
  return name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
}

export async function handleContainerLogArchiveDownload(
  req: Request,
): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const id = params.get("id");
  const file = params.get("file");
  if (!id)
    return apiError("container_not_found", "container ID is required", 400);
  if (!validateContainerId(id))
    return apiError("container_not_found", "invalid container ID", 400);
  if (!file) return apiError("invalid_request", "file is required", 400);
  const archivePath = resolveLogArchivePath(id, file);
  if (!archivePath) {
    logger.warn(
      `log archive download failed for container ${id}: path not found for ${file}`,
    );
    return apiError("not_found", "log archive not found", 404);
  }
  if (!existsSync(archivePath)) {
    logger.warn(
      `log archive download failed for container ${id}: file ${file} missing on disk`,
    );
    return apiError("not_found", "log archive not found", 404);
  }
  logger.info(`log archive download for container ${id}: file=${file}`);
  return new Response(Bun.file(archivePath), {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${safeFileName(file)}"`,
    },
  });
}

export async function handleContainerLogArchiveDownloadToken(
  req: Request,
): Promise<Response> {
  const parsed = await parseJsonBody(
    req,
    logArchiveDownloadBodySchema,
    logArchiveDownloadBodyCodes,
  );
  if ("response" in parsed) return parsed.response;
  const { id, file } = parsed.data;

  if (!id)
    return apiError("container_not_found", "container ID is required", 400);
  if (!validateContainerId(id))
    return apiError("container_not_found", "invalid container ID", 400);
  if (!file) return apiError("invalid_request", "file is required", 400);

  const archivePath = resolveLogArchivePath(id, file);
  if (!archivePath || !existsSync(archivePath)) {
    logger.warn(
      `download token failed for container ${id}: archive ${file} not found`,
    );
    return apiError("not_found", "log archive not found", 404);
  }

  const token = createDownloadToken({
    filePath: archivePath,
    fileName: file,
    contentType: "application/gzip",
    disposition: "attachment",
  });

  logger.info(`download token created for container ${id}: file=${file}`);
  return json({ token, url: `/dl/${token}` });
}
