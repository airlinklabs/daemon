import { z } from 'zod';
import { containerIdSchema } from './container';

export const logArchiveDownloadBodySchema = z.object({
  id: containerIdSchema,
  file: z.string({ error: 'file is required' }).min(1, 'file is required'),
});
export const logArchiveDownloadBodyCodes = { id: 'container_not_found' } as const;
