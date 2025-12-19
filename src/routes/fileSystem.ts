import { Router, Request, Response } from "express";
import afs from "../handlers/filesystem/fs";
import path from "path";
import fs from "fs/promises";
import {
  validateContainerId,
  validatePath,
  validateFileName,
} from "../utils/validation";

const router = Router();

const sanitizePath = async (
  base: string,
  relativePath: string
): Promise<string> => {
  const fullPath = path.join(base, relativePath);

  const relative = path.relative(base, fullPath);
  if (!fullPath.startsWith(base)) {
    throw new Error("Invalid path: Directory traversal is not allowed.");
  }

  let currentPath = base;
  const segments = relative.split(path.sep).filter(Boolean);

  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);

    try {
      const stats = await fs.lstat(currentPath);
      if (stats.isSymbolicLink()) {
        throw new Error(
          `Invalid path: Symlinks are not allowed (${currentPath}).`
        );
      }
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }
  }

  return fullPath;
};

interface DirectoryItem {
  name: string;
  type: "file" | "directory";
  extension?: string;
  category?: string;
  size: number;
}

router.get("/fs/list", async (req: Request, res: Response) => {
  const { id, path: relativePath = "/", filter } = req.query;

  if (!id || typeof id !== "string") {
    res
      .status(400)
      .json({ error: "Container ID is required and must be a string." });
    return;
  }

  try {
    const contents = await afs.list(
      id as string,
      relativePath as string,
      filter as string
    );
    res.json(contents);
  } catch (error) {
    if (error instanceof Error) {
      res.status(500).json({ error: error.message });
    } else {
      res.status(500).json({ error: "An unknown error occurred." });
    }
  }
});

router.get("/fs/size", async (req: Request, res: Response) => {
  const { id, path: relativePath = "/" } = req.query;

  if (!id || typeof id !== "string") {
    res
      .status(400)
      .json({ error: "Container ID is required and must be a string." });
    return;
  }

  try {
    const size = await afs.getDirectorySizeHandler(
      id as string,
      relativePath as string
    );
    res.json({ size });
  } catch (error) {
    if (error instanceof Error) {
      res.status(500).json({ error: error.message });
    } else {
      res.status(500).json({ error: "An unknown error occurred." });
    }
  }
});

router.get("/fs/info", async (req: Request, res: Response) => {
  const { id } = req.query;

  if (!id || typeof id !== "string") {
    res
      .status(400)
      .json({ error: "Container ID is required and must be a string." });
    return;
  }

  try {
    const relativePath = "/";
    const contents: DirectoryItem[] = await afs.list(
      id as string,
      relativePath
    );

    const totalSize = contents.reduce(
      (accum: number, item: DirectoryItem) => accum + (item.size || 0),
      0
    );

    const fileCount = contents.filter(
      (item: DirectoryItem) => item.type === "file"
    ).length;
    const dirCount = contents.filter(
      (item: DirectoryItem) => item.type === "directory"
    ).length;

    res.json({
      id: id,
      totalSize: totalSize,
      fileCount: fileCount,
      dirCount: dirCount,
    });
  } catch (error) {
    if (error instanceof Error) {
      res.status(500).json({ error: error.message });
    } else {
      res.status(500).json({ error: "An unknown error occurred." });
    }
  }
});

router.get("/fs/file/content", async (req: Request, res: Response) => {
  const id = typeof req.query.id === "string" ? req.query.id : undefined;
  const relativePath =
    typeof req.query.path === "string" ? req.query.path : "/";

  if (!id) {
    res
      .status(400)
      .json({ error: "Container ID is required and must be a string." });
    return;
  }

  try {
    const content = await afs.getFileContentHandler(id, relativePath);
    if (content === null) {
      res.status(404).json({
        error: "File content could not be read or is not a text file.",
      });
    } else {
      res.type("text/plain");
      res.send(content.toString());
    }
  } catch (error) {
    if (error instanceof Error) {
      res.status(500).json({ error: error.message });
    } else {
      res.status(500).json({ error: "An unknown error occurred." });
    }
  }
});

