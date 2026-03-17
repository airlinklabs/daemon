import { MinecraftServerListPing } from 'minecraft-status';
import logger from '../../utils/logger';

export async function fetchMinecraftPlayers(host: string, port: number, timeout = 5000): Promise<any> {
    const response = await MinecraftServerListPing.ping(4, host, port, timeout);
    return response;
}

export function extractPlayerInfo(pingResponse: any): Array<{ name: string; uuid: string }> {
    if (!pingResponse?.players?.sample) return [];

    return pingResponse.players.sample
        .filter((player: any) => player?.name && player?.id)
        .map((player: any) => ({ name: player.name, uuid: player.id }));
}
