import { describe, expect, test } from 'bun:test';
import { handleRadarScan, handleRadarZip } from '../src/routes/radar';

function postJson(body: unknown): Request {
  return new Request('http://localhost/radar', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  expect(body).toBeObject();
  if (!isJsonRecord(body)) {
    throw new Error('expected response body to be a JSON object');
  }
  return body;
}

describe('radar route contracts', () => {
  test('rejects non-object scan bodies before handler code runs', async () => {
    const response = await handleRadarScan(postJson([]));

    expect(response.status).toBe(400);
    expect(await responseJson(response)).toEqual({ error: 'json body must be an object' });
  });

  test('requires a valid radar script shape', async () => {
    const response = await handleRadarScan(
      postJson({
        id: 'server_1',
        script: { name: 'incomplete', patterns: [] },
      }),
    );

    expect(response.status).toBe(400);
    expect(await responseJson(response)).toEqual({ error: 'valid radar scan request is required' });
  });

  test('rejects invalid zip include folders', async () => {
    const response = await handleRadarZip(
      postJson({
        id: 'server_1',
        include: ['plugins', '../world'],
      }),
    );

    expect(response.status).toBe(400);
    expect(await responseJson(response)).toEqual({ error: 'valid radar zip request is required' });
  });

  test('rejects zip size limits outside the contract', async () => {
    const response = await handleRadarZip(
      postJson({
        id: 'server_1',
        maxFileSizeMb: 64,
      }),
    );

    expect(response.status).toBe(400);
    expect(await responseJson(response)).toEqual({ error: 'valid radar zip request is required' });
  });
});
