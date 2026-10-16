import type { AddedStarter, StarterId } from "./api.js";

/**
 * The side trip's templates in the person's words (spec 2026-10-15, Language): what each brings in, what it needs,
 * and the one field it asks for. The engine (sidecar/src/starters.ts) knows how each is made.
 */
export type StarterCard = {
  id: StarterId;
  title: string;
  line: string;
  /** What it needs from the person, shown as a tag before the card is opened. */
  needs: string;
  /** Where it comes from: a connector's logo, or the paper mark. */
  logo: { src: string; alt: string } | "paper";
  /** Its one field. */
  field: { name: "feedUrl" | "topic" | "apiKey"; label: string; placeholder: string; hint: string; secret?: true; inputMode?: "url" };
  /** What a key means for the person, under the field. */
  assurance: string;
  backfillLabel: string;
  /** Studio's own words for the chain, for those who will open it. */
  chain: string;
};

export const STARTERS: readonly StarterCard[] = [
  {
    id: "feed",
    title: "Follow a blog or newsletter",
    line: "Each new post becomes a source, read like any you add yourself.",
    needs: "No account needed",
    logo: { src: "/connectors/rss.png", alt: "RSS" },
    field: {
      name: "feedUrl",
      label: "The feed's address",
      placeholder: "https://example.com/feed",
      hint: "Most blogs, Substack newsletters (name.substack.com/feed), podcasts and YouTube channels have one. A site's home page alone will not do.",
      inputMode: "url",
    },
    assurance: "The app reads the feed from this computer. Nothing about you or your vault is sent.",
    backfillLabel: "Add the 3 latest posts now",
    chain: "RSS · New item → Text Helper · HTML to Markdown → Knowledge Vault · Ingest source",
  },
  {
    id: "papers",
    title: "Follow research on a topic",
    line: "New papers on arXiv that match your topic arrive with their abstracts.",
    needs: "No account needed",
    logo: "paper",
    field: { name: "topic", label: "Topic", placeholder: "knowledge graphs", hint: "A few words, as you would search for them. A busy topic can bring several papers a day." },
    assurance: "Only the topic is sent, to arXiv's public search.",
    backfillLabel: "Add the 3 newest papers now",
    chain: "RSS · New item (arXiv search) → Knowledge Vault · Ingest source",
  },
  {
    id: "granola",
    title: "Bring in your meeting notes",
    line: "Each new meeting note from Granola becomes a source.",
    needs: "Needs a Granola API key",
    logo: { src: "/connectors/granola.png", alt: "Granola" },
    field: {
      name: "apiKey",
      label: "Granola API key",
      placeholder: "Paste your key",
      hint: "In the Granola app: Settings › API › Create API key. Keys come with Granola's Business and Enterprise plans.",
      secret: true,
    },
    assurance: "Checked with Granola before anything is made, then kept encrypted on this computer.",
    backfillLabel: "Add your 3 latest meetings now",
    chain: "Granola · New note → Knowledge Vault · Ingest source",
  },
];

/** The "Works with" strip, as on the website: connectors people know, then the rest of the catalogue. */
export const WORKS_WITH: ReadonlyArray<{ name: string; src: string }> = [
  { name: "Gmail", src: "/connectors/gmail.png" },
  { name: "Slack", src: "/connectors/slack.png" },
  { name: "Google Drive", src: "/connectors/google-drive.png" },
  { name: "Notion", src: "/connectors/notion.png" },
  { name: "Teams", src: "/connectors/microsoft-teams.png" },
  { name: "GitHub", src: "/connectors/github.png" },
  { name: "Claude", src: "/connectors/claude.png" },
];
export const CATALOGUE_URL = "https://www.activepieces.com/pieces";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What happened, and what happens next, after a template was added (Emotion: the sub-goal is celebrated in words). */
export function addedLine(card: StarterCard, added: AddedStarter, backfill: boolean): string {
  const where = { feed: "Sources › Feeds", papers: "Sources › Papers", granola: "Sources › Meetings" }[card.id];
  const next = { feed: "New posts arrive within 15 minutes of being published.", papers: "New papers are looked for every hour.", granola: "New meetings are looked for every 10 minutes." }[card.id];
  const noun = { feed: ["recent post", "recent posts"], papers: ["new paper", "new papers"], granola: ["recent meeting", "recent meetings"] }[card.id] as [string, string];
  if (!backfill) return `It is on. ${next}`;
  if (added.added === 0) return `It is on, and found nothing to add yet. ${next}`;
  return `${plural(added.added, noun[0], noun[1])} added to ${where}. ${next}`;
}
