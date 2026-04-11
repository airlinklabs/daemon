export function validateContainerId(id: string): boolean {
  if (!id || typeof id !== 'string') return false;
  return /^[a-zA-Z0-9_-]+$/.test(id) && id.length >= 1 && id.length <= 64;
}

export function validatePath(relativePath: string): boolean {
  if (!relativePath || typeof relativePath !== 'string') return false;
  if (relativePath.includes('..') || relativePath.includes('\\')) return false;
  return true;
}

export function validateFileName(fileName: string): boolean {
  if (!fileName || typeof fileName !== 'string') return false;
  const bad = [/\.\./, /[<>:"|?*]/, /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i];
  return !bad.some(p => p.test(fileName));
}

export function validateUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return ['http:', 'https:'].includes(u.protocol);
  } catch {
    return false;
  }
}

export function validatePort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}
