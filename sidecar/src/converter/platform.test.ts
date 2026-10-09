import { describe, expect, it } from "vitest";
import { hasVcRuntime } from "./platform.js";

const RUNTIME = ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll", "msvcp140_1.dll"];
const onDisk = (paths: string[]) => (path: string) => paths.some((p) => p.toLowerCase() === path.toLowerCase());
const env = { SystemRoot: "C:\\Windows", Path: 'C:\\Tools;"C:\\Program Files\\Other"' };
const app = "C:\\Program Files\\Knowledge Vault";

describe("hasVcRuntime", () => {
  it("finds the runtime where its installer puts it, System32", () => {
    expect(hasVcRuntime("win32", env, onDisk(RUNTIME.map((d) => `C:\\Windows\\System32\\${d}`)), app)).toBe(true);
  });
  it("finds it wherever Windows also looks: the app's folder and PATH folders, file by file", () => {
    const spread = ["C:\\Windows\\System32\\vcruntime140.dll", `${app}\\vcruntime140_1.dll`, "C:\\Tools\\msvcp140.dll", "C:\\Program Files\\Other\\msvcp140_1.dll"];
    expect(hasVcRuntime("win32", env, onDisk(spread), app)).toBe(true);
  });
  it("says no when one of the four is nowhere Windows looks", () => {
    const missingOne = RUNTIME.filter((d) => d !== "vcruntime140_1.dll").map((d) => `C:\\Windows\\System32\\${d}`);
    expect(hasVcRuntime("win32", env, onDisk(missingOne), app)).toBe(false);
  });
  it("is not a question anywhere but Windows", () => {
    expect(hasVcRuntime("linux", {}, () => false, "/opt/app")).toBe(true);
  });
});
