// Centralised filesystem roots for the daemon.
//
// Every module that reads or writes under the daemon's data directory should
// receive a `DaemonPaths` instance instead of calling `process.cwd()`.
// Production defaults derive from the daemon's working directory; tests pass
// a `mkdtemp` fixture root.

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type DaemonPaths = {
  /** Base directory (typically process.cwd() or the fixture root). */
  base: string;
  /** Server container volumes — `<base>/volumes/<containerId>`. */
  volumesRoot: string;
  /** Backup archives — `<base>/backups`. */
  backupsRoot: string;
  /** Persistent daemon state — `<base>/storage`. */
  storageRoot: string;
  /** Install state, SFTP host key, containerConfigs, systemStats, etc. */
  storageConfigRoot: string;
  /** Log files — `<base>/.airlinkd/logs`. */
  logsRoot: string;
  /** Runtime FIFO / init scripts live inside each volume, but the base
   *  `.airlinkd` directory is shared. */
  runtimeRoot: string;
  /** Alc cache files — `<base>/storage/alc/files`. */
  alcFilesRoot: string;
};

/**
 * Resolve, create, and validate all daemon directories.
 * Called once at startup (bootstrap or test setup).
 */
export function resolveDaemonPaths(baseDir: string): DaemonPaths {
  const base = resolve(baseDir);

  const paths: DaemonPaths = {
    base,
    volumesRoot: resolve(base, 'volumes'),
    backupsRoot: resolve(base, 'backups'),
    storageRoot: resolve(base, 'storage'),
    storageConfigRoot: resolve(base, 'storage'),
    logsRoot: resolve(base, '.airlinkd', 'logs'),
    runtimeRoot: resolve(base, '.airlinkd'),
    alcFilesRoot: resolve(base, 'storage', 'alc', 'files'),
  };

  // Ensure all roots exist with safe permissions. A root that exists but is
  // a file instead of a directory is a fatal config error.
  for (const [label, dir] of Object.entries(paths) as [string, string][]) {
    if (label === 'base') continue;
    try {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      } else {
        const st = statSync(dir);
        if (!st.isDirectory()) {
          throw new Error(`[paths] ${label} exists but is not a directory: ${dir}`);
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EACCES') {
        throw new Error(`[paths] FATAL: cannot create or access ${label} at ${dir} — check permissions`);
      }
      throw err;
    }
  }

  return paths;
}

/** Convenience: volume path for a specific container. */
export function volumePathFor(paths: DaemonPaths, containerId: string): string {
  return resolve(paths.volumesRoot, containerId);
}

/** Convenience: backups path for a specific container. */
export function backupsPathFor(paths: DaemonPaths, containerId: string): string {
  return join(paths.backupsRoot, containerId);
}

/**
 * Lazily resolve paths. In production, config.paths is set by bootstrap.ts
 * before any handler runs. In tests, config.paths is undefined — fall back
 * to process.cwd() so tests don't need to mock bootstrap.
 */
export function getPaths(configPaths: DaemonPaths | undefined): DaemonPaths {
  if (configPaths) return configPaths;
  return resolveDaemonPaths(process.cwd());
}
