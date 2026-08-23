import { z } from 'zod';
import type { ConfigFileEntry } from '../handlers/configFiles';
import { validateContainerId } from '../validation';

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

export const sftpBodySchema = z.object({ id: sftpContainerIdSchema });
export const sftpBodyCodes = { id: 'container_not_found' } as const;
