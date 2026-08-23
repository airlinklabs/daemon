import { z } from 'zod';
import { validateFileName, validatePath } from '../validation';
import { containerIdSchema } from './container';

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
