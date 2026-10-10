// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultLoader } from "./VaultLoader.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("VaultLoader", () => {
  it("says what is opening and from where, as a status the screen reader announces", () => {
    render(<VaultLoader label="Opening Powerhouse Knowledge…" detail="from switchboard.example" />);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Opening Powerhouse Knowledge…");
    expect(status.textContent).toContain("from switchboard.example");
    expect(status.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("says why it is still waiting once the wait runs long, in place of the detail", async () => {
    vi.useFakeTimers();
    render(<VaultLoader label="Opening the vault…" detail="from switchboard.example" slow="Still waiting for switchboard.example to answer." slowAfterMs={5000} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(4900); });
    expect(screen.queryByText(/Still waiting/)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(screen.getByText("Still waiting for switchboard.example to answer.")).toBeTruthy();
    expect(screen.queryByText("from switchboard.example")).toBeNull();
  });

  it("continues, rather than fading in again, when it takes over from a loader that was just on screen", () => {
    const first = render(<VaultLoader label="Opening the vault…" />);
    first.unmount();
    render(<VaultLoader label="Opening Powerhouse Knowledge…" />);
    expect(screen.getByRole("status").hasAttribute("data-continues")).toBe(true);
  });

  it("continues when it replaces another in the same render, as one screen hands over to the next", () => {
    let next = () => {};
    function Handover() {
      const [stage, setStage] = useState(0);
      next = () => setStage(1);
      return stage === 0 ? <VaultLoader key="a" label="Opening the vault…" /> : <VaultLoader key="b" label="Opening Powerhouse Knowledge…" />;
    }
    render(<Handover />);
    act(() => next());
    expect(screen.getByRole("status").textContent).toContain("Opening Powerhouse Knowledge…");
    expect(screen.getByRole("status").hasAttribute("data-continues")).toBe(true);
  });
});
