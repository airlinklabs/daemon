import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import logger from '../utils/logger';

const execAsync = promisify(exec);

export async function init() {
    const isDockerInstalled = async () => {
        const command = process.platform === 'win32' ? 'docker --version' : 'which docker';

        try {
            await execAsync(command);
        } catch (error) {
            logger.error("Docker is not installed. Please install Docker and try again.", error);
            throw error;
        }
    };

    const isDockerRunning = async () => {
        const command = process.platform === 'win32' ? 'docker ps' : 'docker ps -q';

        try {
            await execAsync(command);
        } catch (error) {
            logger.error("Docker is not running. Please start Docker and try again.", error);
            process.exit(1);
        }
    };

    const isDockerModemFix = async () => {
        // Dockerode Fix for Windows
        if (process.platform === 'win32') {
            try {
                const nodeModulesDir = path.join(__dirname, "..", '..', 'node_modules');
                const dockerModemDir = path.join(nodeModulesDir, 'docker-modem');
                const libDir = path.join(dockerModemDir, 'lib');
                const lockFilePath = path.join(libDir, 'docker_modem_fix.lock');
                const modemPath = path.join(libDir, 'modem.js');

                // Ensure directories exist
                if (!fs.existsSync(dockerModemDir)) {
                    logger.warn('docker-modem directory not found. The fix will not be applied.');
                    return;
                }

                if (!fs.existsSync(libDir)) {
                    logger.warn('docker-modem/lib directory not found. The fix will not be applied.');
                    return;
                }

                // Check if fix is already applied
                if (fs.existsSync(lockFilePath)) {
                    logger.info('Docker-modem fix already applied.');
                    return;
                }

                logger.info('Fixing docker-modem for Windows...');

                // Download the fixed modem.js file
                try {
                    const response = await axios.get(
                        'https://raw.githubusercontent.com/privt00/docker-modem/refs/heads/master/lib/modem.js',
                        {
                            responseType: 'stream',
                            timeout: 30000, // 30 second timeout
                            maxRedirects: 5,
                            validateStatus: (status) => status === 200
                        }
                    );

                    // Backup the original file if it exists
                    if (fs.existsSync(modemPath)) {
                        const backupPath = path.join(libDir, 'modem.js.backup');
                        try {
                            fs.copyFileSync(modemPath, backupPath);
                            logger.info('Original modem.js backed up.');
                        } catch (backupError) {
                            logger.warn('Failed to backup original modem.js');
                        }
                    }

                    // Save the new file
                    await new Promise<void>((resolve, reject) => {
                        const writeStream = fs.createWriteStream(modemPath);

                        writeStream.on('finish', () => resolve());
                        writeStream.on('error', (err: Error) => reject(err));

                        response.data.on('error', (err: Error) => reject(err));
                        response.data.pipe(writeStream);
                    });

                    // Create the lock file to prevent future executions
                    await fs.promises.writeFile(lockFilePath, `Docker-modem fix applied on ${new Date().toISOString()}`, { encoding: 'utf8' });
                    logger.success('Docker-modem fix applied successfully');
                } catch (downloadError) {
                    logger.error('Failed to download docker-modem fix:', downloadError);
                    throw new Error('Failed to apply docker-modem fix');
                }
            } catch (error) {
                logger.error('Error applying docker-modem fix:', error);
                // Continue execution even if the fix fails
            }
        }
    }

    const envExists = () => fs.promises.access(path.resolve(process.cwd(), '.env'), fs.constants.F_OK)
        .catch(() => {
            logger.warn(".env file not found. Please rename example.env to .env file and try again.");
            process.exit(1);
        });

    try {
        await envExists();
        await isDockerInstalled();
        await isDockerRunning();
        await isDockerModemFix();
    } catch (error) {
        logger.error("Initialization error:", error);
    }
}
