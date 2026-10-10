/**
 * What went wrong, in the person's words, and the way back: no raw error reaches the screen.
 *
 * `describeProblem` is for a screen that could not open: a card with what happened, what to do,
 * and the actions that fix it. `plainError` is for an inline line: a sentence the engine wrote
 * passes unchanged; a raw failure (a GraphQL dump, a bare network error, unreadable JSON)
 * becomes one sentence.
 */

export type ProblemAction = "retry" | "signin" | "resignin" | "back";
export type ProblemKind =
  | "credential-unconfirmed"
  | "signin-needed"
  | "signin-refused"
  | "no-access"
  | "not-found"
  | "unreachable"
  | "server-error"
  | "unreadable"
  | "unknown";

export type Problem = {
  kind: ProblemKind;
  title: string;
  body: string;
  /** What to do, in order. */
  steps: string[];
  /** The actions that fix it; the first is the main one. */
  actions: ProblemAction[];
  /** One short technical line for a bug report; never the raw dump. */
  details: string;
};

export type ProblemContext = {
  /** What could not open, in the person's words ("this vault", "Workflow Studio"); absent for an inline line. */
  what?: string;
  /** A remote vault's server (its host name); absent for the app's own engine. */
  host?: string;
  signedIn?: boolean;
  address?: string;
};

type Facts = { status?: number; server?: string; network: boolean; unreadable: boolean; text: string };

/** A fetch that never reached a server, as the webviews and Node word it (the whole message). */
const BARE_NETWORK =
  /^(typeerror:\s*)?(failed to fetch|load failed|networkerror when attempting to fetch resource|fetch failed|network request failed|the network connection was lost|could not connect\b.*|connection refused)\.?$/i;
const SYSTEM_NETWORK = /\b(econnrefused|econnreset|enotfound|etimedout|eai_again)\b/i;
const UNREADABLE = /(unexpected token|json\.parse|is not valid json|unexpected end of json|unexpected character)/i;
const GRAPHQL_DUMP = ': {"response":';

function textOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** A server's own short answer: `{"error": "…"}` or `{"message": "…"}`, or a short plain body. */
function serverText(body: unknown): string | undefined {
  if (typeof body !== "string" || !body.trim()) return undefined;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    const text = typeof parsed.error === "string" ? parsed.error : typeof parsed.message === "string" ? parsed.message : undefined;
    if (text) return text;
  } catch {
    // not JSON
  }
  const trimmed = body.trim();
  return trimmed.length <= 160 && !trimmed.startsWith("<") ? trimmed : undefined;
}

function factsOf(error: unknown): Facts {
  const text = textOf(error);
  const facts: Facts = { text, network: false, unreadable: false };
  type Response = { status?: unknown; body?: unknown; errors?: { message?: unknown }[] };
  const response = (error as { response?: Response } | null)?.response;
  const ownStatus = (error as { status?: unknown } | null)?.status;
  if (response && typeof response.status === "number") {
    // graphql-request's ClientError carries the response: its status, body and GraphQL errors.
    facts.status = response.status;
    const first = response.errors?.[0]?.message;
    facts.server = typeof first === "string" ? first : serverText(response.body);
  } else if (typeof ownStatus === "number") {
    // The engine's control API (ControlError): its message is already the engine's sentence.
    facts.status = ownStatus;
    facts.server = text;
  } else {
    // Only the message: "GraphQL Error (Code: 401): {"response":{…},"request":{…}}", or the
    // server's own GraphQL message in place of "GraphQL Error (Code: …)".
    const cut = text.indexOf(GRAPHQL_DUMP);
    if (cut >= 0) {
      const head = text.slice(0, cut);
      try {
        const dump = JSON.parse(text.slice(cut + 2)) as { response?: { status?: number; body?: string; errors?: { message?: string }[] } };
        facts.status = dump.response?.status;
        facts.server = dump.response?.errors?.[0]?.message ?? serverText(dump.response?.body);
      } catch {
        const status = /"status":(\d{3})/.exec(text)?.[1];
        if (status) facts.status = Number(status);
        const escaped = /\\"(?:error|message)\\":\\"([^\\"]{1,200})\\"/.exec(text)?.[1];
        if (escaped) facts.server = escaped;
      }
      if (facts.server === undefined && !/GraphQL Error \(Code: \d{3}\)/.test(head)) facts.server = head;
    }
    const code = /GraphQL Error \(Code: (\d{3})\)/.exec(text)?.[1];
    if (facts.status === undefined && code) facts.status = Number(code);
  }
  if (facts.status === undefined) {
    facts.network = BARE_NETWORK.test(text.trim()) || SYSTEM_NETWORK.test(text);
    facts.unreadable = !facts.network && (error instanceof SyntaxError || UNREADABLE.test(text));
  }
  return facts;
}

function kindOf(f: Facts, ctx: ProblemContext): ProblemKind {
  const server = f.server ?? "";
  if (f.network) return "unreachable";
  if (f.unreadable) return "unreadable";
  if (f.status === 401) {
    // The server verified the token, but Renown did not confirm the delegation behind it. Its lookup
    // reports any failure (Renown slow or down) the same way, so this is often transient.
    if (/credentials? no longer valid/i.test(server)) return "credential-unconfirmed";
    return ctx.signedIn ? "signin-refused" : "signin-needed";
  }
  if (f.status === 403 || /forbidden|insufficient permissions?|not authori[sz]ed|permission denied|access denied|you must be an admin/i.test(server)) return "no-access";
  if (f.status === 404 || /\bnot found\b|does not exist|no such (document|drive)/i.test(server)) return "not-found";
  if (f.status === 502 || f.status === 503 || f.status === 504) return "unreachable";
  if (f.status !== undefined && f.status >= 500) return "server-error";
  return "unknown";
}

