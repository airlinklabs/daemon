export const CONSOLE_ATTACH_QUERY = 'stream=1&stdin=1&stdout=0&stderr=0';

export function normalizeConsoleCommand(command: string): string | null {
  const cleanedCommand = command.replace(/\r\n?/g, '\n').replace(/\n+$/g, '').trim();
  return cleanedCommand ? cleanedCommand : null;
}
