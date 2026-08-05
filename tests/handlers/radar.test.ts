import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RadarPattern, type RadarScript, scanVolume } from '../../src/handlers/radar/scan';

const ID = 'radar-handler-test';

const volumeDir = mkdtempSync(join(tmpdir(), 'airlinkd-radar-test-'));

function script(...patterns: RadarPattern[]): RadarScript {
  return { name: 'test-script', description: 'fixture', version: '1.0.0', patterns };
}

function contentPattern(
  content: string,
  guards?: Partial<Pick<RadarPattern, 'size_less_than' | 'size_greater_than'>>,
): RadarPattern {
  return { type: 'content', pattern: 'content-scan', description: 'fixture', content, ...guards };
}

function matchPaths(results: { matches: { path: string }[] }[]): string[] {
  return results.flatMap((r) => r.matches.map((m) => m.path));
}

beforeAll(() => {
  mkdirSync(join(volumeDir, 'plugins'));
  writeFileSync(join(volumeDir, 'plugins', 'backdoor.php'), '<?php eval($_GET["x"]); ?>');
  writeFileSync(join(volumeDir, 'plugins', 'DangerPlugin.jar'), 'not real content');
  writeFileSync(join(volumeDir, 'secret.txt'), 'api_key = sk_live_abcdef123456');
  writeFileSync(join(volumeDir, 'config.yml'), 'database:\n  password: hunter2\n');
  writeFileSync(join(volumeDir, 'small-match.txt'), 'leak_marker inside a small file');

  // Just over the 10 MiB read cap, with the marker buried near the end so a
  // naive reader would find it — the cap must still exclude it.
  const big = Buffer.alloc(11 * 1024 * 1024, 0x61);
  big.write('leak_marker', big.length - 32);
  writeFileSync(join(volumeDir, 'big.log'), big);

  writeFileSync(join(volumeDir, 'guard-small.txt'), 'GUARDED_MARKER');
  writeFileSync(join(volumeDir, 'guard-big.txt'), `${'x'.repeat(500)}GUARDED_MARKER`);

  // A symlinked file pointing outside the volume, plus a symlinked directory
  // with a matching file inside — neither may be read or reported.
  const outside = mkdtempSync(join(tmpdir(), 'airlinkd-radar-outside-'));
  writeFileSync(join(outside, 'out.txt'), 'EXFIL_MARKER');
  symlinkSync(join(outside, 'out.txt'), join(volumeDir, 'escape.txt'));
  mkdirSync(join(outside, 'indir'));
  writeFileSync(join(outside, 'indir', 'f.txt'), 'EXFIL_DIR_MARKER');
  symlinkSync(join(outside, 'indir'), join(volumeDir, 'exfil-dir'));
});

afterAll(() => {
  rmSync(volumeDir, { recursive: true, force: true });
});

describe('radar content scanning', () => {
  test('a content pattern reports a small text file it matches', async () => {
    const results = await scanVolume(ID, script(contentPattern('api_key')), { baseDirectory: volumeDir });

    expect(results).toHaveLength(1);
    expect(matchPaths(results)).toEqual(['secret.txt']);
    expect(results[0].matches[0].size).toBeTypeOf('number');
  });

  test('a content pattern with no match reports nothing', async () => {
    const results = await scanVolume(ID, script(contentPattern('no_such_string_anywhere')), {
      baseDirectory: volumeDir,
    });

    expect(results).toEqual([]);
  });

  test('size_less_than excludes larger files from content scanning', async () => {
    const results = await scanVolume(ID, script(contentPattern('guarded_marker', { size_less_than: 100 })), {
      baseDirectory: volumeDir,
    });

    // guard-small.txt (13 bytes) passes the guard; guard-big.txt (512+ bytes) is excluded.
    expect(matchPaths(results)).toEqual(['guard-small.txt']);
  });

  test('a file over the content-read cap is not read or matched', async () => {
    const results = await scanVolume(ID, script(contentPattern('leak_marker')), { baseDirectory: volumeDir });

    const paths = matchPaths(results);
    expect(paths).toContain('small-match.txt');
    expect(paths).not.toContain('big.log');
  });

  test('filename and extension patterns still work', async () => {
    const results = await scanVolume(
      ID,
      script(
        { type: 'filename', pattern: 'backdoor', description: 'fixture' },
        { type: 'extension', pattern: '.php', description: 'fixture' },
      ),
      { baseDirectory: volumeDir },
    );

    expect(matchPaths(results)).toEqual(['plugins/backdoor.php', 'plugins/backdoor.php']);
  });

  test('an optional content regex still narrows filename matches', async () => {
    const matching = await scanVolume(
      ID,
      script({ type: 'filename', pattern: 'secret', description: 'fixture', content: 'api_key' }),
      { baseDirectory: volumeDir },
    );
    const nonMatching = await scanVolume(
      ID,
      script({ type: 'filename', pattern: 'secret', description: 'fixture', content: 'not_there' }),
      { baseDirectory: volumeDir },
    );

    expect(matchPaths(matching)).toEqual(['secret.txt']);
    expect(nonMatching).toEqual([]);
  });

  test('symlinks are not followed out of the volume', async () => {
    const results = await scanVolume(ID, script(contentPattern('exfil_marker')), { baseDirectory: volumeDir });

    expect(matchPaths(results)).not.toContain('escape.txt');
  });

  test('a symlinked directory is not traversed', async () => {
    const results = await scanVolume(ID, script(contentPattern('exfil_dir_marker')), { baseDirectory: volumeDir });

    expect(results).toEqual([]);
  });
});
