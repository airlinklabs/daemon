import { Router, Request, Response } from 'express';
import { fetchMinecraftPlayers, extractPlayerInfo } from '../handlers/minecraft/playerFetcher';
import logger from '../utils/logger';

const router = Router();

// These error codes and message fragments all mean the same thing:
// the Minecraft server is not ready to accept connections right now.
// Could be starting up, no players have joined yet, or the port is not
// yet bound. None of these are real errors — we return an empty response.
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ENOTCONN',
  'EPIPE',         // server closed connection while ping library was writing
  'ECONNABORTED',
]);

function isTransientError(error: any): boolean {
  const code = error?.code || error?.cause?.code || '';
  if (TRANSIENT_ERROR_CODES.has(code)) return true;
  const msg = (error?.message || '').toLowerCase();
  return msg.includes('timed out') || msg.includes('refused') || msg.includes('epipe') || msg.includes('broken pipe');
}

const EMPTY_RESPONSE = {
  players: [],
  maxPlayers: 0,
  onlinePlayers: 0,
  description: '',
  version: '',
  online: false,
};

router.get('/minecraft/players', async (req: Request, res: Response) => {
  const { id, host, port } = req.query;

  if (!id || !host || !port) {
    res.status(400).json({ error: 'Container ID, host, and port are required.', ...EMPTY_RESPONSE });
    return;
  }

  const portNum = parseInt(port as string, 10);
  if (isNaN(portNum)) {
    res.status(400).json({ error: 'Port must be a valid number.', ...EMPTY_RESPONSE });
    return;
  }

  try {
    const pingResponse = await fetchMinecraftPlayers(host as string, portNum, 5000);
    const players = extractPlayerInfo(pingResponse);

    let description = '';
    if (typeof pingResponse.description === 'string') {
      description = pingResponse.description;
    } else if (pingResponse.description?.text) {
      description = pingResponse.description.text;
    }

    res.status(200).json({
      players,
      maxPlayers: pingResponse.players?.max || 0,
      onlinePlayers: pingResponse.players?.online || 0,
      description,
      version: pingResponse.version?.name || '',
      online: true,
    });
  } catch (error: any) {
    if (isTransientError(error)) {
      res.status(200).json(EMPTY_RESPONSE);
      return;
    }
    logger.error(`Error fetching players for container ${id}:`, error);
    res.status(500).json({ error: `Failed to fetch players: ${error.message || 'Unknown error'}`, ...EMPTY_RESPONSE });
  }
});

export default router;
