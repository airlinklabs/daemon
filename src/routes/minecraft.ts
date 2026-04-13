// This code was written by thavanish(https://github.com/thavanish) for airlinklabs
import { fetchMinecraftPlayers, isTransientError } from '../handlers/minecraft';
import logger from '../logger';

const EMPTY_RESPONSE = {
  players: [],
  maxPlayers: 0,
  onlinePlayers: 0,
  description: '',
  version: '',
  online: false,
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleMinecraftPlayers(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const id = params.get('id');
  const host = params.get('host');
  const port = params.get('port');

  if (!id || !host || !port) {
    return json({ error: 'container ID, host, and port are required', ...EMPTY_RESPONSE }, 400);
  }

  const portNum = parseInt(port, 10);
  if (Number.isNaN(portNum)) {
    return json({ error: 'port must be a valid number', ...EMPTY_RESPONSE }, 400);
  }

  try {
    const result = await fetchMinecraftPlayers(host, portNum, 5000);
    return json(result);
  } catch (err: unknown) {
    if (isTransientError(err)) {
      // server not ready yet — not a real error
      return json(EMPTY_RESPONSE);
    }
    const msg = err instanceof Error ? err.message : 'unknown error';
    logger.error(`error fetching players for container ${id}`, err);
    return json({ error: `failed to fetch players: ${msg}`, ...EMPTY_RESPONSE }, 500);
  }
}
