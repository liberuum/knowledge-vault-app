// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StartupProgress } from "./StartupProgress.js";

const stateOf = (label: string) => screen.getByText(label).closest("li")!.getAttribute("data-state");

describe("StartupProgress", () => {
  afterEach(cleanup);
  it("shows the stages with the one under way marked, those before it done and those after pending", () => {
    render(<StartupProgress progress={{ reached: 4, latest: "[switchboard] Using PGlite (PG17) for reactor storage" }} preparing={false} />);
    expect(stateOf("Starting the engine")).toBe("done");
    expect(stateOf("Opening your vaults")).toBe("done");
    expect(stateOf("Waking the graph index")).toBe("current");
    expect(stateOf("Registering the API")).toBe("pending");
    expect(stateOf("Ready")).toBe("pending");
    expect(screen.getByText("[switchboard] Using PGlite (PG17) for reactor storage")).toBeTruthy();
  });

  it("starts at the first stage with nothing heard yet, and hides the unpack row on launches that do not unpack", () => {
    render(<StartupProgress progress={{ reached: -1, latest: null }} preparing={false} />);
    expect(screen.queryByText("Unpacking the engine")).toBeNull();
    expect(stateOf("Starting the engine")).toBe("current");
  });

  it("shows unpacking as the stage under way while the shell unpacks the engine", () => {
    render(<StartupProgress progress={{ reached: -1, latest: null }} preparing />);
    expect(stateOf("Unpacking the engine")).toBe("current");
    expect(stateOf("Starting the engine")).toBe("pending");
  });

  it("is announced as busy to assistive technology", () => {
    render(<StartupProgress progress={{ reached: -1, latest: null }} preparing={false} />);
    expect(screen.getByRole("region", { name: "Starting the vault engine", busy: true })).toBeTruthy();
  });
});