router.post("/fs/file/content", async (req: Request, res: Response) => {
  const id = typeof req.body.id === "string" ? req.body.id : undefined;
  const relativePath = typeof req.body.path === "string" ? req.body.path : "/";
  const content = typeof req.body.content === "string" ? req.body.content : "";

  if (!id) {
    res
      .status(400)
      .json({ error: "Container ID is required and must be a string." });
    return;
  }

  if (!validateContainerId(id)) {
    res.status(400).json({ error: "Invalid container ID format." });
    return;
  }

  if (!validatePath(relativePath)) {
    res.status(400).json({ error: "Invalid file path." });
    return;
  }

  try {
    await afs.writeFileContentHandler(id, relativePath, content);
    res.json({ message: "File content successfully saved." });
  } catch (error) {
    if (error instanceof Error) {
      res.status(500).json({ error: error.message });
    } else {
      res.status(500).json({ error: "An unknown error occurred." });
    }
  }
});

router.get("/fs/download", async (req: Request, res: Response) => {
  const id = typeof req.query.id === "string" ? req.query.id : undefined;
  const relativePath =
    typeof req.query.path === "string" ? req.query.path : "/";

  if (!id) {
    res
      .status(400)
      .json({ error: "Container ID is required and must be a string." });
    return;
  }

  try {
    const filePath = await afs.getFilePath(id, relativePath);

    if (!filePath) {
      res.status(404).json({ error: "File not found." });
      return;
    }

    res.download(filePath, (err) => {
      if (err) {
        res.status(500).json({ error: "Error downloading file." });
      }
    });
  } catch (error) {
    if (error instanceof Error) {
      res.status(500).json({ error: error.message });
    } else {
      res.status(500).json({ error: "An unknown error occurred." });
    }
  }
});

router.delete("/fs/rm", async (req: Request, res: Response) => {
  const id = typeof req.body.id === "string" ? req.body.id : undefined;
  const relativePath = typeof req.body.path === "string" ? req.body.path : "/";

  if (!id) {
    res
      .status(400)
      .json({ error: "Container ID is required and must be a string." });
    return;
  }
  try {
    await afs.rm(id, relativePath);
    res.json({ message: "File/Folder successfully removed." });
  } catch (error) {
    if (error instanceof Error) {
      res.status(500).json({ error: error.message });
    } else {
      res.status(500).json({ error: "An unknown error occurred." });
    }
  }
});

router.post("/fs/zip", async (req: Request, res: Response) => {
  const id = typeof req.body.id === "string" ? req.body.id : undefined;
  const relativePath = Array.isArray(req.body.path)
    ? req.body.path
    : [req.body.path || "/"];
  const zipname = typeof req.body.zipname === "string" ? req.body.zipname : "";

  if (!id) {
    res
      .status(400)
      .json({ error: "Container ID is required and must be a string." });
    return;
  }

  try {
    const zipPath = await afs.zip(id, relativePath, zipname);
    res.status(200).json({ zipPath });
  } catch (error) {
    if (error instanceof Error) {
      res.status(500).json({ error: error.message });
    } else {
      res.status(500).json({ error: "An unknown error occurred." });
    }
  }
});

router.post("/fs/unzip", async (req: Request, res: Response) => {
  const id = typeof req.body.id === "string" ? req.body.id : undefined;
  const relativePath = typeof req.body.path === "string" ? req.body.path : "/";
  const zipname = typeof req.body.zipname === "string" ? req.body.zipname : "";

  if (!id) {
    res
      .status(400)
      .json({ error: "Container ID is required and must be a string." });
    return;
  }

  try {
    await afs.unzip(id, relativePath, zipname);
    res.json({ message: "File successfully unzipped." });
  } catch (error) {
    if (error instanceof Error) {
      res.status(500).json({ error: error.message });
    } else {
      res.status(500).json({ error: "An unknown error occurred." });
    }
  }
});

router.post("/fs/rename", async (req: Request, res: Response) => {
  const id = typeof req.body.id === "string" ? req.body.id : undefined;
  const relativePath = typeof req.body.path === "string" ? req.body.path : "/";
  const newName = typeof req.body.newName === "string" ? req.body.newName : "";
  const newPath =
    typeof req.body.newPath === "string" ? req.body.newPath : newName;

  if (!id) {
    res
      .status(400)
      .json({ error: "Container ID is required and must be a string." });
    return;
  }

  try {
    await afs.rename(id, relativePath, newPath);
    res.json({ message: "File successfully renamed." });
  } catch (error) {
    if (error instanceof Error) {
      res.status(500).json({ error: error.message });
    } else {
      res.status(500).json({ error: "An unknown error occurred." });
    }
  }
});

