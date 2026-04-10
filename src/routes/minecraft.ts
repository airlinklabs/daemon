import { extractPlayerInfo, fetchMinecraftPlayers } from "../handlers/minecraft";
import logger from "../logger";

const EMPTY_RESPONSE = {
  players: [],
  maxPlayers: 0,
  onlinePlayers: 0,
  description: "",
  version: "",
  online: false,
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export async function handleMinecraftPlayers(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const host = url.searchParams.get("host");
  const port = url.searchParams.get("port");
  if (!id || !host || !port) return json({ error: "Container ID, host, and port are required.", ...EMPTY_RESPONSE }, 400);

  const portNum = Number.parseInt(port, 10);
  if (Number.isNaN(portNum)) return json({ error: "Port must be a valid number.", ...EMPTY_RESPONSE }, 400);

  try {
    const pingResponse = await fetchMinecraftPlayers(host, portNum, 5000);
    const players = extractPlayerInfo(pingResponse);
    const description = typeof pingResponse.description === "string" ? pingResponse.description : (pingResponse.description?.text ?? "");
    return json({
      players,
      maxPlayers: pingResponse.players?.max || 0,
      onlinePlayers: pingResponse.players?.online || 0,
      description,
      version: pingResponse.version?.name || "",
      online: true,
    });
  } catch (error) {
    logger.error(`Error fetching players for container ${id}`, error);
    return json({ error: `Failed to fetch players: ${error instanceof Error ? error.message : "Unknown error"}`, ...EMPTY_RESPONSE }, 500);
  }
}
