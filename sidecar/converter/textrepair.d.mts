export function wordsOf(text: string): string[];
export function spellLigatures(text: string): string;
export function pageRepairs(pageText: string): Map<string, string>;
export function repairText(text: string, repairs: Map<string, string>, options?: { inPlace?: boolean }): string;
export function repairDocument(json: string, pageTexts: readonly string[]): { json: string; fixes: number };
