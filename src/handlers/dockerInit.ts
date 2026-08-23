// Generates the shell wrapper that runs before a container's original entrypoint.
// It patches hostname, user environment, PS1 prompt, and wires up the console
// FIFO so the daemon can send commands to the game server process.

export function buildInitScript(originalEntrypoint: string[], originalCmd: string[]): string {
  const quoted = (args: string[]) => args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');

  let startLine: string;
  if (originalEntrypoint.length > 0) {
    startLine = `${quoted(originalEntrypoint)}${originalCmd.length > 0 ? ` ${quoted(originalCmd)}` : ''}`;
  } else if (originalCmd.length > 0) {
    startLine = quoted(originalCmd);
  } else {
    startLine = '/bin/sh';
  }

  const lines = [
    '#!/bin/sh',
    '',
    "echo 'airlinkd' > /etc/hostname 2>/dev/null || true",
    'hostname airlinkd 2>/dev/null || true',
    '',
    'export USER="$(id -un 2>/dev/null || echo user)"',
    'export LOGNAME="$USER"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable syntax
    'export HOME="${HOME:-/home/container}"',
    '',
    'for _rc in /home/container/.bashrc /home/container/.zshrc /root/.bashrc /root/.zshrc /etc/bash.bashrc; do',
    '  if [ -f "$_rc" ]; then',
    '    sed -i \'s/petrodactyl/airlinkd/g\' "$_rc" 2>/dev/null || true',
    '    grep -q \'PS1.*airlinkd\' "$_rc" 2>/dev/null || echo \'export PS1="airlinkd~\\$ "\' >> "$_rc"',
    '  fi',
    'done',
    '# Fish uses a different syntax for prompts',
    'if [ -f /home/container/.config/fish/config.fish ]; then',
    "  sed -i 's/petrodactyl/airlinkd/g' /home/container/.config/fish/config.fish 2>/dev/null || true",
    'fi',
    '',
    'export PS1="airlinkd~\\$ "',
    '',
    'AIRLINKD_CONSOLE_FIFO=/home/container/.airlinkd/console.in',
    'if [ ! -p "$AIRLINKD_CONSOLE_FIFO" ]; then',
    '  rm -f "$AIRLINKD_CONSOLE_FIFO"',
    '  mkfifo "$AIRLINKD_CONSOLE_FIFO"',
    'fi',
    '',
    `while true; do cat "$AIRLINKD_CONSOLE_FIFO"; done | ${startLine}`,
  ];

  return `${lines.join('\n')}\n`;
}