function detailsOf(f: Facts): string {
  const first = (f.text.split(GRAPHQL_DUMP)[0] ?? "").split("\n")[0]?.trim() ?? "";
  const parts = [
    f.status !== undefined ? `HTTP ${f.status}` : f.network ? "Network error" : undefined,
    f.server ?? (f.status === undefined ? first : undefined),
  ].filter((p): p is string => Boolean(p));
  const line = parts.join(" · ") || first;
  return line.length > 240 ? `${line.slice(0, 239)}…` : line;
}

const short = (address: string) => (address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address);
const SIGN_IN_STEP = "Your browser opens; sign in there, and the app picks it up when you're done.";

export function describeProblem(error: unknown, ctx: ProblemContext = {}): Problem {
  const f = factsOf(error);
  const kind = kindOf(f, ctx);
  const details = detailsOf(f);
  const remote = ctx.host;
  const server = remote ?? "The vault engine";
  switch (kind) {
    case "credential-unconfirmed":
      return {
        kind,
        title: "Renown didn't confirm your sign-in",
        body: `${remote ?? "The server"} checks every request with Renown, the identity service you signed in with, and this time Renown didn't confirm it. Usually that's a brief hiccup.`,
        steps: ["Try again in a moment.", "If it keeps happening, sign in again: your sign-in may have been revoked on renown.id."],
        actions: ["retry", "resignin"],
        details,
      };
    case "signin-needed":
      return {
        kind,
        title: remote ? `${remote} asks you to sign in` : "Sign in to open this",
        body: "This vault is protected: it only opens for signed-in readers who have access.",
        steps: [`Sign in with Renown. ${SIGN_IN_STEP}`],
        actions: ["signin"],
        details,
      };
    case "signin-refused":
      return {
        kind,
        title: `${server} didn't accept your sign-in`,
        body: "Your sign-in may have expired, or been signed out on renown.id.",
        steps: [`Sign in again. ${SIGN_IN_STEP}`],
        actions: ["resignin", "retry"],
        details,
      };
    case "no-access":
      return {
        kind,
        title: "You don't have access to this vault",
        body: ctx.address
          ? `You're signed in as ${short(ctx.address)}, but the vault's administrator hasn't given that address access.`
          : "The vault's administrator hasn't given your address access.",
        steps: ["Ask the vault's administrator to give your address read access, in the vault's Access settings.", "Then try again."],
        actions: ["retry"],
        details,
      };
    case "not-found":
      return {
        kind,
        title: remote ? `This vault isn't on ${remote} any more` : "This isn't there any more",
        body: "It may have been deleted, or moved to another address.",
        steps: remote ? ["Go back to your vaults. Its ⋯ menu removes it from the list."] : ["Go back to your vaults."],
        actions: ["back"],
        details,
      };
    case "unreachable":
      return remote
        ? {
            kind,
            title: `Can't reach ${remote}`,
            body: "The app couldn't connect to this vault's server. Your connection may be down, or the server offline for a moment.",
            steps: ["Check your internet connection.", "Try again in a moment."],
            actions: ["retry"],
            details,
          }
        : {
            kind,
            title: "The vault engine isn't answering",
            body: "It may still be starting, or it stopped.",
            steps: ["Wait a few seconds, then try again.", "If it keeps failing, quit the app from the tray and open it again."],
            actions: ["retry"],
            details,
          };
    case "server-error":
      return {
        kind,
        title: `${server} ran into a problem`,
        body: "It answered with an error instead of the vault.",
        steps: ["Try again in a moment.", remote ? "If it keeps happening, tell the vault's administrator." : "If it keeps happening, quit the app from the tray and open it again."],
        actions: ["retry"],
        details,
      };
    case "unreadable":
      return {
        kind,
        title: "The app couldn't read the answer",
        body: `${server} sent an answer the app didn't understand.`,
        steps: ["Try again.", "If it keeps happening, quit the app from the tray and open it again."],
        actions: ["retry"],
        details,
      };
    default:
      return {
        kind: "unknown",
        title: ctx.what ? `Couldn't open ${ctx.what}` : "Something went wrong",
        body: "Something unexpected got in the way.",
        steps: ["Try again.", "If it keeps happening, copy the technical details below into a bug report."],
        actions: ["retry"],
        details,
      };
  }
}

/** One readable line: an engine sentence passes unchanged, a raw failure becomes a sentence. */
export function plainError(error: unknown, ctx: ProblemContext = {}): string {
  const text = textOf(error).trim();
  const raw =
    text.includes(GRAPHQL_DUMP) ||
    /GraphQL Error \(Code: \d{3}\)/.test(text) ||
    BARE_NETWORK.test(text) ||
    error instanceof SyntaxError ||
    UNREADABLE.test(text) ||
    /^[{[]/.test(text);
  if (!raw) return text.length > 400 ? `${text.slice(0, 400).replace(/\s+\S*$/, "")}…` : text;
  const p = describeProblem(error, ctx);
  const sentence = `${p.title}. ${p.steps[0] ?? p.body}`;
  // Keep a lead the app wrote in front of the raw part ("Could not save: …").
  const at = text.search(/GraphQL Error \(Code|failed to fetch|load failed|networkerror/i);
  const lead = at > 0 ? text.slice(0, at).trim() : "";
  return lead.endsWith(":") && lead.length < 80 && !lead.includes("{") ? `${lead} ${sentence}` : sentence;
}
