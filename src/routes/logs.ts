import { existsSync } from 'node:fs';
import {
  clearLogBuffer,
  getLogBuffer,
  getLogHistory,
  listLogArchives,
  readLogArchive,
  resolveLogArchivePath,
} from '../handlers/logHistory';
import { createDownloadToken } from '../security/downloadTokens';
import {
  apiError,
  json,
  logArchiveDownloadBodyCodes,
  logArchiveDownloadBodySchema,
  logger,
  parseJsonBody,
  validateContainerId,
} from './instancesShared';

export async function handleContainerLogs(_req: Request, params: Record<string, string>): Promise<Response> {
  const { id } = params;
  if (!id) return apiError('container_not_found', 'container ID is required', 400);
  if (!validateContainerId(id)) return apiError('container_not_found', 'invalid container ID', 400);
  return json({ lines: getLogBuffer(id) });
}

export async function handleContainerLogHistory(req: Request): Promise<Response> {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return apiError('container_not_found', 'container ID is required', 400);
  if (!validateContainerId(id)) return apiError('container_not_found', 'invalid container ID', 400);
  const logs = await getLogHistory(id);
  return json({ containerId: id, logs });
}

export async function handleContainerLogArchives(req: Request): Promise<Response> {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return apiError('container_not_found', 'container ID is required', 400);
  if (!validateContainerId(id)) return apiError('container_not_found', 'invalid container ID', 400);
  return json({ logs: await listLogArchives(id) });
}

export async function handleContainerLogArchiveRead(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const id = params.get('id');
  const file = params.get('file');
  if (!id) return apiError('container_not_found', 'container ID is required', 400);
  if (!validateContainerId(id)) return apiError('container_not_found', 'invalid container ID', 400);
  if (!file) return apiError('invalid_request', 'file is required', 400);
  const lines = await readLogArchive(id, file);
  if (!lines) return apiError('not_found', 'log archive not found', 404);
  return json({ lines });
}

export async function handleContainerLogArchiveDownload(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const id = params.get('id');
  const file = params.get('file');
  if (!id) return apiError('container_not_found', 'container ID is required', 400);
  if (!validateContainerId(id)) return apiError('container_not_found', 'invalid container ID', 400);
  if (!file) return apiError('invalid_request', 'file is required', 400);
  const archivePath = resolveLogArchivePath(id, file);
  if (!archivePath) return apiError('not_found', 'log archive not found', 404);
  if (!existsSync(archivePath)) return apiError('not_found', 'log archive not found', 404);
  return new Response(Bun.file(archivePath), {
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${file}"`,
    },
  });
}

export async function handleContainerLogArchiveDownloadToken(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, logArchiveDownloadBodySchema, logArchiveDownloadBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id, file } = parsed.data;

  if (!id) return apiError('container_not_found', 'container ID is required', 400);
  if (!validateContainerId(id)) return apiError('container_not_found', 'invalid container ID', 400);
  if (!file) return apiError('invalid_request', 'file is required', 400);

  const archivePath = resolveLogArchivePath(id, file);
  if (!archivePath || !existsSync(archivePath)) return apiError('not_found', 'log archive not found', 404);

  const token = createDownloadToken({
    filePath: archivePath,
    fileName: file,
    contentType: 'application/gzip',
    disposition: 'attachment',
  });

  return json({ token, url: `/dl/${token}` });
}
