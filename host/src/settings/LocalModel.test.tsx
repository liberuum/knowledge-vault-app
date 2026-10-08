// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LOCAL_ENDPOINT, LAST_URL_KEY, LocalModel } from "./LocalModel.js";

const hosted = { local: false, endpoint: "https://openrouter.ai/api/v1", model: "x/y" };
const failing = vi.fn(async (endpoint: string) => ({ ok: false as const, endpoint, detail: "Could not reach " + endpoint }));

let mem = new Map<string, string>();
const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
beforeEach(() => (mem = new Map()));
afterEach(cleanup);

async function typeAndConnect(address: string) {
  fireEvent.click(await screen.findByRole("button", { name: "Use a local model…" }));
  fireEvent.change(screen.getByLabelText("Local server address"), { target: { value: address } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await screen.findByText(/Could not connect/);
}

describe("LocalModel: the address the user typed", () => {
  it("is still there after a failed connect, Cancel and coming back to the page", async () => {
    const first = render(<LocalModel current={hosted} probe={failing} use={vi.fn()} storage={storage} />);
    await typeAndConnect("http://192.168.1.20:11434/v1");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    first.unmount(); // left Settings › Models
    render(<LocalModel current={hosted} probe={failing} use={vi.fn()} storage={storage} />);
    fireEvent.click(await screen.findByRole("button", { name: "Use a local model…" }));
    expect((screen.getByLabelText("Local server address") as HTMLInputElement).value).toBe("http://192.168.1.20:11434/v1");
  });

  it("starts from the default the first time, and from the saved endpoint when a local model is in use", async () => {
    const first = render(<LocalModel current={hosted} probe={failing} use={vi.fn()} storage={storage} />);
    fireEvent.click(await screen.findByRole("button", { name: "Use a local model…" }));
    expect((screen.getByLabelText("Local server address") as HTMLInputElement).value).toBe(DEFAULT_LOCAL_ENDPOINT);
    first.unmount();
    storage.setItem(LAST_URL_KEY, "http://127.0.0.1:9000/v1");
    render(<LocalModel current={{ local: true, endpoint: "http://127.0.0.1:8083/v1", model: "qwen" }} probe={failing} use={vi.fn()} storage={storage} />);
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    expect((screen.getByLabelText("Local server address") as HTMLInputElement).value).toBe("http://127.0.0.1:8083/v1");
  });
});
