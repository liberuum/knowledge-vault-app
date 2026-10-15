export const WINDOW_FROM_PAGES: number;
export const WINDOW_PAGES: number;
export interface OutlineEntry { title: string; page: number }
export interface Window { from: number; to: number; backMatter: boolean }
export function indexLikePage(text: string): boolean;
export function backMatterPages(input: { pages: number; outline?: readonly OutlineEntry[]; pageTexts?: readonly string[] }): Set<number>;
export function planWindows(input: { pages: number; outline?: readonly OutlineEntry[]; pageTexts?: readonly string[] }): Window[] | null;
