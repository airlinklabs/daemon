// Owned operation manager for detached install/reinstall operations.
//
// Replaces the anonymous async IIFEs in routes/instances.ts with a tracked,
// bounded, cancellable operation manager. Each operation (install, reinstall)
// is registered, executed with bounded concurrency, and reconciled on
// completion or failure.

import logger from '../logger';
import { setServerState } from './installState';

export type OperationKind = 'install' | 'reinstall';

export interface Operation {
  id: string;
  kind: OperationKind;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  completedAt?: string;
  error?: string;
  /** AbortController for cooperative cancellation. */
  abort: AbortController;
  /** The actual work function — called once status is 'running'. */
  work: (signal: AbortSignal) => Promise<void>;
}

const MAX_CONCURRENT = 4;

const operations = new Map<string, Operation>();
const running = new Set<string>(); // operation IDs currently executing
const waitQueue: string[] = []; // IDs waiting for a slot

function opKey(kind: OperationKind, id: string): string {
  return `${kind}:${id}`;
}

function containerBusy(id: string): boolean {
  for (const op of operations.values()) {
    if (op.id === id && (op.status === 'pending' || op.status === 'running')) return true;
  }
  return false;
}

/**
 * Enqueue a detached install or reinstall operation. Returns immediately with
 * an operation key; the actual work runs in the background with bounded
 * concurrency. Status can be polled via `getOperation()`.
 */
export function enqueueOperation(
  kind: OperationKind,
  containerId: string,
  work: (signal: AbortSignal) => Promise<void>,
): { accepted: boolean; message: string } {
  if (containerBusy(containerId)) {
    return { accepted: false, message: `operation already in progress for container ${containerId}` };
  }

  const abort = new AbortController();
  const op: Operation = {
    id: containerId,
    kind,
    status: 'pending',
    startedAt: new Date().toISOString(),
    abort,
    work,
  };

  const key = opKey(kind, containerId);
  operations.set(key, op);
  waitQueue.push(key);

  processQueue();
  return { accepted: true, message: `${kind} started for container ${containerId}` };
}

function processQueue(): void {
  while (running.size < MAX_CONCURRENT && waitQueue.length > 0) {
    const key = waitQueue.shift();
    if (!key) break;
    const op = operations.get(key);
    if (op?.status !== 'pending') continue;

    op.status = 'running';
    running.add(key);
    executeOperation(op).finally(() => {
      running.delete(key);
      processQueue();
    });
  }
}

async function executeOperation(op: Operation): Promise<void> {
  const key = opKey(op.kind, op.id);
  try {
    await op.work(op.abort.signal);
    op.status = 'completed';
    op.completedAt = new Date().toISOString();
    await setServerState(op.id, 'installed').catch((err) => {
      logger.error(`operation manager: failed to set installed state for ${op.id}`, err);
    });
    logger.info(`operation ${op.kind} completed for ${op.id}`);
  } catch (err) {
    if (op.abort.signal.aborted) {
      op.status = 'cancelled';
      op.error = 'cancelled';
    } else {
      op.status = 'failed';
      op.error = err instanceof Error ? err.message : String(err);
    }
    op.completedAt = new Date().toISOString();
    await setServerState(op.id, 'failed', op.error).catch((err) => {
      logger.error(`operation manager: failed to set failed state for ${op.id}`, err);
    });
    logger.error(`operation ${op.kind} failed for ${op.id}: ${op.error}`);
  } finally {
    operations.delete(key);
  }
}

/**
 * Cancel a running or pending operation for a container. Returns true if
 * cancellation was requested (the abort signal fires, and the operation will
 * clean up asynchronously).
 */
export function cancelOperation(kind: OperationKind, containerId: string): boolean {
  const key = opKey(kind, containerId);
  const op = operations.get(key);
  if (!op) return false;

  if (op.status === 'pending') {
    op.status = 'cancelled';
    operations.delete(key);
    const idx = waitQueue.indexOf(key);
    if (idx !== -1) waitQueue.splice(idx, 1);
    return true;
  }

  if (op.status === 'running') {
    op.abort.abort();
    return true;
  }

  return false;
}

/**
 * Get the current status of an operation for a container.
 */
export function getOperation(kind: OperationKind, containerId: string): Operation | undefined {
  return operations.get(opKey(kind, containerId));
}

/**
 * Cancel all operations and wait for running ones to finish (shutdown path).
 */
export async function shutdownOperations(timeoutMs = 10_000): Promise<void> {
  // Cancel all pending operations
  for (const key of waitQueue) {
    const op = operations.get(key);
    if (op) {
      op.status = 'cancelled';
      operations.delete(key);
    }
  }
  waitQueue.length = 0;

  // Abort all running operations
  for (const key of running) {
    const op = operations.get(key);
    if (op) op.abort.abort();
  }

  // Wait for in-flight operations to settle
  const deadline = Date.now() + timeoutMs;
  while (running.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }

  if (running.size > 0) {
    logger.warn(`${running.size} operations did not finish within ${timeoutMs}ms shutdown timeout`);
  }
}
