import { z } from 'zod';
import { apiError } from './errors';
import type { ConfigFileEntry } from './handlers/configFiles';
import { validateContainerId, validateFileName, validatePath } from './validation';

/**
 * Canonical zod schemas for every JSON-body daemon route (2.2).
 *
 * Semantics preserved from the pre-schema handlers:
 * - Missing / wrong-type fields produce the same messages the manual checks produced.
 * - Issue order follows the old check order (presence, then format).
 * - Codes map per schema; defaults to `invalid_request`.
 * Cross-field / derived checks (URL parsing, trimmed command, folder-name
 * fallbacks, base64 decoding) intentionally stay in the route handlers.
 */

export const containerIdSchema = z
  .string({ error: 'container ID is required' })
  .min(1, 'container ID is required')
  .refine(validateContainerId, 'invalid container ID');

const sftpContainerIdSchema = z
  .string({ error: 'container ID is required' })
  .min(1, 'container ID is required')
  .refine((v) => validateContainerId(v) && v.length <= 64, 'invalid container ID format');

export const installerBodySchema = z.object({
  id: containerIdSchema,
  script: z.string({ error: 'script and container are required' }).min(1, 'script and container are required'),
  container: z.string({ error: 'script and container are required' }).min(1, 'script and container are required'),
  entrypoint: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export const installerBodyCodes = { id: 'container_not_found' } as const;

export const installBodySchema = z.object({
  id: containerIdSchema,
  image: z.string().optional(),
  scripts: z.array(z.unknown()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export const installBodyCodes = { id: 'container_not_found' } as const;

// Reinstall takes the install shape plus an explicit data-wipe opt-in. Data
// preservation is the default: the volume is only removed when the panel
// sends preserveData:false as part of a confirmed "delete all data" flow.
export const reinstallBodySchema = installBodySchema.extend({
  preserveData: z.boolean().optional(),
});
export const reinstallBodyCodes = installBodyCodes;

export const startBodySchema = z.object({
  id: z
    .string({ error: 'container ID and image are required' })
    .min(1, 'container ID and image are required')
    .refine(validateContainerId, 'invalid container ID'),
  image: z.string({ error: 'container ID and image are required' }).min(1, 'container ID and image are required'),
  ports: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  Memory: z.number().optional(),
  Cpu: z.number().optional(),
  Storage: z.number().optional(),
  Swap: z.number().optional(),
  StartCommand: z.string().optional(),
  mounts: z.array(z.object({ source: z.string(), target: z.string(), readOnly: z.boolean().optional() })).optional(),
  configFiles: z
    .record(
      z.string(),
      z.custom<ConfigFileEntry>((v) => typeof v === 'object' && v !== null),
    )
    .optional(),
});
export const startBodyCodes = { id: 'container_not_found', image: 'container_not_found' } as const;

export const containerIdBodySchema = z.object({ id: containerIdSchema, stopCmd: z.string().optional() });
export const containerIdBodyCodes = { id: 'container_not_found' } as const;

const validContainerIdOnlySchema = z
  .string({ error: 'valid container ID required' })
  .min(1, 'valid container ID required')
  .refine(validateContainerId, 'valid container ID required');

export const killDeleteBodySchema = z.object({ id: validContainerIdOnlySchema });
export const killDeleteBodyCodes = { id: 'container_not_found' } as const;

const commandContainerIdSchema = z
  .string({ error: 'invalid container ID' })
  .min(1, 'invalid container ID')
  .refine(validateContainerId, 'invalid container ID');

export const commandBodySchema = z.object({
  id: commandContainerIdSchema,
  command: z.string({ error: 'container command is required' }).optional(),
});
export const commandBodyCodes = { id: 'container_not_found' } as const;

export const backupBodySchema = z.object({
  id: containerIdSchema,
  name: z.string({ error: 'backup name is required' }).min(1, 'backup name is required'),
  ignore: z.array(z.string()).optional(),
});
export const backupBodyCodes = { id: 'container_not_found' } as const;

export const restoreBodySchema = z.object({
  id: containerIdSchema,
  backupPath: z.string({ error: 'backup path is required' }).min(1, 'backup path is required'),
  checksum: z.string().optional(),
});
export const restoreBodyCodes = { id: 'container_not_found' } as const;

export const backupDeleteBodySchema = z.object({
  backupPath: z.string({ error: 'backup path is required' }).min(1, 'backup path is required'),
});
export const backupDeleteBodyCodes = {} as const;

export const logArchiveDownloadBodySchema = z.object({
  id: containerIdSchema,
  file: z.string({ error: 'file is required' }).min(1, 'file is required'),
});
export const logArchiveDownloadBodyCodes = { id: 'container_not_found' } as const;

const fsPathSchema = z
  .string({ error: 'invalid file path' })
  .min(1, 'invalid file path')
  .refine(validatePath, 'invalid file path');

export const fsWriteBodySchema = z.object({
  id: containerIdSchema,
  path: fsPathSchema,
  content: z.string().optional(),
});
export const fsWriteBodyCodes = { id: 'container_not_found', path: 'path_traversal' } as const;

export const fsPullBodySchema = z.object({
  id: containerIdSchema,
  url: z.string({ error: 'URL is required' }).min(1, 'URL is required'),
  path: z.string({ error: 'invalid target path' }).optional(),
});
export const fsPullBodyCodes = { id: 'container_not_found', path: 'path_traversal' } as const;

export const fsPathOptionalBodySchema = z.object({
  id: containerIdSchema,
  path: z.string().optional(),
});
export const fsPathOptionalBodyCodes = { id: 'container_not_found' } as const;

export const fsUnzipBodySchema = z.object({
  id: containerIdSchema,
  path: z.string().optional(),
  zipname: z.string().optional(),
});
export const fsUnzipBodyCodes = { id: 'container_not_found' } as const;

export const fsZipBodySchema = z.object({
  id: containerIdSchema,
  path: z.string().or(z.array(z.string())).optional(),
  zipname: z.string().optional(),
});
export const fsZipBodyCodes = { id: 'container_not_found' } as const;

export const fsRenameBodySchema = z.object({
  id: containerIdSchema,
  path: z.string().optional(),
  newName: z.string().optional(),
  newPath: z.string().optional(),
});
export const fsRenameBodyCodes = { id: 'container_not_found' } as const;

export const fsCopyBodySchema = z.object({
  id: containerIdSchema,
  source: z.string().min(1, 'source path is required'),
  newPath: z.string().optional(),
});
export const fsCopyBodyCodes = { id: 'container_not_found' } as const;

const fileNameSchema = z
  .string({ error: 'file name is required' })
  .min(1, 'file name is required')
  .refine(validateFileName, 'invalid file name');

export const fsUploadBodySchema = z.object({
  id: containerIdSchema,
  path: fsPathSchema,
  fileName: fileNameSchema,
  fileContent: z.string({ error: 'file content is required' }).min(1, 'file content is required'),
});
export const fsUploadBodyCodes = { id: 'container_not_found', path: 'path_traversal' } as const;

export const fsMkdirBodySchema = z.object({
  id: containerIdSchema,
  path: z.string().optional(),
  folderName: z.string().optional(),
});
export const fsMkdirBodyCodes = { id: 'container_not_found' } as const;

export const fsCreateEmptyBodySchema = z.object({
  id: containerIdSchema,
  path: z.string().optional(),
  fileName: z.string({ error: 'file name is required' }).min(1, 'file name is required'),
});
export const fsCreateEmptyBodyCodes = { id: 'container_not_found' } as const;

export const fsAppendBodySchema = z.object({
  id: containerIdSchema,
  path: z.string().optional(),
  fileName: z.string({ error: 'file name is required' }).min(1, 'file name is required'),
  fileContent: z.string({ error: 'file content is required' }).min(1, 'file content is required'),
  chunkIndex: z.number().optional(),
  totalChunks: z.number().optional(),
});
export const fsAppendBodyCodes = { id: 'container_not_found' } as const;

export const sftpBodySchema = z.object({ id: sftpContainerIdSchema });
export const sftpBodyCodes = { id: 'container_not_found' } as const;

/** Canonical D-004 error envelope. */
export const errorEnvelopeSchema = z.object({
  error: z.string(),
  code: z.string(),
  status: z.number().int().min(400),
  detail: z.string().optional(),
});

export type ParsedBody<T> = { data: T } | { response: Response };

type ApiCode = 'invalid_request' | 'invalid_json' | 'container_not_found' | 'path_traversal' | 'not_found';

/**
 * Parse and validate a JSON request body against a canonical schema.
 *
 * Returns `{ data }` on success or `{ response }` (an `apiError` Response,
 * message and code preserved from the pre-schema behavior) on failure.
 */
export async function parseJsonBody<T>(
  req: Request,
  schema: z.ZodType<T>,
  codeByField: Record<string, string> = {},
): Promise<ParsedBody<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { response: apiError('invalid_json', 'invalid json body', 400) };
  }
  const result = schema.safeParse(raw);
  if (result.success) return { data: result.data };
  const issue = result.error.issues[0];
  const code = (codeByField[issue.path.join('.')] ?? 'invalid_request') as ApiCode;
  return { response: apiError(code, issue.message, 400) };
}
