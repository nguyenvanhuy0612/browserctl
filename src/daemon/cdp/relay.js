// @ts-check
// One CDP client's view of the browser: a browser-level endpoint for Playwright, made of the tabs
// this client claimed, over the shared chrome.debugger attachments (specs/relay.md).

// Commands whose effect lives in the debugger session and is lost on detach.
const JOURNALED =
  /^(?:\w+\.enable|Page\.(?:setLifecycleEventsEnabled|setInterceptFileChooserDialog|addScriptToEvaluateOnNewDocument|setBypassCSP)|Emulation\.set\w+|Network\.set\w+|Runtime\.addBinding|Target\.setAutoAttach|Fetch\.enable)$/;

/**
 * @typedef {{id: string, tabId: number, domains: Set<string>, parentSessionId?: string, frameTree?: Promise<unknown>}} ClientSession
 * @typedef {{tabId: number, openerId?: string, primary: ClientSession, sessions: Map<string, ClientSession>, children: Set<string>, journal: {method: string, params: any, clientIdentifier?: string, currentIdentifier?: string}[]}} Target
 */

// Domains whose events arrive without the client asking for them.
const UNSOLICITED = new Set(["Target", "Inspector"]);

// Commands after which Chrome reports what exists at once (contexts, the current lifecycle); the
// client takes those reports only once it has the frame tree (specs/relay.md).
const AFTER_FRAME_TREE = new Set(["Runtime.enable", "Page.setLifecycleEventsEnabled"]);

let relayCounter = 0;

export class CdpRelay {
  #attachments;
  /** @type {Map<number, Target>} */
  #targets = new Map();
  /** @type {Map<string, ClientSession>} */
  #sessions = new Map();
  /** @type {Map<string, Target>} */
  #childSessions = new Map();
  /** Domains this relay's client used on each child frame's session. @type {Map<string, Set<string>>} */
  #childDomains = new Map();
  #browserSessions = new Set();
  #autoAttach = false;
  #nextSession = 1;
  #prefix = `r${++relayCounter}`;
  #onCreateTarget;
  #onClaim;
  /** @type {(message: object) => void} */
  #sink = () => {};
  #disconnect = () => {};

  /** Tells an in-process client the connection is gone. */
  disconnect() {
    this.#disconnect();
  }

  /**
   * @param {import("./attachments.js").Attachments} attachments
   * @param {{onCreateTarget: (url: string) => Promise<number>, onClaim?: (tabId: number) => void}} options
   */
  constructor(attachments, { onCreateTarget, onClaim = () => {} }) {
    this.#attachments = attachments;
    this.#onCreateTarget = onCreateTarget;
    this.#onClaim = onClaim;
  }

  /** In-process transport for playwright-core's connectOverCDP. */
  transport() {
    const relay = this;
    /** @type {any} */
    const transport = {
      onmessage: undefined,
      onclose: undefined,
      /** @param {any} message */
      send(message) {
        relay.#onClient(message);
      },
      close() {},
    };
    this.#sink = (message) => transport.onmessage?.(message);
    this.#disconnect = () => transport.onclose?.("closed");
    return transport;
  }

  /** WebSocket transport, for a worker process's Playwright. @param {import("ws").WebSocket} ws */
  serve(ws) {
    this.#sink = (message) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };
    ws.on("message", (raw) => {
      try {
        this.#onClient(JSON.parse(raw.toString()));
      } catch {
        // malformed client message
      }
    });
    ws.on("close", () => this.close());
  }