router.post("/fs/upload", async (req: Request, res: Response) => {
  const id = typeof req.body.id === "string" ? req.body.id : undefined;
  const relativePath = typeof req.body.path === "string" ? req.body.path : "/";
  const fileContent = req.body.fileContent;
  const fileName =
    typeof req.body.fileName === "string" ? req.body.fileName : "";

  console.log(
    `Upload request received for file ${fileName} to path ${relativePath} for container ${id}`
  );

  if (!id) {
    console.error("Upload error: Container ID is required");
    res
      .status(400)
      .json({ error: "Container ID is required and must be a string." });
    return;
  }

  if (!validateContainerId(id)) {
    res.status(400).json({ error: "Invalid container ID format." });
    return;
  }

  if (!fileName) {
    console.error("Upload error: File name is required");
    res.status(400).json({ error: "File name is required." });
    return;
  }

  if (!validateFileName(fileName)) {
    res.status(400).json({ error: "Invalid file name." });
    return;
  }

  if (!validatePath(relativePath)) {
    res.status(400).json({ error: "Invalid file path." });
    return;
  }

  if (!fileContent) {
    console.error("Upload error: File content is required");
    res.status(400).json({ error: "File content is required." });
    return;
  }

  try {
    const targetPath =
      relativePath === "/" ? fileName : `${relativePath}/${fileName}`;
    console.log(`Normalized target path: ${targetPath}`);

    let content;
    if (typeof fileContent === "string") {
      if (fileContent.includes("base64")) {
        console.log("Processing base64 content");
        const base64Match = fileContent.match(/^data:[^;]+;base64,(.+)$/);
        if (base64Match && base64Match[1]) {
          try {
            content = Buffer.from(base64Match[1], "base64");
            console.log(
              `Converted base64 to buffer of size: ${content.length} bytes`
            );
          } catch (e) {
            console.error("Error decoding base64:", e);
            res.status(400).json({ error: "Failed to decode base64 content." });
            return;
          }
        } else {
          console.error("Invalid base64 format");
          res.status(400).json({ error: "Invalid base64 format." });
          return;
        }
      } else {
        console.log("Using string content as-is");
        content = fileContent;
      }
    } else if (Buffer.isBuffer(fileContent)) {
      console.log("Content is already a buffer");
      content = fileContent;
    } else {
      console.error("Unsupported content type:", typeof fileContent);
      res.status(400).json({ error: "Unsupported content type." });
      return;
    }

    // Create the base directory if it doesn't exist
    const baseDirectory = path.resolve(`volumes/${id}`);
    const filePath = await sanitizePath(baseDirectory, targetPath);
    const dir = path.dirname(filePath);

    try {
      await fs.mkdir(dir, { recursive: true });
      console.log(`Directory created/verified: ${dir}`);
    } catch (e) {
      console.error("Error creating directory:", e);
      res.status(500).json({ error: "Failed to create directory." });
      return;
    }

    try {
      await fs.writeFile(filePath, content);
      console.log(`File written successfully to ${filePath}`);
    } catch (e) {
      console.error("Error writing file:", e);
      res.status(500).json({ error: "Failed to write file." });
      return;
    }

    console.log(`File ${fileName} successfully uploaded to ${targetPath}`);
    res.json({
      message: "File successfully uploaded.",
      fileName: fileName,
      path: targetPath,
    });
  } catch (error) {
    console.error("Error during file upload:", error);
    if (error instanceof Error) {
      res.status(500).json({ error: error.message });
    } else {
      res.status(500).json({ error: "An unknown error occurred." });
    }
  }
});

