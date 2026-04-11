import { MinecraftServerListPing } from 'minecraft-status';
import logger from '../logger';

// these error codes all mean the server isn't ready to answer yet
// not real errors — return empty response rather than 500
const TRANSIENT_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH',
  'ENETUNREACH', 'ENOTFOUND', 'ENOTCONN', 'EPIPE', 'ECONNABORTED',
]);

export function isTransientError(error: unknown): boolean {
  const err = error as { code?: string; cause?: { code?: string }; message?: string };
  const code = err?.code || err?.cause?.code || '';
  if (TRANSIENT_CODES.has(code)) return true;
  const msg = (err?.message || '').toLowerCase();
  return msg.includes('timed out') || msg.includes('refused') || msg.includes('epipe') || msg.includes('broken pipe');
}

export async function fetchMinecraftPlayers(
  host: string,
  port: number,
  timeout = 5000,
): Promise<{
  players:       { name: string; uuid: string }[];
  maxPlayers:    number;
  onlinePlayers: number;
  description:   string;
  version:       string;
  online:        boolean;
}> {
  const response = await MinecraftServerListPing.ping(4, host, port, timeout) as {
    players?: { max?: number; online?: number; sample?: { name: string; id: string }[] };
    description?: string | { text?: string };
    version?: { name?: string };
  };

  const players = (response.players?.sample ?? [])
    .filter((p) => p?.name && p?.id)
    .map((p) => ({ name: p.name, uuid: p.id }));

  let description = '';
  if (typeof response.description === 'string') description = response.description;
  else if (response.description?.text) description = response.description.text;

  return {
    players,
    maxPlayers:    response.players?.max    ?? 0,
    onlinePlayers: response.players?.online ?? 0,
    description,
    version:  response.version?.name ?? '',
    online:   true,
  };
}
