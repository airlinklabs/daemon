import { z } from 'zod';
import { type RadarPattern, type RadarScript, scanVolume } from '../handlers/radar/scan';
import { type ZipOptions, zipScanVolume } from '../handlers/radar/zip';
import logger from '../logger';
import { validateContainerId } from '../validation';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const containerIdSchema = z.string().min(1).refine(validateContainerId, 'invalid container ID format');

const radarPatternSchema = z.object({
  type: z.enum(['filename', 'extension', 'content']),
  pattern: z.string().min(1),
  description: z.string(),
  content: z.string().optional(),
  size_less_than: z.number().optional(),
  size_greater_than: z.number().optional(),
}) satisfies z.ZodType<RadarPattern>;

const radarScriptSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string(),
  patterns: z.array(radarPatternSchema),
}) satisfies z.ZodType<RadarScript>;

const folderListSchema = z.array(z.string().regex(/^[a-zA-Z0-9_\-.]+$/));

const radarScanRequestSchema = z.object({
  id: containerIdSchema,
  script: radarScriptSchema,
});

const radarZipRequestSchema = z.object({
  id: containerIdSchema,
  include: folderListSchema.optional(),
  exclude: folderListSchema.optional(),
  maxFileSizeMb: z.number().min(1).max(32).optional(),
});

async function readJsonRecord(req: Request): Promise<Record<string, unknown> | Response> {
  try {
    const body: unknown = await req.json();
    if (!isRecord(body)) return json({ error: 'json body must be an object' }, 400);
    return body;
  } catch {
    return json({ error: 'invalid json body' }, 400);
  }
}

export async function handleRadarScan(req: Request): Promise<Response> {
  const body = await readJsonRecord(req);
  if (body instanceof Response) return body;

  const parsed = radarScanRequestSchema.safeParse(body);
  if (!parsed.success) return json({ error: 'valid radar scan request is required' }, 400);
  const { id, script } = parsed.data;

  try {
    const results = await scanVolume(id, script);
    return json({
      success: true,
      message: `scan completed for container ${id}`,
      results,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`error scanning container ${id}`, err);
    return json({ success: false, error: `failed to scan container: ${msg}` }, 500);
  }
}

export async function handleRadarZip(req: Request): Promise<Response> {
  const body = await readJsonRecord(req);
  if (body instanceof Response) return body;

  const parsed = radarZipRequestSchema.safeParse(body);
  if (!parsed.success) return json({ error: 'valid radar zip request is required' }, 400);
  const { id, ...options }: { id: string } & ZipOptions = parsed.data;

  try {
    const zipBuffer = await zipScanVolume(id, options);

    return new Response(zipBuffer, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="scan-${id}.zip"`,
        'Content-Length': String(zipBuffer.byteLength),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`error zipping container ${id}`, err);
    return json({ success: false, error: `failed to zip container: ${msg}` }, 500);
  }
}
