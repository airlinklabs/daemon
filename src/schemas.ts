// Re-export everything from split modules for backward compatibility.

export {
  backupBodyCodes,
  backupBodySchema,
  backupDeleteBodyCodes,
  backupDeleteBodySchema,
  restoreBodyCodes,
  restoreBodySchema,
} from './schemas/backup';
export {
  commandBodyCodes,
  commandBodySchema,
  containerIdBodyCodes,
  containerIdBodySchema,
  containerIdSchema,
  installBodyCodes,
  installBodySchema,
  installerBodyCodes,
  installerBodySchema,
  killDeleteBodyCodes,
  killDeleteBodySchema,
  reinstallBodyCodes,
  reinstallBodySchema,
  sftpBodyCodes,
  sftpBodySchema,
  startBodyCodes,
  startBodySchema,
} from './schemas/container';
export {
  fsAppendBodyCodes,
  fsAppendBodySchema,
  fsCopyBodyCodes,
  fsCopyBodySchema,
  fsCreateEmptyBodyCodes,
  fsCreateEmptyBodySchema,
  fsMkdirBodyCodes,
  fsMkdirBodySchema,
  fsPathOptionalBodyCodes,
  fsPathOptionalBodySchema,
  fsPullBodyCodes,
  fsPullBodySchema,
  fsRenameBodyCodes,
  fsRenameBodySchema,
  fsUnzipBodyCodes,
  fsUnzipBodySchema,
  fsUploadBodyCodes,
  fsUploadBodySchema,
  fsWriteBodyCodes,
  fsWriteBodySchema,
  fsZipBodyCodes,
  fsZipBodySchema,
} from './schemas/filesystem';
export { logArchiveDownloadBodyCodes, logArchiveDownloadBodySchema } from './schemas/logs';

import { z } from 'zod';
import { apiError } from './errors';

export const errorEnvelopeSchema = z.object({
  error: z.string(),
  code: z.string(),
  status: z.number().int().min(400),
  detail: z.string().optional(),
});

export type ParsedBody<T> = { data: T } | { response: Response };

type ApiCode = 'invalid_request' | 'invalid_json' | 'container_not_found' | 'path_traversal' | 'not_found';

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
