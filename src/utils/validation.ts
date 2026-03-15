
export function validateContainerId(id: string): boolean {
    if (!id || typeof id !== 'string') {
        return false;
    }
    
    // Allow alphanumeric characters, hyphens, and underscores
    // Typical Docker container ID or UUID format
    return /^[a-zA-Z0-9_-]+$/.test(id) && id.length >= 1 && id.length <= 64;
}

export function validatePath(relativePath: string): boolean {
    if (!relativePath || typeof relativePath !== 'string') {
        return false;
    }
    
    // Prevent directory traversal attempts
    if (relativePath.includes('..') || relativePath.includes('\\')) {
        return false;
    }
    
    return true;
}

export function validateFileName(fileName: string): boolean {
    if (!fileName || typeof fileName !== 'string') {
        return false;
    }
    
    // Prevent dangerous file names
    const dangerousPatterns = [
        /\.\./,  // Directory traversal
        /[<>:"|?*]/,
        /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i,
    ];
    
    return !dangerousPatterns.some(pattern => pattern.test(fileName));
}

export function validateUrl(url: string): boolean {
    if (!url || typeof url !== 'string') {
        return false;
    }
    
    try {
        const urlObj = new URL(url);
        return ['http:', 'https:'].includes(urlObj.protocol);
    } catch {
        return false;
    }
}
