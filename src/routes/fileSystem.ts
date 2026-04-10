import path from "node:path";
import afs from "../handlers/fs";
import { validateContainerId, validateFileName, validatePath } from "../validation";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function decodeUploadContent(fileContent: unknown): Buffer | string {
  if (typeof fileContent === "string") {
    if (fileContent.includes("base64")) {
      const match = fileContent.match(/^data:[^;]+;base64,(.+)$/);
      if (!match?.[1]) throw new Error("Invalid base64 format.");
      return Buffer.from(match[1], "base64");
    }
    return fileContent;
  }
  if (fileContent instanceof Uint8Array) return Buffer.from(fileContent);
  throw new Error("Unsupported content type.");
}

export async function handleFsList(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const relativePath = url.searchParams.get("path") ?? "/";
  const filter = url.searchParams.get("filter") ?? "";
  if (!id) return json({ error: "Container ID is required and must be a string." }, 400);
  return json(await afs.list(id, relativePath, filter));
}

export async function handleFsSize(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const relativePath = url.searchParams.get("path") ?? "/";
  if (!id) return json({ error: "Container ID is required and must be a string." }, 400);
  return json({ size: await afs.getDirectorySizeHandler(id, relativePath) });
}

export async function handleFsInfo(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "Container ID is required and must be a string." }, 400);
  const contents = await afs.list(id, "/");
  const totalSize = contents.reduce((sum, item) => sum + (item.size || 0), 0);
  const fileCount = contents.filter((item) => item.type === "file").length;
  const dirCount = contents.filter((item) => item.type === "directory").length;
  return json({ id, totalSize, fileCount, dirCount });
}

export async function handleFsFileRead(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const relativePath = url.searchParams.get("path") ?? "/";
  if (!id) return json({ error: "Container ID is required and must be a string." }, 400);
  const content = await afs.getFileContentHandler(id, relativePath);
  if (content === null) return json({ error: "File content could not be read or is not a text file." }, 404);
  return new Response(content, { status: 200, headers: { "Content-Type": "text/plain" } });
}

export async function handleFsFileWrite(req: Request): Promise<Response> {
  const body = await req.json() as { id?: string; path?: string; content?: string };
  if (!body.id || !validateContainerId(body.id)) return json({ error: "Invalid container ID format." }, 400);
  if (!validatePath(body.path ?? "/")) return json({ error: "Invalid file path." }, 400);
  await afs.writeFileContentHandler(body.id, body.path ?? "/", body.content ?? "");
  return json({ message: "File content successfully saved." });
}

export async function handleFsDownload(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const relativePath = url.searchParams.get("path") ?? "/";
  if (!id) return json({ error: "Container ID is required and must be a string." }, 400);
  const filePath = await afs.getFilePath(id, relativePath);
  if (!filePath) return json({ error: "File not found." }, 404);
  return new Response(Bun.file(filePath), {
    headers: {
      "Content-Disposition": `attachment; filename="${path.basename(filePath)}"`,
      "Content-Type": "application/octet-stream",
    },
  });
}

export async function handleFsRm(req: Request): Promise<Response> {
  const body = await req.json() as { id?: string; path?: string };
  if (!body.id) return json({ error: "Container ID is required and must be a string." }, 400);
  await afs.rm(body.id, body.path ?? "/");
  return json({ message: "File/Folder successfully removed." });
}

export async function handleFsZip(req: Request): Promise<Response> {
  const body = await req.json() as { id?: string; path?: string | string[]; zipname?: string };
  if (!body.id) return json({ error: "Container ID is required and must be a string." }, 400);
  const relativePaths = Array.isArray(body.path) ? body.path : [body.path ?? "/"];
  return json({ zipPath: await afs.zip(body.id, relativePaths, body.zipname ?? "") });
}

export async function handleFsUnzip(req: Request): Promise<Response> {
  const body = await req.json() as { id?: string; path?: string; zipname?: string };
  if (!body.id) return json({ error: "Container ID is required and must be a string." }, 400);
  await afs.unzip(body.id, body.path ?? "/", body.zipname ?? "");
  return json({ message: "File successfully unzipped." });
}

export async function handleFsRename(req: Request): Promise<Response> {
  const body = await req.json() as { id?: string; path?: string; newName?: string; newPath?: string };
  if (!body.id) return json({ error: "Container ID is required and must be a string." }, 400);
  await afs.rename(body.id, body.path ?? "/", body.newPath ?? body.newName ?? "");
  return json({ message: "File successfully renamed." });
}

export async function handleFsUpload(req: Request): Promise<Response> {
  const body = await req.json() as { id?: string; path?: string; fileContent?: unknown; fileName?: string };
  if (!body.id || !validateContainerId(body.id)) return json({ error: "Invalid container ID format." }, 400);
  if (!body.fileName || !validateFileName(body.fileName)) return json({ error: "Invalid file name." }, 400);
  if (!validatePath(body.path ?? "/")) return json({ error: "Invalid file path." }, 400);
  const targetPath = body.path === "/" || !body.path ? body.fileName : `${body.path}/${body.fileName}`;
  const content = decodeUploadContent(body.fileContent);
  if (typeof content === "string") await afs.writeFileContentHandler(body.id, targetPath, content);
  else await afs.writeFileRaw(body.id, targetPath, content);
  return json({ message: "File successfully uploaded.", fileName: body.fileName, path: targetPath });
}

export async function handleFsCreateEmpty(req: Request): Promise<Response> {
  const body = await req.json() as { id?: string; path?: string; fileName?: string };
  if (!body.id || !body.fileName) return json({ error: "File name is required." }, 400);
  const target = await afs.createEmptyFile(body.id, body.path ?? "/", body.fileName);
  return json({ message: "Empty file successfully created.", fileName: body.fileName, path: target });
}

export async function handleFsAppend(req: Request): Promise<Response> {
  const body = await req.json() as { id?: string; path?: string; fileName?: string; fileContent?: unknown; chunkIndex?: number; totalChunks?: number };
  if (!body.id || !body.fileName) return json({ error: "File name is required." }, 400);
  const target = await afs.appendFile(body.id, body.path ?? "/", body.fileName, decodeUploadContent(body.fileContent));
  return json({
    message: "Chunk successfully appended.",
    fileName: body.fileName,
    path: target,
    chunkIndex: body.chunkIndex ?? 0,
    totalChunks: body.totalChunks ?? 1,
  });
}
