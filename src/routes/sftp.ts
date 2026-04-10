import { generateCredential, getActiveSessionCount, revokeCredentialForContainer } from "../handlers/sftp";
import { validateContainerId } from "../validation";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export async function handleSftpCreate(req: Request): Promise<Response> {
  const body = await req.json() as { id?: string };
  if (!body.id || !validateContainerId(body.id)) return json({ error: "Invalid container ID format." }, 400);
  const credential = await generateCredential(body.id);
  return json(credential);
}

export async function handleSftpRevoke(req: Request): Promise<Response> {
  const body = await req.json() as { id?: string };
  if (!body.id || !validateContainerId(body.id)) return json({ error: "Invalid container ID format." }, 400);
  await revokeCredentialForContainer(body.id);
  return json({ message: "SFTP credentials revoked." });
}

export async function handleSftpStatus(): Promise<Response> {
  return json({ activeSessions: getActiveSessionCount() });
}
