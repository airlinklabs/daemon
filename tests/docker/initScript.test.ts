import { describe, expect, test } from 'bun:test';
import { buildInitScript } from '../../src/handlers/docker';

describe('buildInitScript', () => {
  test('generates valid shell script with entrypoint and cmd', () => {
    const script = buildInitScript(['node', 'index.js'], ['--production']);

    expect(script).toContain('#!/bin/sh');
    expect(script).toContain('hostname airlinkd');
    expect(script).toContain('/etc/passwd');
    expect(script).toContain('PS1');
    expect(script).toContain('airlinkd');
    expect(script).toContain('mkfifo');
    expect(script).toContain("'node' 'index.js' '--production'");
  });

  test('generates valid shell script with entrypoint only', () => {
    const script = buildInitScript(['bash', 'start.sh'], []);

    expect(script).toContain("'bash' 'start.sh'");
    expect(script).not.toContain('--production');
  });

  test('generates valid shell script with cmd only', () => {
    const script = buildInitScript([], ['java', '-jar', 'server.jar']);

    expect(script).toContain("'java' '-jar' 'server.jar'");
  });

  test('falls back to /bin/sh when no entrypoint or cmd', () => {
    const script = buildInitScript([], []);

    expect(script).toContain('/bin/sh');
  });

  test('includes zsh and fish shell support', () => {
    const script = buildInitScript(['node', 'index.js'], []);

    expect(script).toContain('.zshrc');
    expect(script).toContain('config.fish');
  });

  test('creates console FIFO', () => {
    const script = buildInitScript(['node', 'index.js'], []);

    expect(script).toContain('mkfifo');
    expect(script).toContain('console.in');
    expect(script).toContain('AIRLINKD_CONSOLE_FIFO');
  });

  test('pipes FIFO into entrypoint', () => {
    const script = buildInitScript(['node', 'index.js'], []);

    expect(script).toContain('while true; do cat "$AIRLINKD_CONSOLE_FIFO"; done');
  });

  test('patches /etc/hostname', () => {
    const script = buildInitScript(['node', 'index.js'], []);

    expect(script).toContain("echo 'airlinkd' > /etc/hostname");
  });

  test('patches /etc/passwd entries', () => {
    const script = buildInitScript(['node', 'index.js'], []);

    expect(script).toContain("sed -i 's|^container:|airlinkd:|' /etc/passwd");
    expect(script).toContain("sed -i 's|^user:|airlinkd:|'");
    expect(script).toContain("sed -i 's|^app:|airlinkd:|'");
  });

  test('handles single quotes in entrypoint arguments', () => {
    const script = buildInitScript(["node", "it's a test.js"], []);

    // Should escape single quotes properly
    expect(script).toContain("node");
    expect(script).toContain("it");
  });
});
