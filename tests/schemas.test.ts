import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  commandBodySchema,
  containerIdSchema,
  errorEnvelopeSchema,
  fsWriteBodySchema,
  parseJsonBody,
  reinstallBodySchema,
  sftpBodySchema,
  startBodySchema,
} from '../src/schemas';

function jsonRequest(body: unknown): Request {
  return new Request('http://daemon.test/route', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function parseError<T>(req: Request, schema: z.ZodType<T>, codes: Record<string, string>) {
  const result = await parseJsonBody(req, schema, codes);
  if ('data' in result) return null;
  const body = (await result.response.json()) as { error: string; code: string; status: number };
  return body;
}

describe('error envelope (D-004)', () => {
  test('validates the canonical error shape', () => {
    expect(errorEnvelopeSchema.safeParse({ error: 'boom', code: 'internal_error', status: 500 }).success).toBe(true);
    expect(
      errorEnvelopeSchema.safeParse({ error: 'boom', code: 'internal_error', status: 500, detail: 'trace' }).success,
    ).toBe(true);
  });

  test('rejects shapes missing envelope fields', () => {
    expect(errorEnvelopeSchema.safeParse({ error: 'boom' }).success).toBe(false);
    expect(errorEnvelopeSchema.safeParse({ code: 'x', status: 200, error: 'y' }).success).toBe(false);
  });
});

describe('container id schema', () => {
  test('accepts valid ids', () => {
    for (const id of ['abc', 'ABC-123_xyz', 'a'.repeat(64)]) {
      expect(containerIdSchema.safeParse(id).success).toBe(true);
    }
  });

  test('rejects invalid ids with the canonical message', () => {
    expect(containerIdSchema.safeParse('bad id!').success).toBe(false);
    expect(containerIdSchema.safeParse('a'.repeat(65)).success).toBe(false);
  });
});

describe('parseJsonBody', () => {
  test('invalid JSON returns invalid_json with the canonical message', async () => {
    const body = await parseError(jsonRequest('{not json'), startBodySchema, {});
    expect(body).toEqual({ error: 'invalid json body', code: 'invalid_json', status: 400 });
  });

  test('missing id returns container ID is required / container_not_found', async () => {
    const body = await parseError(jsonRequest({}), fsWriteBodySchema, { id: 'container_not_found' });
    expect(body).toEqual({ error: 'container ID is required', code: 'container_not_found', status: 400 });
  });

  test('start requires image with the combined message', async () => {
    const body = await parseError(jsonRequest({ id: 'abc' }), startBodySchema, {
      id: 'container_not_found',
      image: 'container_not_found',
    });
    expect(body).toEqual({
      error: 'container ID and image are required',
      code: 'container_not_found',
      status: 400,
    });
  });

  test('invalid id format maps to container_not_found', async () => {
    const body = await parseError(jsonRequest({ id: 'bad!', image: 'img' }), startBodySchema, {
      id: 'container_not_found',
      image: 'container_not_found',
    });
    expect(body).toEqual({ error: 'invalid container ID', code: 'container_not_found', status: 400 });
  });

  test('invalid path maps to path_traversal', async () => {
    const body = await parseError(
      jsonRequest({ id: 'abc', path: '../escape', content: 'x' }),
      fsWriteBodySchema,
      { id: 'container_not_found', path: 'path_traversal' },
    );
    expect(body).toEqual({ error: 'invalid file path', code: 'path_traversal', status: 400 });
  });

  test('valid bodies return typed data', async () => {
    const result = await parseJsonBody(
      jsonRequest({ id: 'abc', path: 'server.properties', content: 'x=1' }),
      fsWriteBodySchema,
      { id: 'container_not_found', path: 'path_traversal' },
    );
    expect('data' in result).toBe(true);
    if ('data' in result) {
      expect(result.data).toEqual({ id: 'abc', path: 'server.properties', content: 'x=1' });
    }
  });

  test('command body allows a missing command (handler trims it)', () => {
    expect(commandBodySchema.safeParse({ id: 'abc' }).success).toBe(true);
  });

  test('sftp id over 64 chars reports invalid container ID format', async () => {
    const body = await parseError(jsonRequest({ id: 'a'.repeat(65) }), sftpBodySchema, { id: 'container_not_found' });
    expect(body).toEqual({ error: 'invalid container ID format', code: 'container_not_found', status: 400 });
  });

  test('reinstall defaults to preserving data when preserveData is omitted', () => {
    const result = reinstallBodySchema.safeParse({ id: 'abc' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.preserveData).toBeUndefined();
    }
  });

  test('reinstall accepts an explicit preserveData:false wipe request', () => {
    const result = reinstallBodySchema.safeParse({ id: 'abc', preserveData: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.preserveData).toBe(false);
    }
  });

  test('reinstall rejects a non-boolean preserveData', () => {
    expect(reinstallBodySchema.safeParse({ id: 'abc', preserveData: 'yes' }).success).toBe(false);
  });

  test('reinstall requires a valid container id', async () => {
    const body = await parseError(jsonRequest({ id: 'bad!' }), reinstallBodySchema, { id: 'container_not_found' });
    expect(body).toEqual({ error: 'invalid container ID', code: 'container_not_found', status: 400 });
  });
});
