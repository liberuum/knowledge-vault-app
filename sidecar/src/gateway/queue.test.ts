import { describe, expect, it } from "vitest";
import { createQueue } from "./queue.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe("createQueue", () => {
  it("runs at most `limit` at once, and an interactive request goes before waiting background ones", async () => {
    const q = createQueue();
    q.setLimit(1);
    const order: string[] = [];
    const first = deferred();
    const a = q.run(false, async () => { order.push("a"); await first.promise; });
    const b = q.run(false, async () => { order.push("b"); });
    const chat = q.run(true, async () => { order.push("chat"); });
    expect(q.stats()).toEqual({ running: 1, waiting: 2, limit: 1 });
    first.resolve();
    await Promise.all([a, b, chat]);
    expect(order).toEqual(["a", "chat", "b"]);
  });
  it("frees its place when a task throws", async () => {
    const q = createQueue();
    q.setLimit(1);
    await expect(q.run(false, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(q.run(false, async () => 7)).resolves.toBe(7);
  });
});