  /** @param {object} message */
  #toClient(message) {
    this.#sink(message);
  }

  /**
   * Whether this relay's client uses a domain on the tab's session, or on a child frame's session.
   * @param {number} tabId @param {string} domain @param {string} [cdpSessionId]
   */
  uses(tabId, domain, cdpSessionId) {
    if (cdpSessionId) return Boolean(this.#childSessions.get(cdpSessionId)?.tabId === tabId && this.#childDomains.get(cdpSessionId)?.has(domain));
    const target = this.#targets.get(tabId);
    return Boolean(target && [...target.sessions.values()].some((s) => s.domains.has(domain)));
  }

  /** @param {number} tabId */
  claimed(tabId) {
    return this.#targets.has(tabId);
  }

  /**
   * Makes a tab one of this client's targets; with `openerTabId` it is that tab's popup.
   * @param {number} tabId @param {number} [openerTabId]
   */
  async claim(tabId, openerTabId) {
    if (this.#targets.has(tabId)) return;
    this.#attachments.addRelay(tabId, this);
    try {
      await this.#attachments.ensure(tabId);
    } catch (error) {
      this.#attachments.removeRelay(tabId, this);
      throw error;
    }
    const openerId = openerTabId === undefined ? undefined : this.#attachments.info(openerTabId)?.targetId;
    /** @type {Target} */
    const target = { tabId, openerId, primary: /** @type {any} */ (null), sessions: new Map(), children: new Set(), journal: [] };
    target.primary = this.#addSession(target);
    this.#targets.set(tabId, target);
    if (this.#autoAttach) this.#announce(target);
    this.#onClaim(tabId);
  }

  /** @param {number} tabId */
  release(tabId) {
    this.#attachments.removeRelay(tabId, this);
    this.targetGone(tabId);
  }

  close() {
    for (const tabId of [...this.#targets.keys()]) this.release(tabId);
  }

  // ---------- called by Attachments ----------

  /** After a re-attach: the client's contexts are gone, its session state is replayed. @param {number} tabId */
  async restore(tabId) {
    const target = this.#targets.get(tabId);
    if (!target) return;
    for (const session of target.sessions.values()) this.#toClient({ sessionId: session.id, method: "Runtime.executionContextsCleared", params: {} });
    for (const entry of target.journal) {
      // a replayed Runtime.enable marks the session, so a client that connects later gets the
      // contexts; this client receives them live (specs/relay.md)
      const replay = entry.method === "Runtime.enable" ? this.#attachments.enableRuntime(tabId, undefined, entry.params).then((r) => r.result) : this.#attachments.send(tabId, undefined, entry.method, entry.params);
      const result = await replay.catch(() => null);
      if (entry.clientIdentifier !== undefined && result) entry.currentIdentifier = result.identifier;
    }
  }

  /** @param {number} tabId */
  targetGone(tabId) {
    const target = this.#targets.get(tabId);
    if (!target) return;
    this.#targets.delete(tabId);
    for (const child of target.children) {
      this.#childSessions.delete(child);
      this.#childDomains.delete(child);
    }
    for (const session of [...target.sessions.values()].reverse()) {
      this.#sessions.delete(session.id);
      if (this.#autoAttach) {
        this.#toClient({ sessionId: session.parentSessionId, method: "Target.detachedFromTarget", params: { sessionId: session.id, targetId: this.#info(target).targetId } });
      }
    }
  }

  /** @param {number} tabId @param {string | undefined} sessionId @param {string} method @param {any} params */
  onEvent(tabId, sessionId, method, params) {
    const target = this.#targets.get(tabId);
    if (!target) return;
    if (!sessionId && method === "Target.attachedToTarget") {
      this.#childSessions.set(params.sessionId, target);
      target.children.add(params.sessionId);
    }
    if (!sessionId && method === "Target.detachedFromTarget") {
      this.#childSessions.delete(params.sessionId);
      this.#childDomains.delete(params.sessionId);
      target.children.delete(params.sessionId);
    }
    if (!this.#autoAttach) return;
    // A domain's events go to the sessions that used it; one that only another relay on the shared
    // attachment used is not this client's (specs/relay.md).
    const domain = method.slice(0, method.indexOf("."));
    if (sessionId) {
      if (this.#childSessions.has(sessionId) && (UNSOLICITED.has(domain) || this.#childDomains.get(sessionId)?.has(domain))) this.#toClient({ sessionId, method, params });
      return;
    }
    const recipients = UNSOLICITED.has(domain) ? [target.primary] : [...target.sessions.values()].filter((s) => s.domains.has(domain));
    for (const session of recipients) this.#toClient({ sessionId: session.id, method, params });
  }

  // ---------- client side ----------

  /** @param {Target} target */
  #info(target) {
    return { ...this.#attachments.info(target.tabId), attached: true, ...(target.openerId && { openerId: target.openerId }) };
  }

  /** @param {any} message */
  #onClient(message) {
    const { id, sessionId } = message;
    const isRoot = !sessionId || this.#browserSessions.has(sessionId);
    Promise.resolve()
      .then(() => (isRoot ? this.#rootCommand(message) : this.#sessionCommand(message)))
      .then(
        (result) => this.#toClient({ id, sessionId, result: result ?? {} }),
        (error) => this.#toClient({ id, sessionId, error: { code: -32000, message: String(error?.message ?? error) } }),
      );
  }

  /** @param {{method: string, params?: any, sessionId?: string}} message */
  async #rootCommand({ method, params = {}, sessionId }) {
    switch (method) {
      case "Browser.getVersion": {
        const hello = /** @type {any} */ (this.#attachments).browserHello?.() ?? {};
        const userAgent = hello.browser?.userAgent ?? "";
        return { protocolVersion: "1.3", product: `Chrome/${hello.browser?.version ?? "0"}`, revision: "", userAgent, jsVersion: "" };
      }
      case "Browser.setDownloadBehavior":
      case "Target.setDiscoverTargets":
      case "Browser.close": // the browser is the user's
        return {};
      case "Target.getBrowserContexts":
        return { browserContextIds: [] };
      case "Target.setAutoAttach":
        if (!this.#autoAttach) {
          this.#autoAttach = true;
          for (const target of this.#targets.values()) this.#announce(target);
        }
        return {};
      case "Target.getTargetInfo":
        if (!params.targetId) return { targetInfo: { targetId: "browser", type: "browser", title: "", url: "", attached: true, canAccessOpener: false } };
        return { targetInfo: this.#info(this.#byTargetId(params.targetId)) };
      case "Target.getTargets":
        return { targetInfos: [...this.#targets.values()].map((t) => this.#info(t)) };
      case "Target.attachToTarget":
        return { sessionId: this.#addSession(this.#byTargetId(params.targetId), sessionId).id };
      case "Target.attachToBrowserTarget": {
        const id = `${this.#prefix}-browser-${this.#nextSession++}`;
        this.#browserSessions.add(id);
        return { sessionId: id };
      }
      case "Target.detachFromTarget": {
        const session = this.#sessions.get(params.sessionId);
        if (session) {
          const target = /** @type {Target} */ (this.#targets.get(session.tabId));
          if (session !== target.primary) {
            target.sessions.delete(session.id);
            this.#sessions.delete(session.id);
          }
        }
        this.#browserSessions.delete(params.sessionId);
        return {};
      }
      case "Target.activateTarget":
        await this.#attachments.link.request("tabs.activate", { tabId: this.#byTargetId(params.targetId).tabId });
        return {};
      case "Target.closeTarget":
        await this.#attachments.link.request("tabs.close", { tabId: this.#byTargetId(params.targetId).tabId });
        return { success: true };
      case "Target.createTarget": {
        const tabId = await this.#onCreateTarget(params.url || "about:blank");
        await this.claim(tabId);
        return { targetId: this.#attachments.info(tabId).targetId };
      }
    }
    // chrome.debugger has no browser target: other browser-level commands go through a tab.
    const any = this.#targets.values().next().value;
    if (!any) throw new Error(`${method} needs a claimed tab`);
    return this.#attachments.send(any.tabId, undefined, method, params);
  }

  /** @param {{method: string, params?: any, sessionId: string}} message */
  async #sessionCommand({ method, params = {}, sessionId }) {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      const target = this.#childSessions.get(sessionId);
      if (!target) throw new Error(`Session with given id not found: ${sessionId}`);
      const [childDomain, childVerb] = method.split(".");
      let domains = this.#childDomains.get(sessionId);
      if (!domains) this.#childDomains.set(sessionId, (domains = new Set()));
      if (childVerb !== "disable") domains.add(childDomain);
      else {
        domains.delete(childDomain);
        if (this.#attachments.domainInUse(target.tabId, childDomain, sessionId)) return {};
      }
      if (method === "Runtime.enable") return this.#enableRuntime(target.tabId, sessionId, sessionId, params);
      return this.#attachments.send(target.tabId, sessionId, method, params);
    }
    const target = /** @type {Target} */ (this.#targets.get(session.tabId));
    const [domain, verb] = method.split(".");
    if (verb !== "disable") session.domains.add(domain);
    else {
      session.domains.delete(domain);
      if (this.uses(target.tabId, domain)) return {};
      target.journal = target.journal.filter((e) => e.method !== `${domain}.enable`);
      // the attachment is shared: another relay may still need the domain
      if (this.#attachments.domainInUse(target.tabId, domain)) return {};
    }
    if (method === "Target.getTargetInfo" && !params.targetId) return { targetInfo: this.#info(target) };
    if (method === "Page.removeScriptToEvaluateOnNewDocument") {
      const entry = target.journal.find((e) => e.clientIdentifier === params.identifier);
      if (entry) target.journal.splice(target.journal.indexOf(entry), 1);
      return this.#attachments.send(target.tabId, undefined, method, { identifier: entry?.currentIdentifier ?? params.identifier });
    }
    // Chrome reports existing contexts and the lifecycle at once; Playwright drops those of frames it
    // has not seen yet, so they wait for a Page.getFrameTree in flight on the same session.
    if (AFTER_FRAME_TREE.has(method) && session.frameTree) await session.frameTree.catch(() => {});
    const pending = method === "Runtime.enable" ? this.#enableRuntime(target.tabId, undefined, session.id, params) : this.#attachments.send(target.tabId, undefined, method, params);
    if (method === "Page.getFrameTree") session.frameTree = pending;
    const result = await pending;
    if (JOURNALED.test(method)) {
      const entry = { method, params, ...(method === "Page.addScriptToEvaluateOnNewDocument" && { clientIdentifier: result.identifier, currentIdentifier: result.identifier }) };
      target.journal.push(entry);
    }
    return result;
  }

  /**
   * Runtime.enable, then the contexts Chrome reported only to an earlier client (specs/relay.md).
   * @param {number} tabId @param {string | undefined} cdpSessionId @param {string} clientSessionId @param {object} params
   */
  async #enableRuntime(tabId, cdpSessionId, clientSessionId, params) {
    const { result, contexts } = await this.#attachments.enableRuntime(tabId, cdpSessionId, params);
    for (const context of contexts) this.#toClient({ sessionId: clientSessionId, method: "Runtime.executionContextCreated", params: { context } });
    return result;
  }

  /** @param {Target} target @param {string} [parentSessionId] */
  #addSession(target, parentSessionId) {
    /** @type {ClientSession} */
    const session = { id: `${this.#prefix}-tab-${target.tabId}-${this.#nextSession++}`, tabId: target.tabId, domains: new Set(), parentSessionId };
    target.sessions.set(session.id, session);
    this.#sessions.set(session.id, session);
    return session;
  }

  /** @param {Target} target */
  #announce(target) {
    this.#toClient({ method: "Target.attachedToTarget", params: { sessionId: target.primary.id, targetInfo: this.#info(target), waitingForDebugger: false } });
  }

  /** @param {string} targetId */
  #byTargetId(targetId) {
    for (const target of this.#targets.values()) if (this.#attachments.info(target.tabId)?.targetId === targetId) return target;
    throw new Error(`No target with given id found: ${targetId}`);
  }
}
