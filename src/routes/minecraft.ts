import { Router, Request, Response } from 'express';
import { fetchMinecraftPlayers, extractPlayerInfo } from '../handlers/minecraft/playerFetcher';
import logger from '../utils/logger';

const router = Router();

router.get('/minecraft/players', async (req: Request, res: Response) => {
    const { id, host, port } = req.query;

    if (!id || !host || !port) {
        res.status(400).json({ error: 'Container ID, host, and port are required.', players: [] });
        return;
    }

    const portNum = parseInt(port as string, 10);
    if (isNaN(portNum)) {
        res.status(400).json({ error: 'Port must be a valid number.', players: [] });
        return;
    }

    try {
        const pingResponse = await fetchMinecraftPlayers(host as string, portNum, 5000);
        const serverIsOnline = !!pingResponse && !!pingResponse.version;
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
            online: serverIsOnline,
        });
    } catch (error: any) {
        logger.error(`Error fetching players for container ${id}:`, error);
        res.status(500).json({
            error: `Failed to fetch players: ${error.message || 'Unknown error'}`,
            players: [],
            maxPlayers: 0,
            onlinePlayers: 0,
            version: '',
        });
    }
});

export default router;
