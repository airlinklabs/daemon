import { describe, expect, test } from 'bun:test';
import { CONSOLE_ATTACH_QUERY, normalizeConsoleCommand } from '../src/handlers/consoleCommand';

describe('docker console command delivery', () => {
  test('normalizes command payloads without prepending attach options', () => {
    expect(normalizeConsoleCommand('help\n')).toBe('help');
    expect(normalizeConsoleCommand('\r\nsay hi\r\n')).toBe('say hi');
    expect(normalizeConsoleCommand('\n\n')).toBeNull();
  });

  test('keeps Docker attach flags in the query string instead of stdin', () => {
    expect(CONSOLE_ATTACH_QUERY).toBe('stream=1&stdin=1&stdout=0&stderr=0');
  });
});
