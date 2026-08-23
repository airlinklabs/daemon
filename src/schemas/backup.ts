import { z } from 'zod';
import { containerIdSchema } from './container';

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
