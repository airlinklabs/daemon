import path from 'path';
import fs from 'fs/promises';
import fileSpecifier from './util/fileSpecifier';

const sanitizePath = (base: string, relativePath: string): string => {
    const fullPath = path.join(base, relativePath);
    if (!fullPath.startsWith(base)) {
        throw new Error('Invalid path: Directory traversal is not allowed.');
    }
    return fullPath;
};

const requestCache = new Map();

const getDirectorySize = async (directory: string): Promise<number> => {
    const contents = await fs.readdir(directory, { withFileTypes: true });
    let totalSize = 0;

    for (const dirent of contents) {
        const fullPath = path.join(directory, dirent.name);
        if (dirent.isDirectory()) {
            totalSize += await getDirectorySize(fullPath);
        } else {
            const stats = await fs.stat(fullPath);
            totalSize += stats.size;
        }
    }

    return totalSize;
};

const afs = {
    async list(id: string, relativePath: string = '/', filter?: string) {
        const currentTime = Date.now();

        if (!requestCache.has(id)) {
            requestCache.set(id, { lastRequest: currentTime, count: 0, cache: null });
        }

        const rateData = requestCache.get(id);

        if (rateData.cache && currentTime - rateData.lastRequest < 1000) {
            return rateData.cache;
        }

        if (currentTime - rateData.lastRequest < 1000) {
            rateData.count += 1;
        } else {
            rateData.count = 1;
        }

        rateData.lastRequest = currentTime;

        if (rateData.count > 5) {
            rateData.cache = { error: 'Too many requests, please wait 3 seconds.' };
            setTimeout(() => requestCache.delete(id), 3000);
            return rateData.cache;
        }

        try {
            const baseDirectory = path.resolve(`volumes/${id}`);
            const targetDirectory = sanitizePath(baseDirectory, relativePath);
            const directoryContents = await fs.readdir(targetDirectory, { withFileTypes: true });
            const results = await Promise.all(directoryContents.map(async dirent => {
                const ext = path.extname(dirent.name).substring(1);
                const category = await fileSpecifier.getCategory(ext);
                let size = null;

                if (dirent.isDirectory()) {
                    const dirPath = path.join(targetDirectory, dirent.name);
                    size = await getDirectorySize(dirPath);
                } else {
                    const filePath = path.join(targetDirectory, dirent.name);
                    const stats = await fs.stat(filePath);
                    size = stats.size;
                }

                return {
                    name: dirent.name,
                    type: dirent.isDirectory() ? 'directory' : 'file',
                    extension: dirent.isDirectory() ? null : ext,
                    category: dirent.isDirectory() ? null : category,
                    size: size
                };
            }));

            const limitedResults = results.slice(0, 256);

            if (filter) {
                return limitedResults.filter(item => item.name.includes(filter));
            }

            rateData.cache = limitedResults;
            return limitedResults;
        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`Error listing directory: ${error.message}`);
            } else {
                throw new Error('An unknown error occurred.');
            }
        }
    }
};

export default afs;