import { scanVolume } from '../handlers/radar/scan';
import { zipScanVolume } from '../handlers/radar/zip';
import { validateContainerId } from '../validation';
import logger from '../logger';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleRadarScan(req: Request): Promise<Response> {
  let body: { id?: string; script?: unknown };
  try { body = await req.json() as typeof body; } catch { return json({ error: 'invalid json body' }, 400); }
  if (!body.id || !body.script) return json({ error: 'container ID and script are required' }, 400);
  if (!validateContainerId(body.id)) return json({ error: 'invalid container ID format' }, 400);

  try {
    logger.info(`received radar scan request for container ${body.id}`);
    const results = await scanVolume(body.id, body.script as Parameters<typeof scanVolume>[1]);
    return json({ success: true, message: `scan completed for container ${body.id}`, results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`error scanning container ${body.id}`, err);
    return json({ success: false, error: `failed to scan container: ${msg}` }, 500);
  }
}

export async function handleRadarZip(req: Request): Promise<Response> {
  let body: { id?: string; include?: unknown; exclude?: unknown; maxFileSizeMb?: unknown };
  try { body = await req.json() as typeof body; } catch { return json({ error: 'invalid json body' }, 400); }
  if (!body.id || typeof body.id !== 'string') return json({ error: 'container ID is required' }, 400);
  if (!validateContainerId(body.id)) return json({ error: 'invalid container ID format' }, 400);

  const folderPattern = /^[a-zA-Z0-9_\-\.]+$/;

  if (body.include !== undefined) {
    if (!Array.isArray(body.include) || body.include.some((f) => typeof f !== 'string' || !folderPattern.test(f as string))) {
      return json({ error: 'invalid include list' }, 400);
    }
  }

  if (body.exclude !== undefined) {
    if (!Array.isArray(body.exclude) || body.exclude.some((f) => typeof f !== 'string' || !folderPattern.test(f as string))) {
      return json({ error: 'invalid exclude list' }, 400);
    }
  }

  if (body.maxFileSizeMb !== undefined && (typeof body.maxFileSizeMb !== 'number' || body.maxFileSizeMb < 1 || body.maxFileSizeMb > 32)) {
    return json({ error: 'maxFileSizeMb must be a number between 1 and 32' }, 400);
  }

  try {
    logger.info(`received radar zip request for container ${body.id}`);
    const zipBuffer = await zipScanVolume(body.id, {
      include:       body.include as string[] | undefined,
      exclude:       body.exclude as string[] | undefined,
      maxFileSizeMb: body.maxFileSizeMb as number | undefined,
    });

    return new Response(zipBuffer, {
      headers: {
        'Content-Type':        'application/zip',
        'Content-Disposition': `attachment; filename="scan-${body.id}.zip"`,
        'Content-Length':      String(zipBuffer.length),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`error zipping container ${body.id}`, err);
    return json({ success: false, error: `failed to zip container: ${msg}` }, 500);
  }
}
