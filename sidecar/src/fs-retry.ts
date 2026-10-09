import { renameSync } from "node:fs";

/**
 * Windows holds a file just written for a moment (Defender scanning a new .node, an index): renaming or removing it
 * then fails with EPERM, EACCES or EBUSY although a retry a moment later succeeds.
 */
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);

export function renameWithRetry(from: string, to: string, attempts = 8): void {
  for (let i = 0; ; i += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (i + 1 >= attempts || !code || !TRANSIENT.has(code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (i + 1)); // a short, synchronous wait
    }
  }
}

/** rmSync's own retries for the same Windows holds (it retries EBUSY, EPERM, ENOTEMPTY, …). */
export const RM_RETRY = { maxRetries: 5, retryDelay: 200 } as const;