router.post("/fs/create-empty-file", async (req: Request, res: Response) => {
  const id = typeof req.body.id === "string" ? req.body.id : undefined;
  const relativePath = typeof req.body.path === "string" ? req.body.path : "/";
  const fileName =
    typeof req.body.fileName === "string" ? req.body.fileName : "";

  console.log(
    `Create empty file request received for ${fileName} in path ${relativePath} for container ${id}`
  );

  if (!id) {
    console.error("Create empty file error: Container ID is required");
    res
      .status(400)
      .json({ error: "Container ID is required and must be a string." });
    return;
  }

  if (!fileName) {
    console.error("Create empty file error: File name is required");
    res.status(400).json({ error: "File name is required." });
    return;
  }

  try {
    const targetPath =
      relativePath === "/" ? fileName : `${relativePath}/${fileName}`;
    console.log(`Normalized target path: ${targetPath}`);

    const baseDirectory = path.resolve(`volumes/${id}`);
    const filePath = await sanitizePath(baseDirectory, targetPath);
    const dir = path.dirname(filePath);

    try {
      await fs.mkdir(dir, { recursive: true });
      console.log(`Directory created/verified: ${dir}`);
    } catch (e) {
      console.error("Error creating directory:", e);
      res.status(500).json({ error: "Failed to create directory." });
      return;
    }

    try {
      await fs.writeFile(filePath, "");
      console.log(`Empty file created at ${filePath}`);
    } catch (e) {
      console.error("Error creating empty file:", e);
      res.status(500).json({ error: "Failed to create empty file." });
      return;
    }

    res.json({
      message: "Empty file successfully created.",
      fileName: fileName,
      path: targetPath,
    });
  } catch (error) {
    console.error("Error creating empty file:", error);
    if (error instanceof Error) {
      res.status(500).json({ error: error.message });
    } else {
      res.status(500).json({ error: "An unknown error occurred." });
    }
  }
});

router.post("/fs/append-file", async (req: Request, res: Response) => {
  const id = typeof req.body.id === "string" ? req.body.id : undefined;
  const relativePath = typeof req.body.path === "string" ? req.body.path : "/";
  const fileName =
    typeof req.body.fileName === "string" ? req.body.fileName : "";
  const fileContent = req.body.fileContent;
  const chunkIndex =
    typeof req.body.chunkIndex === "number" ? req.body.chunkIndex : 0;
  const totalChunks =
    typeof req.body.totalChunks === "number" ? req.body.totalChunks : 1;

  console.log(
    `Append file request received for ${fileName} chunk ${
      chunkIndex + 1
    }/${totalChunks} in path ${relativePath} for container ${id}`
  );

  if (!id) {
    console.error("Append file error: Container ID is required");
    res
      .status(400)
      .json({ error: "Container ID is required and must be a string." });
    return;
  }

  if (!fileName) {
    console.error("Append file error: File name is required");
    res.status(400).json({ error: "File name is required." });
    return;
  }

  if (!fileContent) {
    console.error("Append file error: File content is required");
    res.status(400).json({ error: "File content is required." });
    return;
  }

  try {
    const targetPath =
      relativePath === "/" ? fileName : `${relativePath}/${fileName}`;
    console.log(`Normalized target path: ${targetPath}`);

    let content;
    if (typeof fileContent === "string") {
      if (fileContent.includes("base64")) {
        console.log("Processing base64 content for chunk");
        const base64Match = fileContent.match(/^data:[^;]+;base64,(.+)$/);
        if (base64Match && base64Match[1]) {
          try {
            content = Buffer.from(base64Match[1], "base64");
            console.log(
              `Converted base64 to buffer of size: ${
                content.length
              } bytes for chunk ${chunkIndex + 1}/${totalChunks}`
            );
          } catch (e) {
            console.error("Error decoding base64:", e);
            res.status(400).json({ error: "Failed to decode base64 content." });
            return;
          }
        } else {
          console.error("Invalid base64 format");
          res.status(400).json({ error: "Invalid base64 format." });
          return;
        }
      } else {
        console.log("Using string content as-is");
        content = fileContent;
      }
    } else if (Buffer.isBuffer(fileContent)) {
      console.log("Content is already a buffer");
      content = fileContent;
    } else {
      console.error("Unsupported content type:", typeof fileContent);
      res.status(400).json({ error: "Unsupported content type." });
      return;
    }

    const baseDirectory = path.resolve(`volumes/${id}`);
    const filePath = await sanitizePath(baseDirectory, targetPath);

    try {
      if (typeof content === "string") {
        await fs.appendFile(filePath, content, "utf8");
      } else {
        await fs.appendFile(filePath, content);
      }
      console.log(
        `Appended chunk ${chunkIndex + 1}/${totalChunks} to file ${filePath}`
      );
    } catch (e) {
      console.error("Error appending to file:", e);
      res.status(500).json({ error: "Failed to append to file." });
      return;
    }

    res.json({
      message: "Chunk successfully appended.",
      fileName: fileName,
      path: targetPath,
      chunkIndex: chunkIndex,
      totalChunks: totalChunks,
    });
  } catch (error) {
    console.error("Error appending to file:", error);
    if (error instanceof Error) {
      res.status(500).json({ error: error.message });
    } else {
      res.status(500).json({ error: "An unknown error occurred." });
    }
  }
});

export default router;
