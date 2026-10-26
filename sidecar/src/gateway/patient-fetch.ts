import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

/**
 * The gateway's request to a model server on this computer or the local network, without Node fetch's
 * five-minute limits.
 *
 * Node's fetch (undici) gives up on an answer whose headers take more than 300 s (`headersTimeout`) or whose body
 * pauses for 300 s (`bodyTimeout`), whatever the request's signal allows. A local model answers a pipeline's JSON
 * call in one piece once it has written all of it, which can take longer: the call failed with "fetch failed" and
 * the pipeline's step with it. Node's http client sets no such limit; the request's signal (the client hanging up)
 * is the only one. The answer streams through as it arrives, so the chat's streamed replies are unchanged.
 */
export function patientFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  return new Promise<Response>((resolve, reject) => {
    const req = send(url, { method: init.method ?? "GET", headers, ...(init.signal ? { signal: init.signal } : {}) }, (res: IncomingMessage) => {
      const out = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) for (const v of value) out.append(name, v);
        else if (value !== undefined) out.set(name, value);
      }
      const status = res.statusCode ?? 502;
      const empty = status === 204 || status === 205 || status === 304;
      if (empty) res.resume();
      resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, statusText: res.statusMessage ?? "", headers: out }));
    });
    req.on("error", reject);
    if (typeof init.body === "string") req.write(init.body);
    else if (init.body != null) return reject(new TypeError("patientFetch sends a string body only"));
    req.end();
  });
}
