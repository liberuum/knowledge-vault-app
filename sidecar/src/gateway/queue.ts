/** At most `limit` requests run at once; an interactive one (the chat) goes before waiting background ones (the pipeline). */
export function createQueue() {
  let running = 0;
  let limit = 1;
  const waiting: Array<{ interactive: boolean; start: () => void }> = [];
  const next = () => {
    while (running < limit && waiting.length > 0) {
      const i = waiting.findIndex((w) => w.interactive);
      const [item] = waiting.splice(i >= 0 ? i : 0, 1);
      running += 1;
      item!.start();
    }
  };
  return {
    setLimit(n: number) {
      limit = Math.max(1, Math.floor(n));
      next();
    },
    async run<T>(interactive: boolean, task: () => Promise<T>): Promise<T> {
      await new Promise<void>((start) => {
        waiting.push({ interactive, start });
        next();
      });
      try {
        return await task();
      } finally {
        running -= 1;
        next();
      }
    },
    stats: () => ({ running, waiting: waiting.length, limit }),
  };
}
