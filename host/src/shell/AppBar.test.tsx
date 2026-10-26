// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AppBar } from "./AppBar.js";

afterEach(cleanup);

describe("AppBar", () => {
  it("goes back to the vaults by default", () => {
    render(<AppBar title="A vault" onBack={() => {}} />);
    expect(screen.getByRole("button", { name: "← Vaults" })).toBeTruthy();
  });

  it("says where Back goes when it is somewhere else: the setup guide that sent the person here", () => {
    render(<AppBar title="A vault" onBack={() => {}} backLabel="Setup guide" />);
    expect(screen.getByRole("button", { name: "← Setup guide" })).toBeTruthy();
  });
});
