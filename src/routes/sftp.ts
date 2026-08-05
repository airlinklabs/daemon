import { apiError } from '../errors';
import {
  generateCredential,
  getActiveSessionCount,
  getSftpActivity,
  revokeCredentialForContainer,
} from '../handlers/sftp';
import logger from '../logger';
import { parseJsonBody, sftpBodyCodes, sftpBodySchema } from '../schemas';
import { validateContainerId } from '../validation';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleSftpCreate(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, sftpBodySchema, sftpBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id } = parsed.data;

  try {
    const cred = await generateCredential(id);
    return json({
      username: cred.username,
      password: cred.password,
      host: cred.host,
      port: cred.port,
      expiresAt: cred.expiresAt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'failed to generate SFTP credentials';
    logger.error(`SFTP credential generation failed for ${id}`, err);
    return apiError('internal_error', msg, 500);
  }
}

export async function handleSftpRevoke(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, sftpBodySchema, sftpBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id } = parsed.data;

  try {
    await revokeCredentialForContainer(id);
    return json({ message: 'SFTP credentials revoked' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'failed to revoke SFTP credentials';
    logger.error(`SFTP credential revocation failed for ${id}`, err);
    return apiError('internal_error', msg, 500);
  }
}

export function handleSftpStatus(_req: Request): Response {
  return new Response(JSON.stringify({ activeSessions: getActiveSessionCount() }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export function handleSftpActivity(req: Request): Response {
  const url = new URL(req.url);
  const id = url.searchParams.get('server');
  if (!id || !validateContainerId(id)) {
    return apiError('container_not_found', 'valid container ID is required', 400);
  }

  const events = getSftpActivity(id);
  return json({ events });
}
