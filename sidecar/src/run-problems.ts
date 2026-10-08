/**
 * What a failed pipeline run's error means for the person, so the app can say it plainly and
 * point at the fix. The piece reports the provider's refusal as
 * `… The model provider refused to ask <model> (<status>): <message> …`.
 */
export type RunProblem = {
  kind: "no-funds" | "bad-key" | "rate-limited" | "slow-model" | "model-missing" | "model-refused" | "interrupted";
  /** One sentence for the chip and the Models page. */
  message: string;
  model?: string;
};

const MODEL = /refused to ask ([^\s()]+) \((\d{3})\)/;

export function classifyRunError(error: string | null | undefined): RunProblem | null {
  if (!error) return null;
  // Cut off when the app (and its engine) stopped: the watchdog queues the source again at the next start.
  if (/reactor stopped before the run finished/i.test(error)) return { kind: "interrupted", message: "The app was closed while this source was being processed; it is processed again on its own." };
  const m = MODEL.exec(error);
  const model = m?.[1];
  const status = m?.[2];
  const text = error.toLowerCase();
  if (status === "402" || /insufficient credits|can only afford|not enough credit|out of credit|payment required|add credits/.test(text))
    return { kind: "no-funds", message: "Your model provider refused the request: the account is out of credit.", model };
  if (status === "401" || status === "403" || /invalid api key|incorrect api key|unauthorized|forbidden/.test(text))
    return { kind: "bad-key", message: "Your model provider refused the API key.", model };
  if (status === "429" || /rate limit/.test(text)) return { kind: "rate-limited", message: "Your model provider is rate-limiting requests; runs will keep failing until it lets up.", model };
  if (/did not answer within|timed out|timeout/.test(text)) return { kind: "slow-model", message: `${model ?? "The model"} did not answer in time; free models are often too slow for a whole source.`, model };
  if (status === "404" || /no endpoints found|model not found|not a valid model|does not exist/.test(text))
    return { kind: "model-missing", message: `${model ?? "The model"} is not available at your provider.`, model };
  if (status) return { kind: "model-refused", message: `${model ?? "The model"} refused the request (HTTP ${status}); it may not suit processing.`, model };
  return null;
}
