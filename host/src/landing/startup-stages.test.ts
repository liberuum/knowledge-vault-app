import { describe, expect, it } from "vitest";
import { STAGES, advance, currentStageLabel, stageOfLine, type Progress } from "./startup-stages.js";

const start: Progress = { reached: 0, latest: null };

describe("start-up stages", () => {
  it("recognises the engine's milestones in order", () => {
    expect(stageOfLine("[sidecar] checking the store")).toBe("store");
    expect(stageOfLine("[10:08:38.67] [reactor-api][package-manager] Loading packages: /x/@powerhousedao/knowledge-note")).toBe("package");
    expect(stageOfLine("[10:08:38.77] [switchboard] Using PGlite (PG17) for reactor storage at /x/vault/reactor")).toBe("vaults");
    expect(stageOfLine("[GraphIndexer] Processor created for drive: abc (app: knowledge-vault)")).toBe("index");
    expect(stageOfLine("[10:08:40.95] [switchboard][reactor-api][graphql-manager] Registered /graphql supergraph ")).toBe("api");
    expect(stageOfLine("[10:08:45.40] [switchboard] Workflow runtime started")).toBe("pipeline");
    expect(stageOfLine("[sidecar]   \"MCP_ENABLED\": true,")).toBeNull();
    expect(stageOfLine("(node:1) [DEP0205] DeprecationWarning")).toBeNull();
  });

  it("only moves forward: a later milestone marks every earlier one done, an earlier line never moves it back", () => {
    let p = advance(start, "[10:08:40.95] [switchboard][reactor-api][graphql-manager] Registered /graphql supergraph");
    expect(STAGES[p.reached]?.id).toBe("api");
    p = advance(p, "[10:08:38.77] [switchboard] Using PGlite (PG17) for reactor storage at /x");
    expect(STAGES[p.reached]?.id).toBe("api");
  });

  it("keeps the latest line for the 'what is happening' detail, without timestamps or the engine prefix", () => {
    const p = advance(start, "[sidecar] [10:08:39.44] [switchboard][reactor-api][graphql-manager] Registered /graphql/analytics subgraph.");
    expect(p.latest).toBe("[switchboard][reactor-api][graphql-manager] Registered /graphql/analytics subgraph.");
  });

  it("ignores the noise lines (JSON fragments, deprecation warnings, blanks) for the detail too", () => {
    const p = advance({ reached: 2, latest: "kept" }, "   \"MCP_ENABLED\": true,");
    expect(p.latest).toBe("kept");
    expect(advance(p, "(node:1) [DEP0205] DeprecationWarning: x").latest).toBe("kept");
    expect(advance(p, "").latest).toBe("kept");
  });

  it("lists the stages a user can follow, unpacking first and ready last", () => {
    expect(STAGES[0]?.id).toBe("unpack");
    expect(STAGES[STAGES.length - 1]?.id).toBe("ready");
    for (const s of STAGES) expect(s.label.length).toBeGreaterThan(3);
  });

  it("names the stage under way: unpacking only while the shell unpacks, the start before any line, the next milestone after one", () => {
    expect(currentStageLabel({ reached: -1, latest: null }, true)).toBe("Unpacking the engine");
    expect(currentStageLabel({ reached: -1, latest: null }, false)).toBe("Starting the engine");
    const p = advance({ reached: -1, latest: null }, "[switchboard] Using PGlite (PG17) for reactor storage at /x");
    expect(currentStageLabel(p, false)).toBe("Waking the graph index");
    const done = advance(p, "[switchboard] Workflow runtime started");
    expect(currentStageLabel(done, false)).toBe("Ready");
  });
});
