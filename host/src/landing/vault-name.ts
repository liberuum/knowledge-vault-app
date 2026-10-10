export type NameCheck = { ok: true; name: string } | { ok: false; reason: string };
/** Names to start from (Decision: a blank name is a small blank page); one click fills the field, which stays editable. */
export const NAME_IDEAS = ["Research", "Work", "Reading notes", "Learning"] as const;
export const MAX_VAULT_NAME = 80;

/** A vault name as a person typed it: whitespace tidied, never empty, never absurdly long. */
export function validateVaultName(raw: string): NameCheck {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) return { ok: false, reason: "Give the vault a name." };
  if (name.length > MAX_VAULT_NAME) return { ok: false, reason: `Keep the name under ${MAX_VAULT_NAME} characters.` };
  return { ok: true, name };
}
