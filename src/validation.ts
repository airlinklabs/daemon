export function validateContainerId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

export function validatePath(relativePath: string): boolean {
  return typeof relativePath === "string" && !relativePath.includes("..") && !relativePath.includes("\\");
}

export function validateFileName(fileName: string): boolean {
  if (!fileName) return false;
  return ![/\.\./, /[<>:"|?*]/, /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i].some((pattern) =>
    pattern.test(fileName),
  );
}

export function validateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
