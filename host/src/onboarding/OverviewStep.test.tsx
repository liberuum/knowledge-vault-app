// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The guide's intake is the vault package's; this screen's cards do not need it.
vi.mock("./vault-intake.js", () => ({ vaultIntake: () => null, ensureAutoPublish: () => {} }));
import { OverviewStep } from "./OverviewStep.js";

const info = { origin: "http://127.0.0.1:4201", controlOrigin: "http://127.0.0.1:4202", controlToken: "t" } as never;
const kept = new Map<string, string>();
beforeEach(() => {
  kept.clear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => void kept.set(k, v),
    removeItem: (k: string) => void kept.delete(k),
    key: (i: number) => [...kept.keys()][i] ?? null,
    get length() {
      return kept.size;
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const card = (title: string) => screen.getByText(title).closest("button")!;

describe("the guide's overview cards", () => {
  it("tick the view once it is opened, and record it for the front page's Getting started", () => {
    const onVisit = vi.fn();
    render(<OverviewStep info={info} vaultId="v1" onVisit={onVisit} onRuns={vi.fn()} onFinish={vi.fn()} />);
    expect(within(card("Read your notes")).queryByText("Explored")).toBeNull();
    fireEvent.click(card("Read your notes"));
    expect(onVisit).toHaveBeenCalledWith("notes");
    expect(card("Read your notes").getAttribute("data-done")).toBe("true");
    expect(within(card("Read your notes")).getByText("Explored")).toBeTruthy();
    expect(JSON.parse(kept.get("kv-getting-started:v1")!)).toEqual({ readNotes: true });
  });

  it("tick the chat once a question was asked in it, as the front page does", () => {
    kept.set("bai-chat:v1:v1", JSON.stringify([{ messages: [{ role: "user", content: "What is in here?" }] }]));
    kept.set("kv-getting-started:v1", JSON.stringify({ explored: { graph: true } }));
    render(<OverviewStep info={info} vaultId="v1" onVisit={vi.fn()} onRuns={vi.fn()} onFinish={vi.fn()} />);
    expect(within(card("Chat with your vault")).getByText("Asked")).toBeTruthy();
    expect(within(card("See how ideas connect")).getByText("Explored")).toBeTruthy();
    expect(card("Search by meaning").getAttribute("data-done")).toBe("false");
  });
});
