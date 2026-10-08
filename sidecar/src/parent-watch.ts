/**
 * A safety net for the engine: when the shell (or the dev loop) that spawned it dies without
 * closing the pipe — killed, crashed, SIGBUS from a replaced AppImage — the engine is re-parented
 * to init. Polling the parent pid catches that and asks for the same graceful stop as a closed stdin,
 * so no engine lingers holding the store's lock and port after its window is gone.
 */
export function watchParent(opts: { getPpid: () => number; onGone: () => void; intervalMs?: number; setInterval?: typeof globalThis.setInterval }): () => void {
  const schedule = opts.setInterval ?? globalThis.setInterval;
  const initial = opts.getPpid();
  let fired = false;
  const handle = schedule(() => {
    if (fired) return;
    const now = opts.getPpid();
    if (now !== initial) {
      fired = true;
      opts.onGone();
    }
  }, opts.intervalMs ?? 2000);
  if (typeof handle === "object" && handle && "unref" in handle) (handle as { unref(): void }).unref();
  return () => clearInterval(handle);
}
