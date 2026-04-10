import { scanVolume } from "../handlers/radar/scan";
import { zipScanVolume } from "../handlers/radar/zip";
import { validateContainerId } from "../validation";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export async function handleRadarScan(req: Request): Promise<Response> {
  const body = await req.json() as { id?: string; script?: any };
  if (!body.id || !body.script) return json({ error: "Container ID and script are required." }, 400);
  const results = await scanVolume(body.id, body.script);
  return json({ success: true, message: `Scan completed for container ${body.id}`, results });
}

export async function handleRadarZip(req: Request): Promise<Response> {
  const body = await req.json() as { id?: string; include?: string[]; exclude?: string[]; maxFileSizeMb?: number };
  if (!body.id || !validateContainerId(body.id)) return json({ error: "Container ID is required." }, 400);
  const zipBuffer = await zipScanVolume(body.id, { include: body.include, exclude: body.exclude, maxFileSizeMb: body.maxFileSizeMb });
  return new Response(new Uint8Array(zipBuffer), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="scan-${body.id}.zip"`,
      "Content-Length": String(zipBuffer.length),
    },
  });
}
