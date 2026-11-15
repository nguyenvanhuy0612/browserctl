// @ts-check
// One JSON line per tool call, with full parameters, for measuring how agents use the tools
// (specs/interface.md).
import fs from "node:fs";
import path from "node:path";

const ROTATE_BYTES = 20 * 1024 * 1024;

export class CallLog {
  #file;

  /** @param {{home: string}} options */
  constructor({ home }) {
    this.#file = path.join(home, "calls.jsonl");
  }

  /** @param {{who: {sessionId: string, client: string}, session: any, browser: string | null, name: string, params: unknown, response: any, ms: number}} entry */
  write({ who, session, browser, name, params, response, ms }) {
    const line = {
      at: new Date().toISOString(),
      session: who.sessionId,
      client: who.client,
      browser,
      tab: session?.current?.tabId ?? null,
      tool: name,
      params,
      lane: response.lane ?? null,
      ok: response.ok,
      code: response.ok ? null : response.error?.code,
      ms,
      bytes: JSON.stringify(response).length,
    };
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      try {
        if (fs.statSync(this.#file).size > ROTATE_BYTES) fs.renameSync(this.#file, `${this.#file}.1`);
      } catch {
        // no file yet
      }
      fs.appendFileSync(this.#file, JSON.stringify(line) + "\n");
    } catch {
      // logging must never break a call
    }
  }
}
