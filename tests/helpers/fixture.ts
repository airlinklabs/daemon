/**
 * Test Isolation Helpers for Daemon Tests (Phase 9)
 *
 * Provides mkdtemp-based fixture roots instead of CWD-relative paths.
 * Prevents test pollution and makes tests portable.
 */
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll } from 'bun:test';

export interface TestFixture {
  /** Unique temp directory for this test suite */
  root: string;
  /** volumes/ subdirectory */
  volumes: string;
  /** storage/ subdirectory */
  storage: string;
  /** backups/ subdirectory */
  backups: string;
  /** logs/ subdirectory */
  logs: string;
  /** cleanup function */
  cleanup: () => Promise<void>;
}

/**
 * Creates an isolated test fixture with temporary directories.
 * Automatically cleans up after the test suite.
 *
 * @param prefix - Optional prefix for the temp directory name
 * @returns TestFixture with paths and cleanup function
 */
export async function createTestFixture(prefix: string = 'airlink-test-'): Promise<TestFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));

  const volumes = join(root, 'volumes');
  const storage = join(root, 'storage');
  const backups = join(root, 'backups');
  const logs = join(root, 'logs');

  await mkdir(volumes, { recursive: true });
  await mkdir(storage, { recursive: true });
  await mkdir(backups, { recursive: true });
  await mkdir(logs, { recursive: true });

  const cleanup = async () => {
    try {
      await rm(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  };

  // Register cleanup after all tests
  afterAll(cleanup);

  return { root, volumes, storage, backups, logs, cleanup };
}

/**
 * Creates a mock container volume with the expected structure.
 *
 * @param fixture - Test fixture
 * @param containerId - Container ID
 * @returns Path to the container volume
 */
export async function createContainerVolume(
  fixture: TestFixture,
  containerId: string,
): Promise<string> {
  const volumePath = join(fixture.volumes, containerId);
  await mkdir(volumePath, { recursive: true });
  return volumePath;
}

/**
 * Creates a mock server config file.
 *
 * @param fixture - Test fixture
 * @param containerId - Container ID
 * @param config - Config object
 */
export async function createServerConfig(
  fixture: TestFixture,
  containerId: string,
  config: Record<string, unknown>,
): Promise<string> {
  const volumePath = join(fixture.volumes, containerId);
  await mkdir(volumePath, { recursive: true });

  const configPath = join(volumePath, 'server.properties');
  const content = Object.entries(config)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  await writeFile(configPath, content, 'utf8');
  return configPath;
}

/**
 * Creates a mock backup file.
 *
 * @param fixture - Test fixture
 * @param uuid - Backup UUID
 * @param data - Backup data
 */
export async function createBackupFile(
  fixture: TestFixture,
  uuid: string,
  data: Buffer | string = 'mock backup data',
): Promise<string> {
  const backupPath = join(fixture.backups, `${uuid}.tar.gz`);
  await writeFile(backupPath, data);
  return backupPath;
}

/**
 * Helper to create a mock Request object.
 */
export function createRequest(
  url: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Request {
  const { method = 'POST', body, headers = {} } = options;

  return new Request(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/**
 * Helper to read JSON response.
 */
export async function readJsonResponse<T = unknown>(res: Response): Promise<T> {
  const text = await res.text();
  return JSON.parse(text) as T;
}

/**
 * Mock DaemonPaths for testing.
 */
export function createMockPaths(fixture: TestFixture) {
  return {
    base: fixture.root,
    volumesRoot: fixture.volumes,
    backupsRoot: fixture.backups,
    storageRoot: fixture.storage,
    logsRoot: fixture.logs,
    runtimeRoot: join(fixture.root, 'runtime'),
    alcFilesRoot: join(fixture.root, 'alc-files'),
  };
}
