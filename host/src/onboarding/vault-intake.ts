import * as knowledgeNote from "@powerhousedao/knowledge-note";

/**
 * The vault package's own intake, driven from the guide (vault package ≥ the release with `hostIntake`): the same
 * per-vault store as the Sources view, converting and filing each file as it goes. Read through the namespace so
 * the app still builds against an older package; there it is undefined and the guide hands files to the vault.
 */
export type IntakeFileView = {
  id: string;
  name: string;
  state: "queued" | "converting" | "converted" | "failed";
  error?: string;
  publishedIds?: string[];
  progress?: { phase: string; pages: number | null; pagesDone: number };
};
export type IntakeView = { files: readonly IntakeFileView[]; publishing: boolean };
export type HostIntake = {
  add(files: readonly File[]): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): IntakeView;
  publishAsConverted(): () => void;
};

export function vaultIntake(driveId: string): HostIntake | null {
  const make = (knowledgeNote as unknown as { hostIntake?: (driveId: string) => HostIntake }).hostIntake;
  return typeof make === "function" ? make(driveId) : null;
}

const publishing = new Set<string>();
/** Publish each converted file as it converts, for this vault, for as long as the app runs — also after the guide. */
export function ensureAutoPublish(driveId: string, intake: HostIntake): void {
  if (publishing.has(driveId)) return;
  publishing.add(driveId);
  intake.publishAsConverted();
}
