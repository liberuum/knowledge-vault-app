import type { NewSource } from "./vault-sources.js";

/**
 * The onboarding's sample: the app's own guide, so the first notes a new user reads explain the vault. Written to
 * the extraction rules of the powerhouse-knowledge plugin (skills/extract): each paragraph makes one falsifiable
 * claim that stands without the rest, conditions stay inside the claim, nothing is "the author says". Four themes of
 * three or more claims each, so placing them builds real maps of topics under the vault's top map.
 * Keep the statements true to the app: change this text when the behaviour it describes changes.
 */
export const SAMPLE_SOURCE: NewSource = {
  title: "How Knowledge Vault works",
  sourceType: "DOCUMENTATION",
  content: `# How Knowledge Vault works

Knowledge Vault turns the documents you collect into a network of short notes. Each note holds one idea and is linked to the notes it supports, extends or contradicts. This guide is a source like any other: the notes written from it explain how the vault works, so reading them is a tour of how it thinks.

## Notes that hold one idea

A note that holds one idea can be linked precisely; a note that holds several can only be linked vaguely. A link to a note that mixes three ideas says that something in it is relevant, and whoever follows it has to work out which part. One idea per note is what lets each link carry a meaning.

A note's title states its idea as a claim, such as "One idea per note makes links precise", not a topic such as "Note-taking". A claim can be used in an argument and someone can disagree with it; a topic label can only be filed under something.

Restating an idea in new words, rather than copying the passage, is what tests whether it was understood. The source stays in the vault as the record, so a note that only repeats a passage adds nothing that searching the source would not find.

Two sources that make the same point are worth more as one note than as two: kept apart, the duplicates split the links between them, so neither shows how much support the idea really has.

## Links and maps of your topics

A link between two notes is useful only when it says why they connect. "This note builds on that one because it extends the claim from teams to individuals" can be checked by a reader; a bare line between two notes cannot. Each link the vault draws between two notes carries its reason.

A link also has a kind: one note can build on another, contradict it, replace it, or relate to it. The kind tells you how to read a pair of notes before you open either of them.

Contradictions are kept rather than settled by deleting one side. When two notes contradict each other, the vault opens a tension that names both, so the disagreement stays visible until new evidence decides it, or shows that each claim holds under different conditions.

Maps of your topics keep a growing vault navigable. Each map gathers the notes on one theme and points to the maps next to it, and one map at the top, named after the vault, leads to all the others. A map is only made once a theme has three or more notes, so a small vault is not cluttered with near-empty maps.

## How a source becomes notes

A source is processed in four steps: extract its ideas as notes, connect them to the notes already in the vault, place them in the maps of your topics, and verify the result. Because each step stands on its own, a step that fails can be run again without redoing the steps before it.

Adding a source should take seconds even though reading it takes minutes: a vault fills only while collecting stays effortless, so processing runs in the background, one source after another, while you keep working.

The AI model you choose decides how fast processing is and where your text goes. A model on this computer keeps everything on the machine and costs nothing to run, but it is slower. A hosted model is faster, and the text being processed is sent to that provider. Switching models changes how new sources are processed; notes already written stay as they are.

A new note is a draft until it has been checked. The verify step reports which drafts are ready to approve and which need a closer look, and approving a note makes it the vault's settled view.

Knowledge is better retired than deleted. When a newer note replaces an older one, linking it as the replacement and archiving the older note keeps the history: the archived note leaves search, but you can still see what was believed before and why it changed.

## Asking your vault

An answer that cites the notes it used can be checked by opening them; an answer from a model's general knowledge cannot be. That is why the vault's chat answers from your notes and names them. A chat that only reads the vault can be trusted with it: it can get an answer wrong, but it cannot damage a note.

Search finds notes by meaning, not only by matching words. A question phrased differently from the note, such as "why do my links feel vague" for the note about one idea per note, still finds it, because the vault compares meanings that are computed on this computer.

A vault stays on this computer unless you connect it to something else: a hosted AI model, a converter on another machine, or a vault shared on a server. Your sources, notes and links are stored locally, and nothing you add is sent anywhere by default.
`,
};
