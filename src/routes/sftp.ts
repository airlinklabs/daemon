import { Router, Request, Response } from "express";
import {
  generateCredential,
  revokeCredentialForContainer,
  getActiveSessionCount,
} from "../handlers/sftp/sftpManager";
import { validateContainerId } from "../utils/validation";
import logger from "../utils/logger";

const router = Router();

router.post("/sftp/credentials", async (req: Request, res: Response) => {
  const { id } = req.body;

  if (!id || typeof id !== "string") {
    res.status(400).json({ error: "Container ID is required." });
    return;
  }

  if (!validateContainerId(id)) {
    res.status(400).json({ error: "Invalid container ID format." });
    return;
  }

  try {
    const credential = await generateCredential(id);
    res.json({
      username: credential.username,
      password: credential.password,
      host: credential.host,
      port: credential.port,
      expiresAt: credential.expiresAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate SFTP credentials.";
    logger.error(`SFTP credential generation failed for ${id}:`, error);
    res.status(500).json({ error: message });
  }
});

router.delete("/sftp/credentials", async (req: Request, res: Response) => {
  const { id } = req.body;

  if (!id || typeof id !== "string") {
    res.status(400).json({ error: "Container ID is required." });
    return;
  }

  if (!validateContainerId(id)) {
    res.status(400).json({ error: "Invalid container ID format." });
    return;
  }

  try {
    await revokeCredentialForContainer(id);
    res.json({ message: "SFTP credentials revoked." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to revoke SFTP credentials.";
    logger.error(`SFTP credential revocation failed for ${id}:`, error);
    res.status(500).json({ error: message });
  }
});

router.get("/sftp/status", async (_req: Request, res: Response) => {
  res.json({ activeSessions: getActiveSessionCount() });
});

export default router;
