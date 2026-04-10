import { MinecraftServerListPing } from "minecraft-status";

export async function fetchMinecraftPlayers(host: string, port: number, timeout = 5000): Promise<any> {
  return MinecraftServerListPing.ping(4, host, port, timeout);
}

export function extractPlayerInfo(pingResponse: any): Array<{ name: string; uuid: string }> {
  if (!pingResponse?.players?.sample) return [];
  return pingResponse.players.sample
    .filter((player: any) => player?.name && player?.id)
    .map((player: any) => ({ name: player.name, uuid: player.id }));
}
