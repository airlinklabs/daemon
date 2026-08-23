import { apiError } from '../errors';
import { unzipPath, zipPaths } from '../handlers/fs';
import logger from '../logger';
import {
  fsUnzipBodyCodes,
  fsUnzipBodySchema,
  fsZipBodyCodes,
  fsZipBodySchema,
  parseJsonBody,
} from '../schemas';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleFsZip(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, fsZipBodySchema, fsZipBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id, path, zipname } = parsed.data;

  const paths = Array.isArray(path) ? path : [path ?? '/'];

  try {
    const zipPath = await zipPaths(id, paths, zipname ?? 'archive');
    return json({ message: 'archive created', zipPath });
  } catch (err) {
    logger.error(`failed to create archive for container ${id}`, err);
    return apiError('internal_error', 'failed to create archive', 500);
  }
}

export async function handleFsUnzip(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, fsUnzipBodySchema, fsUnzipBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id, path, zipname } = parsed.data;

  try {
    await unzipPath(id, path ?? '/', zipname ?? '');
    return json({ message: 'file successfully unzipped' });
  } catch (err) {
    logger.error(`failed to extract archive for container ${id}`, err);
    return apiError('internal_error', 'failed to extract archive', 500);
  }
}
