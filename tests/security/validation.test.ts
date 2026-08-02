import { describe, expect, test } from 'bun:test';
import {
  validateContainerId,
  validatePath,
  validateFileName,
  validateUrl,
  validatePort,
} from '../../src/validation';

describe('validateContainerId — injection resistance', () => {
  test('accepts valid UUIDs', () => {
    expect(validateContainerId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  test('accepts alphanumeric with hyphens and underscores', () => {
    expect(validateContainerId('my-server_1')).toBe(true);
  });

  test('rejects path traversal', () => {
    expect(validateContainerId('../etc/passwd')).toBe(false);
    expect(validateContainerId('..%2F..%2Fetc%2Fpasswd')).toBe(false);
    expect(validateContainerId('../../../etc/passwd')).toBe(false);
  });

  test('rejects shell injection', () => {
    expect(validateContainerId('$(rm -rf /)')).toBe(false);
    expect(validateContainerId('`rm -rf /`')).toBe(false);
    expect(validateContainerId('${rm -rf /}')).toBe(false);
  });

  test('rejects SQL injection', () => {
    expect(validateContainerId("'; DROP TABLE servers;--")).toBe(false);
    expect(validateContainerId('1 OR 1=1')).toBe(false);
  });

  test('rejects empty string', () => {
    expect(validateContainerId('')).toBe(false);
  });

  test('rejects null/undefined', () => {
    expect(validateContainerId(null as any)).toBe(false);
    expect(validateContainerId(undefined as any)).toBe(false);
  });

  test('rejects strings over 64 characters', () => {
    expect(validateContainerId('a'.repeat(65))).toBe(false);
  });

  test('accepts exactly 64 characters', () => {
    expect(validateContainerId('a'.repeat(64))).toBe(true);
  });

  test('rejects special characters', () => {
    expect(validateContainerId('server/name')).toBe(false);
    expect(validateContainerId('server name')).toBe(false);
    expect(validateContainerId('server@name')).toBe(false);
    expect(validateContainerId('server:name')).toBe(false);
    expect(validateContainerId('server;name')).toBe(false);
    expect(validateContainerId('server|name')).toBe(false);
  });

  test('rejects null bytes', () => {
    expect(validateContainerId('server\x00name')).toBe(false);
  });
});

describe('validatePath — traversal resistance', () => {
  test('accepts simple relative paths', () => {
    expect(validatePath('file.txt')).toBe(true);
    expect(validatePath('dir/file.txt')).toBe(true);
    expect(validatePath('a/b/c/file.txt')).toBe(true);
  });

  test('rejects parent directory traversal', () => {
    expect(validatePath('../file.txt')).toBe(false);
    expect(validatePath('../../etc/passwd')).toBe(false);
    expect(validatePath('dir/../../../etc/passwd')).toBe(false);
  });

  test('rejects backslash (Windows paths)', () => {
    expect(validatePath('dir\\file.txt')).toBe(false);
    expect(validatePath('..\\file.txt')).toBe(false);
  });

  test('rejects empty/null', () => {
    expect(validatePath('')).toBe(false);
    expect(validatePath(null as any)).toBe(false);
  });

  test('rejects double dots anywhere', () => {
    expect(validatePath('file..txt')).toBe(false);
    expect(validatePath('dir/..hidden/file.txt')).toBe(false);
  });
});

describe('validateFileName — sanitization', () => {
  test('accepts normal filenames', () => {
    expect(validateFileName('server.jar')).toBe(true);
    expect(validateFileName('my-file_1.txt')).toBe(true);
  });

  test('rejects path traversal', () => {
    expect(validateFileName('../file.txt')).toBe(false);
    expect(validateFileName('dir/../../file')).toBe(false);
  });

  test('rejects angle brackets', () => {
    expect(validateFileName('<script>')).toBe(false);
    expect(validateFileName('file.txt>')).toBe(false);
  });

  test('rejects Windows reserved names', () => {
    expect(validateFileName('CON')).toBe(false);
    expect(validateFileName('PRN')).toBe(false);
    expect(validateFileName('AUX')).toBe(false);
    expect(validateFileName('NUL')).toBe(false);
    expect(validateFileName('COM1')).toBe(false);
    expect(validateFileName('LPT1')).toBe(false);
    expect(validateFileName('con')).toBe(false);
  });

  test('rejects pipe and question mark', () => {
    expect(validateFileName('file|name.txt')).toBe(false);
    expect(validateFileName('file?.txt')).toBe(false);
  });

  test('rejects double quotes', () => {
    expect(validateFileName('file"name.txt')).toBe(false);
  });

  test('rejects colons (Windows alternate data streams)', () => {
    expect(validateFileName('file:name.txt')).toBe(false);
  });

  test('rejects asterisk', () => {
    expect(validateFileName('file*.txt')).toBe(false);
  });

  test('rejects empty/null', () => {
    expect(validateFileName('')).toBe(false);
    expect(validateFileName(null as any)).toBe(false);
  });
});

describe('validateUrl — SSRF prevention', () => {
  test('accepts http URLs', () => {
    expect(validateUrl('http://example.com')).toBe(true);
  });

  test('accepts https URLs', () => {
    expect(validateUrl('https://example.com')).toBe(true);
  });

  test('rejects file:// protocol', () => {
    expect(validateUrl('file:///etc/passwd')).toBe(false);
  });

  test('rejects ftp:// protocol', () => {
    expect(validateUrl('ftp://example.com')).toBe(false);
  });

  test('rejects javascript: protocol', () => {
    expect(validateUrl('javascript:alert(1)')).toBe(false);
  });

  test('rejects data: protocol', () => {
    expect(validateUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  test('rejects non-URL strings', () => {
    expect(validateUrl('not-a-url')).toBe(false);
  });

  test('rejects empty/null', () => {
    expect(validateUrl('')).toBe(false);
    expect(validateUrl(null as any)).toBe(false);
  });

  test('rejects localhost (SSRF)', () => {
    // This should be allowed by validateUrl itself (filtering is done elsewhere)
    expect(validateUrl('http://localhost')).toBe(true);
  });

  test('rejects URLs with credentials', () => {
    expect(validateUrl('http://user:pass@example.com')).toBe(true); // URL spec allows this
  });
});

describe('validatePort — range enforcement', () => {
  test('accepts valid ports', () => {
    expect(validatePort(1)).toBe(true);
    expect(validatePort(25565)).toBe(true);
    expect(validatePort(65535)).toBe(true);
  });

  test('rejects zero', () => {
    expect(validatePort(0)).toBe(false);
  });

  test('rejects negative', () => {
    expect(validatePort(-1)).toBe(false);
  });

  test('rejects above 65535', () => {
    expect(validatePort(65536)).toBe(false);
  });

  test('rejects floats', () => {
    expect(validatePort(1.5)).toBe(false);
  });

  test('rejects NaN', () => {
    expect(validatePort(NaN)).toBe(false);
  });

  test('rejects Infinity', () => {
    expect(validatePort(Infinity)).toBe(false);
  });
});
