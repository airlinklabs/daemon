/**
 * Fake Clock Helper for Daemon Tests (Phase 9)
 *
 * Provides deterministic time control for tests that depend on timestamps,
 * TTLs, and time-based windows (e.g., HMAC nonce expiry, rate limiting).
 */
export class FakeClock {
  private _now: number;
  private _offset: number = 0;
  private _timers: Map<number, { callback: () => void; time: number }> = new Map();
  private _nextTimerId: number = 1;

  constructor(initialTime?: number) {
    this._now = initialTime ?? Math.floor(Date.now() / 1000);
  }

  /** Current time in seconds (Unix timestamp) */
  now(): number {
    return this._now + this._offset;
  }

  /** Current time in milliseconds */
  nowMs(): number {
    return (this._now + this._offset) * 1000;
  }

  /** Advance time by given seconds */
  advance(seconds: number): void {
    this._offset += seconds;
    this._runTimers();
  }

  /** Set time to specific timestamp */
  set(timestamp: number): void {
    this._offset = timestamp - this._now;
    this._runTimers();
  }

  /** Reset to current real time */
  reset(): void {
    this._offset = 0;
    this._timers.clear();
  }

  /** Create a timer that fires at a specific time */
  setTimeout(callback: () => void, delayMs: number): number {
    const id = this._nextTimerId++;
    const fireTime = this.nowMs() + delayMs;
    this._timers.set(id, { callback, time: fireTime });
    return id;
  }

  /** Cancel a timer */
  clearTimeout(id: number): void {
    this._timers.delete(id);
  }

  /** Run all due timers */
  private _runTimers(): void {
    const now = this.nowMs();
    for (const [id, timer] of this._timers) {
      if (now >= timer.time) {
        timer.callback();
        this._timers.delete(id);
      }
    }
  }

  /** Check if a timestamp is within a window */
  isWithinWindow(timestamp: number, windowSeconds: number): boolean {
    return Math.abs(this.now() - timestamp) <= windowSeconds;
  }

  /** Check if a timestamp is expired */
  isExpired(timestamp: number, windowSeconds: number): boolean {
    return !this.isWithinWindow(timestamp, windowSeconds);
  }
}

/**
 * Mock Date.now() for tests.
 * Call restore() in afterAll to restore the original.
 */
export function mockDateNow(clock: FakeClock): () => void {
  const original = Date.now;
  Date.now = () => clock.nowMs();
  return () => {
    Date.now = original;
  };
}

/**
 * Mock Math.random() for deterministic tests.
 * Returns a restore function.
 */
export function mockMathRandom(values: number[]): () => void {
  const original = Math.random;
  let index = 0;
  Math.random = () => {
    const value = values[index % values.length];
    index++;
    return value;
  };
  return () => {
    Math.random = original;
  };
}
