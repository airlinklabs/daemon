import { Router, Request, Response } from 'express';
import { scanVolume } from '../handlers/radar/scan';
import { zipScanVolume } from '../handlers/radar/zip';
import { validateContainerId } from '../utils/validation';
import logger from '../utils/logger';

const router = Router();

router.post('/radar/scan', async (req: Request, res: Response) => {
    const { id, script } = req.body;

    if (!id || !script) {
        res.status(400).json({ error: 'Container ID and script are required.' });
        return;
    }

    try {
        logger.info(`Received radar scan request for container ${id}`);
        const results = await scanVolume(id, script);
        res.status(200).json({
            success: true,
            message: `Scan completed for container ${id}`,
            results
        });
    } catch (error) {
        logger.error(`Error scanning container ${id}:`, error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        res.status(500).json({
            success: false,
            error: `Failed to scan container: ${errorMessage}`
        });
    }
});

router.post('/radar/zip', async (req: Request, res: Response) => {
    const { id, include, exclude, maxFileSizeMb } = req.body;

    if (!id || typeof id !== 'string') {
        res.status(400).json({ error: 'Container ID is required.' });
        return;
    }

    if (!validateContainerId(id)) {
        res.status(400).json({ error: 'Invalid container ID format.' });
        return;
    }

    // Validate include/exclude arrays if provided — only allow plain folder names
    const folderNamePattern = /^[a-zA-Z0-9_\-\.]+$/;

    if (include !== undefined) {
        if (!Array.isArray(include) || include.some((f: any) => typeof f !== 'string' || !folderNamePattern.test(f))) {
            res.status(400).json({ error: 'Invalid include list.' });
            return;
        }
    }

    if (exclude !== undefined) {
        if (!Array.isArray(exclude) || exclude.some((f: any) => typeof f !== 'string' || !folderNamePattern.test(f))) {
            res.status(400).json({ error: 'Invalid exclude list.' });
            return;
        }
    }

    if (maxFileSizeMb !== undefined && (typeof maxFileSizeMb !== 'number' || maxFileSizeMb < 1 || maxFileSizeMb > 32)) {
        res.status(400).json({ error: 'maxFileSizeMb must be a number between 1 and 32.' });
        return;
    }

    try {
        logger.info(`Received radar zip request for container ${id}`);
        const zipBuffer = await zipScanVolume(id, { include, exclude, maxFileSizeMb });

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="scan-${id}.zip"`);
        res.setHeader('Content-Length', zipBuffer.length);
        res.status(200).send(zipBuffer);
    } catch (error) {
        logger.error(`Error zipping container ${id}:`, error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        res.status(500).json({ success: false, error: `Failed to zip container: ${errorMessage}` });
    }
});

export default router;
