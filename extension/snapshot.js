// CDP DOM/AX fusion, layer occlusion, and VOM v1 tree serializer for tab snapshots.

import { swallow, noteSwallowed } from "./util.js";
import { ensureAttached, isAttached } from "./cdp.js";

function getGlobalCrypto() {
  return typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
}

function makeUuid() {
  const c = getGlobalCrypto();
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function nowMs() {
  const perf = typeof globalThis !== "undefined" ? globalThis.performance : undefined;
  return perf && typeof perf.now === "function" ? perf.now() : Date.now();
}

function On(err) {
  if (err instanceof Error) return err;
  if (typeof err === "string") return new Error(err);
  if (err && typeof err === "object" && "message" in err) return new Error(String(err.message));
  return new Error("unknown chrome.debugger error");
}

var Ot = new Set([
    `DOMSnapshot.enable`,
    `DOMSnapshot.captureSnapshot`,
    `Accessibility.enable`,
    `Accessibility.disable`,
    `Accessibility.getFullAXTree`,
    `Page.getLayoutMetrics`,
    `Page.getFrameTree`,
    `DOM.getFrameOwner`,
  ]),
  kt = new Set([...Ot, `Target.setAutoAttach`]),
  At = 1e4,
  jt = 2e4,
  Mt = 1e3,
  Nt = 2e3,
  _Pt = `renderer_read_timeout`,
  Ft = `Do not retry reads on this tab while the earlier command is pending. Navigation alone does not clear the read gate; it reopens when the command settles or its debugger session detaches. Use another tab or report the unavailable read.`;
function It(e) {
  return Ot.has(e);
}
var Lt = new Set([
    ...kt,
    `Page.getFrameTree`,
    `Page.createIsolatedWorld`,
    `DOM.getDocument`,
    `DOM.querySelector`,
    `DOM.describeNode`,
    `DOM.resolveNode`,
    `DOM.getBoxModel`,
    `DOM.getContentQuads`,
    `Runtime.enable`,
    `Log.enable`,
    `Runtime.evaluate`,
    `Runtime.callFunctionOn`,
  ]),
  Rt = class e extends Error {
    method;
    tabId;
    sessionId;
    phase;
    constructor(e, t, n, r, i = `deadline`) {
      (super(
        `Browser read ${e} timed out after ${n}ms (tab ${t}); the ${It(e) || e.startsWith(`Runtime.`) || e === `Log.enable` ? `renderer` : `browser`} is not answering. ${Ft}`
      ),
        (this.method = e),
        (this.tabId = t),
        (this.sessionId = r),
        (this.phase = i),
        (this.name = `CdpReadTimeoutError`));
    }
    static stillPending(t, n, r) {
      let i = new e(t, n, 0, r, `blocked`);
      return (
        (i.message = `Browser read ${t} refused: an earlier read on tab ${n} is still pending in Chrome. ${Ft}`),
        i
      );
    }
  };
var Bt = class {
  tabs = new Map();
  run(e, t, n, r, i) {
    i?.throwIfAborted();
    let a = this.tabs.get(e.tabId);
    a || this.tabs.set(e.tabId, (a = new Map()));
    let o = e.sessionId ?? `root`,
      s = a.get(o);
    s || a.set(o, (s = new Set()));
    let c = a.get(`root`)?.values().next().value ?? s.values().next().value;
    if (c && Lt.has(t)) return Promise.reject(Rt.stillPending(t, e.tabId, c.sessionId));
    let l = !0,
      u,
      d = (e) => {
        !l || u || ((u = e), s.add(e));
      },
      f = Ht(e, t, n, r, {
        timedOut: d,
        settled: () => {
          ((l = !1), u && s.delete(u));
        },
      });
    return i ? Vt(f, i, () => d(Rt.stillPending(t, e.tabId, e.sessionId))) : f;
  }
  reset(e, t) {
    t ? this.tabs.get(e)?.delete(t) : this.tabs.delete(e);
  }
  clear() {
    this.tabs.clear();
  }
};
async function Vt(e, t, n) {
  let r;
  try {
    return await Promise.race([
      e,
      new Promise((e, i) => {
        ((r = () => {
          (n?.(),
            i(
              t.reason ??
                (typeof DOMException !== "undefined" ? new DOMException() : Error)(
                  `Operation aborted`,
                  `AbortError`
                )
            ));
        }),
          t.addEventListener(`abort`, r, { once: !0 }),
          t.aborted && r());
      }),
    ]);
  } finally {
    r && t.removeEventListener(`abort`, r);
  }
}
async function Ht(
  e,
  t,
  n,
  r = t === `Accessibility.disable`
    ? Mt
    : t === `DOMSnapshot.captureSnapshot` || t === `Accessibility.getFullAXTree`
      ? jt
      : t !== `Page.getFrameTree` && kt.has(t)
        ? At
        : void 0,
  i
) {
  let a = Date.now(),
    o = !1,
    s = () => ({
      tabId: e.tabId,
      frameSessionId: e.sessionId,
      method: t,
      elapsedMs: Date.now() - a,
    }),
    c = (e) => {
      (i?.settled(),
        !(Date.now() - a < Nt) &&
          (o ? console.warn : console.debug)(`[vom cdp] slow command settled`, {
            ...s(),
            outcome: e,
            late: o,
          }));
    },
    l;
  try {
    l = n().then(
      (e) => (c(`returned`), e),
      (e) => {
        throw (c(`failed`), e);
      }
    );
  } catch (e) {
    throw (c(`failed`), e);
  }
  if (r === void 0) return l;
  let u;
  try {
    return await Promise.race([
      l,
      new Promise((n, a) => {
        u = setTimeout(() => {
          ((o = !0), console.warn(`[vom cdp] read timed out`, s()));
          let n = new Rt(t, e.tabId, r, e.sessionId);
          (i?.timedOut(n), a(n));
        }, r);
      }),
    ]);
  } finally {
    clearTimeout(u);
  }
}
function Ut(e, t) {
  if (!t.size) return e;
  let n = new Set(t.keys()),
    r = new Map();
  for (let t of e.frames) {
    if (!t.parentFrameId) continue;
    let e = r.get(t.parentFrameId) ?? [];
    (e.push(t.frameId), r.set(t.parentFrameId, e));
  }
  let i = [...n];
  for (let e = 0; e < i.length; e++)
    for (let t of r.get(i[e]) ?? []) n.has(t) || (n.add(t), i.push(t));
  let a = new Map(e.frames.filter((e) => n.has(e.frameId)).map((e) => [e.frameId, e]));
  for (let [e, n] of t) a.set(e, { ...a.get(e), frameId: e, target: n });
  return {
    ...e,
    frames: e.frames.filter((e) => !n.has(e.frameId)),
    unavailableFrames: [...a.values()],
  };
}
function N(e) {
  return `${e.tabId}:${e.sessionId ?? `root`}`;
}
function Wt(e, t, n, r) {
  let i = e.get(n.frame.id);
  i || t.push(n.frame.id);
  let a = n.frame.parentId || i?.parentFrameId,
    o = n.frame.url || i?.url;
  e.set(n.frame.id, {
    frameId: n.frame.id,
    ...(a ? { parentFrameId: a } : {}),
    ...(o ? { url: o } : {}),
    target: r,
  });
}
function Gt(e, t, n, r) {
  let i = [{ node: e.tree, inheritedTarget: e.target }],
    a = new WeakSet();
  for (; i.length > 0;) {
    let e = i.pop();
    if (!e || a.has(e.node)) continue;
    a.add(e.node);
    let o = t.get(e.node.frame.id) ?? e.inheritedTarget;
    Wt(n, r, e.node, o);
    let s = e.node.childFrames ?? [];
    for (let e = s.length - 1; e >= 0; --e) i.push({ node: s[e], inheritedTarget: o });
  }
}
function Kt(e) {
  let t = e.find((e) => e.target.sessionId === void 0) ?? e[0];
  if (!t) return null;
  let n = new Map(),
    r = [],
    i = new Map(e.map((e) => [e.tree.frame.id, e.target]));
  (i.set(t.tree.frame.id, t.target), Gt(t, i, n, r));
  for (let a of e) a !== t && Gt(a, i, n, r);
  return {
    rootFrameId: t.tree.frame.id,
    frames: r.flatMap((e) => {
      let t = n.get(e);
      return t ? [t] : [];
    }),
  };
}
var nn = 1000,
  rn = 20;
async function an(e, t) {
  if (e.length === 0) return !0;
  let n = t - Date.now();
  if (n <= 0) return !1;
  let r,
    i = await Promise.race([
      Promise.allSettled(e).then(() => !1),
      new Promise((e) => {
        r = setTimeout(() => e(!0), n);
      }),
    ]);
  return (r && clearTimeout(r), !i);
}
function fi() {
  let e = Error(`observation aborted`);
  return ((e.name = `AbortError`), e);
}
function pi(e) {
  return typeof e == `object` && e ? (e.name ?? ``) : ``;
}
function hi(e) {
  return [`AbortError`, `CdpReadTimeoutError`, `CdpAttachmentChangedError`].includes(pi(e));
}
function B(e) {
  if (e?.aborted) throw fi();
}
function gi(e) {
  B(e);
  let t = nowMs() + 8;
  return () => {
    if ((B(e), !(nowMs() < t)))
      return new Promise((e) => {
        let t = new MessageChannel();
        ((t.port1.onmessage = () => {
          (t.port1.close(), t.port2.close(), e());
        }),
          t.port2.postMessage(null));
      }).then(() => {
        (B(e), (t = nowMs() + 8));
      });
  };
}
function L(e, t, n, r) {
  return t.sessionId && e.sendToTarget ? e.sendToTarget(t, n, r) : e.send(t.tabId, n, r);
}
function $r(e, t) {
  return { send: (n, r, i) => L(e, t, r, i) };
}
function Ni(e) {
  return !e || e.length !== 8 || !e.every(Number.isFinite)
    ? null
    : [
        { x: e[0], y: e[1] },
        { x: e[2], y: e[3] },
        { x: e[4], y: e[5] },
        { x: e[6], y: e[7] },
      ];
}
function Pi(e) {
  return [
    { x: e.x, y: e.y },
    { x: e.x + e.w, y: e.y },
    { x: e.x + e.w, y: e.y + e.h },
    { x: e.x, y: e.y + e.h },
  ];
}
function Fi(e) {
  return Pi({ x: 0, y: 0, w: e.width, h: e.height });
}
function Ii(e) {
  let [t, n, r, i] = e,
    a = n.x - r.x,
    o = i.x - r.x,
    s = t.x - n.x + r.x - i.x,
    c = n.y - r.y,
    l = i.y - r.y,
    u = t.y - n.y + r.y - i.y,
    d,
    f,
    p,
    m,
    h,
    g,
    _ = 0,
    v = 0;
  if (Math.abs(s) < 1e-9 && Math.abs(u) < 1e-9)
    ((d = n.x - t.x), (f = i.x - t.x), (p = t.x), (m = n.y - t.y), (h = i.y - t.y), (g = t.y));
  else {
    let e = a * l - o * c;
    if (Math.abs(e) < 1e-9) return [n.x - t.x, i.x - t.x, t.x, n.y - t.y, i.y - t.y, t.y, 0, 0];
    ((_ = (s * l - o * u) / e),
      (v = (a * u - s * c) / e),
      (d = n.x - t.x + _ * n.x),
      (f = i.x - t.x + v * i.x),
      (p = t.x),
      (m = n.y - t.y + _ * n.y),
      (h = i.y - t.y + v * i.y),
      (g = t.y));
  }
  return [d, f, p, m, h, g, _, v];
}
function Li(e, t) {
  let [n, r, i, a, o, s, c, l] = Ii(t),
    u = c * e.x + l * e.y + 1;
  return { x: (n * e.x + r * e.y + i) / u, y: (a * e.x + o * e.y + s) / u };
}
function zi(e, t) {
  let { width: n, height: r } = t.sourceViewport;
  return n <= 0 || r <= 0 ? [] : e.map((e) => Li({ x: e.x / n, y: e.y / r }, t.destinationQuad));
}
function Bi(e) {
  let t = 0;
  for (let n = 0; n < e.length; n += 1) {
    let r = e[n],
      i = e[(n + 1) % e.length];
    t += r.x * i.y - i.x * r.y;
  }
  return t / 2;
}
function Vi(e, t, n, r) {
  let i = t.x - e.x,
    a = t.y - e.y,
    o = r.x - n.x,
    s = r.y - n.y,
    c = i * s - a * o;
  if (Math.abs(c) < 1e-9) return t;
  let l = n.x - e.x,
    u = n.y - e.y,
    d = (l * s - u * o) / c;
  return { x: e.x + d * i, y: e.y + d * a };
}
function Hi(e, t) {
  if (e.length < 3 || t.length < 3) return [];
  let n = Bi(t) >= 0 ? 1 : -1,
    r = [...e];
  for (let e = 0; e < t.length && r.length > 0; e += 1) {
    let i = t[e],
      a = t[(e + 1) % t.length],
      o = r;
    r = [];
    let s = (e) => n * ((a.x - i.x) * (e.y - i.y) - (a.y - i.y) * (e.x - i.x)) >= -1e-9,
      c = o[o.length - 1];
    for (let e of o) {
      let t = s(c);
      (s(e) ? (t || r.push(Vi(c, e, i, a)), r.push(e)) : t && r.push(Vi(c, e, i, a)), (c = e));
    }
  }
  return r;
}
function Ui(e) {
  if (e.length < 3) return null;
  let t = e.map((e) => e.x),
    n = e.map((e) => e.y),
    r = Math.min(...t),
    i = Math.min(...n),
    a = Math.max(...t),
    o = Math.max(...n);
  return a <= r || o <= i ? null : { x: r, y: i, width: a - r, height: o - i };
}
function Wi(e) {
  return Ui(e.flat());
}
function qi(e, t, n) {
  let r = e;
  for (let e of t) {
    let t = Fi(e.sourceViewport);
    r = r
      .map((e) => Hi(e, t))
      .filter((e) => e.length >= 3)
      .map((t) =>
        [e.destinationQuad, ...(e.destinationClips ?? [])].reduce((e, t) => Hi(e, t), zi(t, e))
      )
      .filter((e) => e.length >= 3);
  }
  let i = Fi(n);
  return r.map((e) => Hi(e, i)).filter((e) => e.length >= 3);
}
function Ji(e, t) {
  return qi(
    e.map((e) => t.sourceClips.reduce((e, t) => Hi(e, t), e)).filter((e) => e.length >= 3),
    t.edges,
    t.topViewport
  );
}
function Yi(e, t) {
  return e ? Wi(Ji([Pi(e)], t)) : null;
}
async function Xi(e, t) {
  let n = new Map(),
    r = `bctl-frame-sizes-${makeUuid()}`;
  try {
    let i = (
      await e(`Runtime.evaluate`, {
        expression: `(() => {
          const result = [];
          const documents = [document];
          for (let i = 0; i < documents.length && result.length < ${t.size}; i++) {
            for (const owner of documents[i].querySelectorAll('iframe,frame')) {
              if (result.length >= ${t.size}) break;
              if (!owner.isConnected) continue;
              const style = getComputedStyle(owner);
              result.push([owner, JSON.stringify({
                width: owner.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
                height: owner.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
              })]);
              try { if (owner.contentDocument) documents.push(owner.contentDocument); } catch {}
            }
          }
          return result;
        })()`,
        objectGroup: r,
        serializationOptions: {
          serialization: `deep`,
          maxDepth: 3,
          additionalParameters: { maxNodeDepth: 0, includeShadowTree: `none` },
        },
      })
    ).result?.deepSerializedValue;
    if (i?.type !== `array` || !Array.isArray(i.value)) return n;
    for (let e of i.value) {
      if (e.type !== `array` || !Array.isArray(e.value)) continue;
      let [r, i] = e.value;
      if (r?.type !== `node` || i?.type !== `string` || typeof i.value != `string`) continue;
      let a = r.value?.backendNodeId;
      if (!(a === void 0 || !t.has(a)))
        try {
          let e = JSON.parse(i.value);
          e &&
            Number.isFinite(e.width) &&
            Number.isFinite(e.height) &&
            e.width > 0 &&
            e.height > 0 &&
            n.set(a, e);
        } catch (err) {
          noteSwallowed("snapshot.caught", err);
        }
    }
  } finally {
    await e(`Runtime.releaseObjectGroup`, { objectGroup: r }, !0).catch(
      swallow("snapshot.ignore")
    );
  }
  return n;
}
function Zi(e) {
  for (let t of [`clientWidth`, `clientHeight`]) {
    let n = e.visualViewport?.[t],
      r = e.cssVisualViewport?.[t];
    if (
      n !== void 0 &&
      r !== void 0 &&
      Number.isFinite(n) &&
      Number.isFinite(r) &&
      n > 0 &&
      r > 0
    ) {
      let e = n / r;
      if (Number.isFinite(e) && e > 0) return e;
    }
  }
  return null;
}
function Qi(e) {
  let t = e.cssLayoutViewport ?? e.layoutViewport;
  return {
    width: t?.clientWidth ?? 0,
    height: t?.clientHeight ?? 0,
    scrollX: t?.pageX ?? 0,
    scrollY: t?.pageY ?? 0,
    cssToDip: e.cssVisualViewport?.zoom ?? e.visualViewport?.zoom ?? 1,
  };
}
var $i = class {
  cdp;
  tabId;
  signal;
  metrics = new Map();
  frameViewports = new Map();
  owners = new Map();
  projections = new Map();
  snapshotOwners = new Map();
  sizeBatches = new Map();
  active = 0;
  waiting = [];
  graphPromise;
  framesPromise;
  constructor(e, t, n, r) {
    ((this.cdp = e),
      (this.tabId = t),
      (this.signal = r),
      n && (this.graphPromise = Promise.resolve(n)));
  }
  async request(e, t, n, r = !1) {
    if (!r && this.signal?.aborted)
      throw (typeof DOMException !== "undefined" ? new DOMException() : Error)(
        `geometry aborted`,
        `AbortError`
      );
    this.active >= 4 ? await new Promise((e) => this.waiting.push(e)) : this.active++;
    try {
      if (!r && this.signal?.aborted)
        throw (typeof DOMException !== "undefined" ? new DOMException() : Error)(
          `geometry aborted`,
          `AbortError`
        );
      return await L(this.cdp, e, t, n);
    } finally {
      let e = this.waiting.shift();
      e ? e() : this.active--;
    }
  }
  graph() {
    return (
      (this.graphPromise ??=
        this.cdp.getFrameGraph?.(this.tabId).catch(swallow("snapshot.ignoreNull")) ??
        Promise.resolve(null)),
      this.graphPromise
    );
  }
  frames() {
    return (
      (this.framesPromise ??= this.graph().then(
        (e) => new Map(e?.frames.map((e) => [e.frameId, e]) ?? [])
      )),
      this.framesPromise
    );
  }
  async frame(e) {
    return (await this.frames()).get(e);
  }
  async ancestry(e) {
    let t = await this.frames(),
      n = [],
      r = new Set(),
      i = t.get(e);
    if (!i) return null;
    for (; i.parentFrameId;) {
      if (r.has(i.frameId)) return null;
      (r.add(i.frameId), n.push(i));
      let e = t.get(i.parentFrameId);
      if (!e) return null;
      i = e;
    }
    return n;
  }
  layoutMetrics(e) {
    let t = N(e),
      n = this.metrics.get(t);
    return (n || ((n = this.request(e, `Page.getLayoutMetrics`, {})), this.metrics.set(t, n)), n);
  }
  async viewport(e) {
    let { width: t, height: n } = Qi(await this.layoutMetrics(e));
    return Number.isFinite(t) && Number.isFinite(n) && t > 0 && n > 0
      ? { width: t, height: n }
      : null;
  }
  frameViewport(e) {
    let t = N(e),
      n = this.frameViewports.get(t);
    return (
      n ||
        ((n = this.request(e, `Runtime.evaluate`, {
          expression: `({ width: window.innerWidth, height: window.innerHeight })`,
          returnByValue: !0,
        }).then(({ result: e, exceptionDetails: t }) => {
          let n = e?.value;
          return !t &&
            n &&
            Number.isFinite(n.width) &&
            Number.isFinite(n.height) &&
            n.width > 0 &&
            n.height > 0
            ? n
            : null;
        })),
        this.frameViewports.set(t, n)),
      n
    );
  }
  ownerContent(e, t) {
    let n = `${N(e)}:${t}`,
      r = this.owners.get(n);
    return (
      r ||
        ((r = this.request(e, `DOM.getBoxModel`, { backendNodeId: t }).then((e) =>
          Ni(e.model?.content)
        )),
        this.owners.set(n, r)),
      r
    );
  }
  async snapshotProjection(e, t, n, r, i) {
    let a = `${N(e.target)}:${t}`,
      o = this.snapshotOwners.get(a);
    o ||
      ((o = i
        ? this.ownerContent(e.target, t).then((e) => (e ? { quad: e, size: i } : null))
        : this.snapshotOwner(e.target, t)),
      this.snapshotOwners.set(a, o));
    let s;
    try {
      s = await o;
    } catch (e) {
      if (e && typeof e == `object` && `name` in e && e.name === `AbortError`) throw e;
      (console.debug(`[vom geometry] frame owner unavailable`, e), (s = null));
    }
    return s
      ? {
          status: `available`,
          projection: {
            source: e,
            geometry: {
              sourceClips: [],
              edges: [{ sourceViewport: s.size, destinationQuad: s.quad, destinationClips: n }],
              topViewport: r,
            },
          },
        }
      : { status: `unavailable`, source: e, ownerBackendNodeId: t };
  }
  registerSnapshotOwners(e, t) {
    let n = N(e);
    if (t.size < 2 || this.sizeBatches.has(n)) return;
    let r;
    this.sizeBatches.set(
      n,
      () => (
        (r ??= Xi((t, n, r) => this.request(e, t, n, r), t).catch((e) => {
          if (e && typeof e == `object` && `name` in e && e.name === `AbortError`) throw e;
          return new Map();
        })),
        r
      )
    );
  }
  async snapshotOwner(e, t) {
    let n = await this.ownerContent(e, t);
    if (!n) return null;
    let r = (await this.sizeBatches.get(N(e))?.())?.get(t);
    if (this.signal?.aborted)
      throw (typeof DOMException !== "undefined" ? new DOMException() : Error)(
        `geometry aborted`,
        `AbortError`
      );
    if (r) return { quad: n, size: r };
    let i = (await this.request(e, `DOM.resolveNode`, { backendNodeId: t })).object?.objectId;
    if (!i) return null;
    try {
      let t = await this.request(e, `Runtime.callFunctionOn`, {
          objectId: i,
          functionDeclaration: `function() {
          if (!this.isConnected) return null;
          const style = getComputedStyle(this);
          return {
            width: this.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
            height: this.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
          };
        }`,
          returnByValue: !0,
        }),
        r = t.result?.value;
      return !t.exceptionDetails &&
        r &&
        Number.isFinite(r.width) &&
        Number.isFinite(r.height) &&
        r.width > 0 &&
        r.height > 0
        ? { quad: n, size: r }
        : null;
    } finally {
      await this.request(e, `Runtime.releaseObject`, { objectId: i }, !0).catch(
        swallow("snapshot.ignore")
      );
    }
  }
  targetRoot(e, t) {
    let n = new Set(),
      r = t;
    for (; r.parentFrameId;) {
      if (n.has(r.frameId)) return null;
      n.add(r.frameId);
      let t = e.get(r.parentFrameId);
      if (!t) return null;
      if (N(t.target) !== N(r.target)) break;
      r = t;
    }
    return r;
  }
  async clips(e, t, n) {
    let r = [],
      i = t,
      a = new Set();
    for (; i.frameId !== n.frameId;) {
      if (a.has(i.frameId) || !i.parentFrameId) return null;
      a.add(i.frameId);
      let t = e.get(i.parentFrameId);
      if (!t || i.ownerBackendNodeId === void 0) return null;
      let n = await this.ownerContent(t.target, i.ownerBackendNodeId);
      if (!n) return null;
      (r.push(n), (i = t));
    }
    return r;
  }
  targetProjection(e) {
    let t = this.projections.get(e);
    return (t || ((t = this.buildTargetProjection(e)), this.projections.set(e, t)), t);
  }
  async buildTargetProjection(e) {
    let t = await this.frames(),
      n = t.get(e);
    if (!n) return null;
    let r = this.targetRoot(t, n);
    if (!r || !(await this.viewport(r.target))) return null;
    let i = await this.clips(t, n, r);
    if (!i) return null;
    let a = [],
      o = new Set();
    for (; r.parentFrameId;) {
      if (o.has(r.frameId)) return null;
      o.add(r.frameId);
      let e = t.get(r.parentFrameId);
      if (!e || r.ownerBackendNodeId === void 0) return null;
      let n = await this.ownerContent(e.target, r.ownerBackendNodeId);
      if (!n) return null;
      let i = await this.frameViewport(r.target),
        s = await this.viewport(r.target),
        c = this.targetRoot(t, e);
      if (!i || !s || !c) return null;
      let l = await this.clips(t, e, c);
      if (!l) return null;
      let u = { sourceViewport: i, destinationQuad: n, destinationClips: l };
      ((i.width !== s.width || i.height !== s.height) && l.push(zi(Fi(s), u)), a.push(u), (r = c));
    }
    let s = await this.viewport(r.target);
    return s ? { sourceClips: i, edges: a, topViewport: s } : null;
  }
};
async function ea(e, t, n) {
  return (await na(e, t, n)).status;
}
async function na(e, t, n, r, i = !1) {
  let a = () => e.getAttachmentId?.(t.target.tabId) === t.attachmentId;
  if ((B(n), !a())) return { status: `changed` };
  let o = `bctl-document-identity-${makeUuid()}`,
    s = (r, i) => (B(n), L(e, t.target, r, i)),
    c,
    l = !1;
  try {
    let e = await s(`Page.createIsolatedWorld`, {
        frameId: t.frameId,
        worldName: `bctl-document-identity`,
      }),
      u = {
        serialization: `deep`,
        additionalParameters: { maxNodeDepth: 0, includeShadowTree: `none` },
      },
      d;
    if (r === void 0)
      d = await s(`Runtime.evaluate`, {
        expression: `document.documentElement`,
        contextId: e.executionContextId,
        objectGroup: o,
        serializationOptions: u,
      });
    else {
      let t = await s(`DOM.resolveNode`, {
        backendNodeId: r,
        executionContextId: e.executionContextId,
        objectGroup: o,
      });
      if (!t.object?.objectId) return { status: `unavailable` };
      ((c = t.object.objectId),
        (d = await s(`Runtime.callFunctionOn`, {
          objectId: t.object.objectId,
          functionDeclaration: `function() { return this.isConnected && this.ownerDocument === document ? document.documentElement : null; }`,
          objectGroup: o,
          serializationOptions: u,
        })));
    }
    if (!a()) return { status: `changed` };
    let f = d.result?.deepSerializedValue;
    if (f?.type === `null`) return { status: `changed` };
    let p = f?.type === `node` ? f.value?.backendNodeId : void 0;
    return p === void 0
      ? { status: `unavailable` }
      : p === t.documentElementBackendNodeId
        ? (B(n),
          (l = i && !!c && e.executionContextId !== void 0),
          {
            status: `current`,
            ...(l ? { objectId: c, objectGroup: o, executionContextId: e.executionContextId } : {}),
          })
        : { status: `changed` };
  } catch (e) {
    if ((B(n), hi(e))) throw e;
    return { status: a() ? `unavailable` : `changed` };
  } finally {
    (l ||
      (await L(e, t.target, `Runtime.releaseObjectGroup`, { objectGroup: o }).catch(
        swallow("snapshot.ignore")
      )),
      B(n));
  }
}
var ra = new Set([`current-password`, `new-password`, `one-time-code`]),
  ia = `data-bctl-record-password`;
function aa(e) {
  return (e ?? ``)
    .toLowerCase()
    .split(/[\t\n\f\r ]+/)
    .some((e) => e.startsWith(`cc-`) || ra.has(e));
}
var oa = [
    ...[...ra].map((e) => `[autocomplete~="${e}" i]`),
    `[autocomplete^="cc-" i]`,
    `[autocomplete*=" cc-" i]`,
  ].join(`,`),
  sa = [`position`, `pointer-events`, `cursor`, `visibility`, `opacity`],
  ca = [
    ...sa,
    `display`,
    `overflow-x`,
    `overflow-y`,
    `transform`,
    `zoom`,
    `clip-path`,
    `mask-image`,
    `rotate`,
    `scale`,
    `perspective`,
    `clip`,
    `contain`,
    `content-visibility`,
    `container-type`,
    `overflow-clip-margin`,
  ],
  la = { includeVisualFacts: !1, computedStyles: sa },
  ua = { includeVisualFacts: !0, computedStyles: ca };
function da(e, t) {
  if (typeof e.frameId == `string`) return e.frameId || void 0;
  if (typeof e.frameId == `number`) return ma(t, e.frameId) || void 0;
}
function fa(e) {
  return (
    (e.tag === `input` &&
      ((e.attrs.type ?? ``).toLowerCase() === `password` ||
        Object.prototype.hasOwnProperty.call(e.attrs, `data-bctl-record-password`))) ||
    aa(e.attrs.autocomplete)
  );
}
function pa(e, t, n, r) {
  if (r) return e === void 0 && !n ? void 0 : (e ?? t) === `` ? `empty` : `filled`;
  if (e !== void 0) return e === `` ? `empty` : e === t ? `default` : `filled`;
}
function ma(e, t) {
  return t === void 0 || t < 0 ? `` : (e[t] ?? ``);
}
function ha(e) {
  let t = new Map();
  if (!e?.index || !e.value) return t;
  for (let n = 0; n < e.index.length; n++) {
    let r = e.index[n],
      i = e.value[n];
    r !== void 0 && i !== void 0 && t.set(r, i);
  }
  return t;
}
async function ga(e, t, n, r = la) {
  let i = gi(n),
    a = e.nodes,
    o = e.layout;
  if (!a?.backendNodeId) return { nodes: [] };
  let s = a.backendNodeId.length,
    c = new Map();
  for (let e = 0; e < (o?.nodeIndex?.length ?? 0); e++) {
    if (e % 256 == 0) {
      let e = i();
      e && (await e);
    }
    c.set(o.nodeIndex[e], e);
  }
  let l = ha(a.inputValue),
    u = ha(a.textValue),
    d = new Set(a.inputChecked?.index ?? []),
    f = new Set(a.optionSelected?.index ?? []),
    p = new Set(a.isClickable?.index ?? []),
    m = new Map();
  if (a.nodeValue)
    for (let e = 0; e < s; e++) {
      if (e % 256 == 0) {
        let e = i();
        e && (await e);
      }
      let n = a.nodeValue[e] ?? -1;
      if (n < 0) continue;
      let r = ma(t, n).trim();
      if (!r) continue;
      let o = a.parentIndex?.[e] ?? -1;
      if (o >= 0) {
        let e = m.get(o);
        e ? e.push(r) : m.set(o, [r]);
      }
    }
  let h = [];
  for (let e = 0; e < s; e++) {
    if (e % 256 == 0) {
      let e = i();
      e && (await e);
    }
    let n = a.backendNodeId[e],
      s = a.parentIndex?.[e] ?? -1,
      g = s >= 0 ? (a.backendNodeId[s] ?? null) : null,
      _ = ma(t, a.nodeName?.[e]).toLowerCase(),
      v = {},
      y = a.attributes?.[e] ?? [];
    for (let e = 0; e + 1 < y.length; e += 2) v[ma(t, y[e]).toLowerCase()] = ma(t, y[e + 1]);
    let b = c.get(e),
      x = b === void 0 ? [] : (o?.styles?.[b] ?? []),
      S = {};
    for (let e = 0; e < r.computedStyles.length; e++) S[r.computedStyles[e]] = ma(t, x[e]);
    let C =
        b === void 0
          ? void 0
          : {
              boundsSpace: `snapshot-document-layout`,
              bounds: o?.bounds?.[b],
              ...(r.includeVisualFacts && o?.clientRects?.[b]
                ? { clientRect: o.clientRects[b] }
                : {}),
              styles: S,
            },
      w = m.get(e)?.join(` `),
      T = _ === `textarea` ? u.get(e) : l.get(e),
      E = T === void 0 ? void 0 : ma(t, T),
      D = fa({ tag: _, attrs: v }),
      O = v.value ?? ``,
      k = D ? void 0 : E,
      A = pa(E, O, Object.prototype.hasOwnProperty.call(v, `value`), D);
    (D && delete v.value,
      h.push({
        backendNodeId: n,
        nodeType: a.nodeType?.[e],
        parentBackendNodeId: g,
        ...(a.parentIndex?.[e] === void 0 || (s >= 0 && g === null) ? { parentMissing: !0 } : {}),
        tag: _,
        attrs: v,
        layout: C,
        paintOrder: b === void 0 ? 0 : (o?.paintOrders?.[b] ?? 0),
        position: S.position || `static`,
        pointerEvents: S[`pointer-events`] || `auto`,
        cursor: S.cursor || `auto`,
        ...(p.has(e) ? { clickable: !0 } : {}),
        textContent: w,
        ...(k === void 0 ? {} : { formValue: k }),
        ...(_ === `input` || _ === `textarea`
          ? {
              formPlaceholder: v.placeholder ?? ``,
              ...(D ? {} : { formDefaultValue: O }),
              ...(A ? { formState: A } : {}),
            }
          : {}),
        ...(_ === `input` && [`checkbox`, `radio`].includes((v.type ?? ``).toLowerCase())
          ? { checked: d.has(e) }
          : {}),
        ...(f.has(e) ? { formValue: v.value ?? w ?? `` } : {}),
      }));
  }
  return { nodes: h };
}
function _a(e, t, n, r) {
  let i = e.documents ?? [],
    a = e.strings ?? [],
    o = new Set(),
    s = new Set(),
    c = i.map((e) => {
      let r = da(e, a);
      if (!r) return;
      (o.has(r) && s.add(r), o.add(r));
      let i = n.get(r),
        c = i && N(i.target) === N(t) ? i : void 0,
        l = (e.documentURL === void 0 ? void 0 : a[e.documentURL]) || c?.url;
      return { frameId: r, target: t, ...(l ? { url: l } : {}) };
    }),
    l = c[0];
  if (l) {
    let e = n.get(l.frameId),
      i = e?.parentFrameId ? n.get(e.parentFrameId) : void 0;
    (t.sessionId &&
      e &&
      N(e.target) === N(t) &&
      i &&
      N(i.target) !== N(t) &&
      ((l.parentFrameId = i.frameId), (l.ownerBackendNodeId = e.ownerBackendNodeId)),
      !t.sessionId && !l.url && r && (l.url = r));
  }
  let u = new Set();
  for (let e = 0; e < i.length; e++) {
    let t = i[e].nodes?.contentDocumentIndex,
      n = c[e];
    if (!(!n || !t))
      for (let r = 0; r < t.index.length; r++) {
        let a = c[t.value[r]],
          o = i[e].nodes?.backendNodeId?.[t.index[r]];
        if (!(!a || o === void 0)) {
          if (a === l || a === n || u.has(a.frameId)) {
            s.add(a.frameId);
            continue;
          }
          (u.add(a.frameId), (a.parentFrameId = n.frameId), (a.ownerBackendNodeId = o));
        }
      }
  }
  return { frames: c.filter((e) => !!e && !s.has(e.frameId)), ids: o, rootFrameId: l?.frameId };
}
var od = [`data-testid`, `data-test-id`, `id`],
  sd = new Set([`btn`, `button`, `control`, `icon`, `item`, `test`, `tool`]),
  cd = new Set([`ember`, `headlessui`, `mui`, `radix`, `react`, `rc`]);
function ld(e) {
  return e
    .replace(/([a-z0-9])([A-Z])/g, `$1 $2`)
    .split(/[^a-zA-Z0-9]+/)
    .map((e) => e.toLowerCase())
    .filter(Boolean);
}
function ud(e) {
  let t = e?.trim();
  if (!t || t.length < 3 || t.length > 80 || /^[a-f0-9]{8,}$/i.test(t)) return;
  let n = ld(t);
  if (!cd.has(n[0])) {
    for (; n.length > 1 && sd.has(n[0]);) n.shift();
    for (; n.length > 1 && sd.has(n[n.length - 1]);) n.pop();
    if (!(n.length === 0 || !n.some((e) => /[a-z]{3,}/.test(e))))
      return n.map((e, t) => (t === 0 ? `${e[0].toUpperCase()}${e.slice(1)}` : e)).join(` `);
  }
}
function dd(e) {
  for (let t of od) {
    let n = ud(e[t]);
    if (n) return n;
  }
}
function os(e, t, n) {
  if (t === null || !Number.isFinite(t) || t <= 0) return null;
  let r = e.scrollOffsetX === void 0 ? n?.x : e.scrollOffsetX / t,
    i = e.scrollOffsetY === void 0 ? n?.y : e.scrollOffsetY / t;
  return r === void 0 || i === void 0 || !Number.isFinite(r) || !Number.isFinite(i)
    ? null
    : { layoutUnitsPerCssPixel: t, scrollCss: { x: r, y: i } };
}
function ss(e, t, n) {
  if (!n || e.length < 4 || !e.slice(0, 4).every(Number.isFinite)) return null;
  let { layoutUnitsPerCssPixel: r, scrollCss: i } = n,
    [a, o, s, c] = e;
  return !Number.isFinite(r) ||
    r <= 0 ||
    s <= 0 ||
    c <= 0 ||
    !Number.isFinite(i.x) ||
    !Number.isFinite(i.y)
    ? null
    : {
        space: `frame-viewport-css`,
        owner: t,
        rect: { x: a / r - i.x, y: o / r - i.y, width: s / r, height: c / r },
      };
}
function cs(e, t) {
  if (e.owner.frameId !== t.source.frameId || N(e.owner.target) !== N(t.source.target)) return null;
  let { x: n, y: r, width: i, height: a } = e.rect;
  return Yi({ x: n, y: r, w: i, h: a }, t.geometry);
}
var _s = 1,
  vs = new Set([`fixed`, `absolute`, `sticky`]),
  ys = new Set([`input`, `textarea`, `select`]);
function bs(e) {
  return e.role?.toLowerCase() ?? ``;
}
function xs(e) {
  return e.tag.toLowerCase();
}
function Ss(e, t) {
  if (!e || t.width <= 0 || t.height <= 0) return 0;
  let n =
    Math.max(0, Math.min(e.x + e.w, t.width) - Math.max(e.x, 0)) *
    Math.max(0, Math.min(e.y + e.h, t.height) - Math.max(e.y, 0));
  return n <= 0 ? 0 : Math.min(1, n / (t.width * t.height));
}
function Cs(e, t) {
  if (!e || t.width <= 0 || t.height <= 0) return !1;
  let n = _s;
  return e.x <= n && e.y <= n && e.x + e.w >= t.width - n && e.y + e.h >= t.height - n;
}
function ws(e) {
  return e.pointerEvents === `none` ? !1 : vs.has(e.position);
}
function Ts(e) {
  let t = bs(e),
    n = xs(e);
  return e.modal === !0 || n === `dialog` || t === `dialog` || t === `alertdialog`;
}
function Es(e, t) {
  for (let n of e) {
    if (!t.has(n.id)) continue;
    if (Ts(n)) return `modal`;
    let e = xs(n);
    if (ys.has(e) || e === `iframe`) return `modal`;
  }
  return `mask`;
}
function Ds(e, t, n) {
  let r = null;
  for (let i of e) {
    if ((n !== void 0 && i.frameId !== n) || !ws(i)) continue;
    let e = Ss(i.rect, t);
    (Cs(i.rect, t) || (i.modal === !0 && e > 0)) &&
      (r === null || e > r.coverage || (e === r.coverage && i.paintOrder > r.node.paintOrder)) &&
      (r = { node: i, coverage: e });
  }
  if (!r) return null;
  let i = r.node.paintOrder,
    a = new Set();
  for (let t of e) t.frameId === r.node.frameId && t.paintOrder >= i && a.add(t.id);
  return { rootId: r.node.id, kind: Es(e, a), coverage: r.coverage, members: a };
}
var Os = 1.05,
  ks =
    /[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]*[\p{Ll}\p{Lm}\p{Lo}\p{M}]+(?:'[sStTmMdD]|'[rR][eE]|'[vV][eE]|'[lL][lL])?|[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]+[\p{Ll}\p{Lm}\p{Lo}\p{M}]*(?:'[sStTmMdD]|'[rR][eE]|'[vV][eE]|'[lL][lL])?|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n/]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu,
  As = /\p{L}/u,
  js = /\p{M}/u,
  Ms = new Set(
    `a about after all also an and are as at be been before but by can do does for from had has have if in into is it its more no not of on or than that the their these they this those to was we were what when which will with you your`.split(
      ` `
    )
  ),
  Ns = 0.1,
  Ps = new Set(
    `這個們為會說時開關選擇設資訊頁點錄載動號碼應該與對見後從際實現發經過還進給覺長間問題無來東車書電話網線讀寫請認識處檔畫視窗區單擊顯啟儲體驗證權據傳輸複製連結帳戶務歷種類標籤屬隱藏圖裝備註冊維護輕鬆試產專業學習師議並節員總統勢況環遠運氣燈萬億態濟術輯稱擁樣變價買賣廣層頭慣歡邊`
  ),
  Fs = new Map();
for (let e of `alert article banner button canvas cell checkbox checked complementary ctx definition dialog directory disabled document empty feed figure filled first focus form generic grid group heading hover iframe img layers link list main menu mixed more navigation nodes none option page paragraph placeholder presentation radio region row scrollbar search section separator slider status switch tab table term textarea textbox toolbar tooltip tree unchecked view vom`.split(
  ` `
))
  Fs.set(e, 1);
for (let e of `alertdialog columnheader combobox contentinfo gridcell listbox listitem menubar menuitem occluded progressbar rowgroup rowheader searchbox spinbutton tablist tabpanel treeitem`.split(
  ` `
))
  Fs.set(e, 2);
for (let e of [`menuitemcheckbox`, `menuitemradio`, `radiogroup`]) Fs.set(e, 3);
var Is = new Set(
    `ab ac ad ag ai al am an ap ar as at au av be bl bo br bs bu ca ce ch ci ck cl co cr ct da de di do ea ec ed ee ei el em en ep er es et ex fi fo ge gi ha he hi ho ia ic id ie ig il im in io ir is it ke la ld le li ll lo lu ma me mi mo mp na nc nd ne ng ni nn no ns nt nu oc ol om on op or os ot ou ov ow ox pa pe pl po pr pt qu ra rd re ri ro rs rt ru sa sc se sh si sk so ss st su ta te th ti to tr ts tt tu ue ui ul un up ur us ut va ve vi wi ws xt`.split(
      ` `
    )
  ),
  Ls = 8,
  Rs = 0.45,
  zs = {
    punctExtra: 0.2,
    astralSymbol: 1.8,
    bmpSymbol: 1.3,
    punctuationSymbol: 1,
    modifier: 0.5,
    gluedPrefix: 0.35,
    englishLower: [7, 0.06],
    englishCapital: [10, 0.05],
    otherLower: [5.5, 0.23],
    otherCapital: [7, 0.42],
    longWordCharsPerToken: 4.5,
    allCapsPerChar: 0.28,
    nonAsciiLetter: 0.09,
    identifierLength: 30,
    identifierCharsPerToken: 1.9,
    han: 0.76,
    hanTraditional: 0.93,
    hanBase: 0.22,
    kana: 0.66,
    kanaBase: 0.21,
    hangul: 0.465,
    hangulBase: 0.64,
  };
function Bs(e) {
  return (
    (e >= 13312 && e <= 19903) ||
    (e >= 19968 && e <= 40959) ||
    (e >= 63744 && e <= 64255) ||
    (e >= 131072 && e <= 262143)
  );
}
function Vs(e) {
  return (e >= 12352 && e <= 12543) || (e >= 12784 && e <= 12799) || (e >= 65382 && e <= 65439);
}
function Hs(e) {
  return (e >= 4352 && e <= 4607) || (e >= 12592 && e <= 12687) || (e >= 44032 && e <= 55215);
}
function Us(e) {
  let t = 0,
    n = 0,
    r = !1;
  for (let i of e) {
    let e = +(i.charCodeAt(0) === 32),
      a = i.charCodeAt(e) | 32;
    if (a >= 97 && a <= 122) (t++, i.length - e <= 6 && Ms.has(i.slice(e).toLowerCase()) && n++);
    else if (!r && i.charCodeAt(e) >= 13312) {
      for (let e of i)
        if (Ps.has(e)) {
          r = !0;
          break;
        }
    }
  }
  return { english: t > 0 && n / t >= Ns, traditional: r };
}
function Ws(e) {
  return (e >= 65024 && e <= 65039) || (e >= 917760 && e <= 917999)
    ? zs.modifier
    : (e >= 8192 && e <= 8303) || (e >= 12288 && e <= 12351) || (e >= 65280 && e <= 65519)
      ? zs.punctuationSymbol
      : e > 65535
        ? zs.astralSymbol
        : zs.bmpSymbol;
}
function Gs(e) {
  let t = 0,
    n = 0,
    r = -1;
  for (let i = 0; i < e.length; i++) {
    let a = e.charCodeAt(i) | 32;
    if (a < 97 || a > 122) {
      r = -1;
      continue;
    }
    (r >= 0 && (t++, Is.has(String.fromCharCode(r, a)) && n++), (r = a));
  }
  return t > 0 && n / t < Rs;
}
function Ks(e, t, n, r, i) {
  if (e >= zs.identifierLength || i) return e / zs.identifierCharsPerToken;
  let a;
  if (t > 1 && t === e) a = 1 + (e - 2) * zs.allCapsPerChar;
  else {
    let i = t > 0,
      [o, s] =
        r && n === 0
          ? i
            ? zs.englishCapital
            : zs.englishLower
          : i
            ? zs.otherCapital
            : zs.otherLower;
    a = Math.min(1 + Math.max(0, e - o) * s, Math.max(1, e / zs.longWordCharsPerToken));
  }
  return a + n * zs.nonAsciiLetter;
}
function qs(e, t, n) {
  let r = e.charCodeAt(0);
  if ((r >= 48 && r <= 57) || e.trim() === ``) return 1;
  let i = 0,
    a = 0,
    o = 0,
    s = 0,
    c = 0,
    l = 0,
    u = 0,
    d = 0,
    f = 0,
    p = !1;
  for (let t = 0; t < e.length; t++) {
    let n = e.charCodeAt(t);
    if (n < 128) {
      n >= 97 && n <= 122
        ? s++
        : n >= 65 && n <= 90
          ? (s++, c++)
          : n !== 32 && (u++, t === 0 && (p = !0));
      continue;
    }
    let r = t;
    if (
      (n >= 55296 &&
        n <= 56319 &&
        t + 1 < e.length &&
        (n = ((n - 55296) << 10) + (e.charCodeAt(++t) - 56320) + 65536),
      Bs(n))
    )
      i++;
    else if (Vs(n)) a++;
    else if (Hs(n)) o++;
    else {
      let e = String.fromCodePoint(n);
      if (As.test(e) || (s > 0 && js.test(e) && Ws(n) !== zs.modifier)) (s++, l++);
      else {
        let t = js.test(e) && Ws(n) !== zs.modifier ? zs.modifier : Ws(n);
        ((d += t), r === 0 && ((p = !0), (f = t)));
      }
    }
  }
  let m = d - f;
  if (i + a + o > 0) {
    let e = (p ? zs.gluedPrefix : 0) + m;
    return (
      a > 0
        ? (e += zs.kanaBase + (a + i) * zs.kana)
        : i > 0 && (e += zs.hanBase + i * (n ? zs.hanTraditional : zs.han)),
      o > 0 && (e += zs.hangulBase + o * zs.hangul),
      e + s / 4
    );
  }
  if (s === 0) {
    let e = u > 0 ? 1 + Math.max(0, u - 2) * zs.punctExtra : 0;
    return Math.max(1, e + d);
  }
  if (e === `@e`) return 2;
  let h = s >= Ls && l === 0 && Gs(e),
    g = Ks(s, c, l, t, h);
  if (p || d > 0) return zs.gluedPrefix + m + g;
  if (c === 0 && l === 0) {
    let t = Fs.get(e.charCodeAt(0) === 32 ? e.slice(1) : e);
    if (t !== void 0) return t;
  }
  return g;
}
function Js(e) {
  let t = e.match(ks);
  if (!t) return 0;
  let { english: n, traditional: r } = Us(t),
    i = 0;
  for (let e of t) i += qs(e, n, r);
  return i * Os;
}
function Ys(e) {
  return Math.ceil(Js(e));
}
function Xs(e) {
  return Js(e) + 1;
}
var Zs = new Set([`generic`, `none`, `presentation`, `inlinetextbox`]),
  Qs = new Set([
    `button`,
    `checkbox`,
    `combobox`,
    `listbox`,
    `link`,
    `menuitem`,
    `menuitemcheckbox`,
    `menuitemradio`,
    `option`,
    `radio`,
    `scrollbar`,
    `searchbox`,
    `slider`,
    `spinbutton`,
    `switch`,
    `tab`,
    `textbox`,
    `treeitem`,
  ]),
  $s = new Set(
    `alert.alertdialog.article.banner.cell.columnheader.complementary.contentinfo.definition.dialog.directory.document.feed.figure.form.grid.gridcell.group.heading.iframe.img.list.listitem.main.navigation.paragraph.region.rootwebarea.row.rowgroup.rowheader.search.section.status.table.term.toolbar.tree.webarea`.split(
      `.`
    )
  );
function ec(e) {
  return $s.has(e?.toLowerCase() ?? ``);
}
var tc = `•••`,
  nc = 1 / 0,
  rc = 1 / 0,
  ic = 200,
  ac = 18e4,
  oc = 36e4,
  sc = 3,
  cc = 12,
  lc = 40,
  uc = [`onclick`, `onmousedown`, `onkeydown`, `onkeyup`, `onkeypress`],
  dc = new Set([`button`, `input`, `select`, `textarea`]),
  fc = new Set([`date`, `time`, `datetime-local`, `month`, `week`]),
  pc = new Set([`svg`, `use`, `path`, `g`, `symbol`]),
  mc = new Set([`button`, `menuitem`, `switch`, `tab`, `checkbox`, `radio`]),
  hc = new Set([
    `add`,
    `apply`,
    `cancel`,
    `delete`,
    `edit`,
    `go`,
    `more`,
    `open`,
    `remove`,
    `reset`,
    `save`,
    `select`,
    `submit`,
    `suspend`,
    `view`,
    `close`,
    `confirm`,
    `continue`,
  ]),
  gc = new Set([`fixed`, `absolute`, `sticky`]);
function H(e) {
  return e?.replace(/\s+/g, ` `).trim() || void 0;
}
function _c(e) {
  let t = e.trim(),
    n = t.toLowerCase();
  return !!(
    !t ||
    t.includes(`<![endif]`) ||
    t.includes(`<!--`) ||
    t.includes(`-->`) ||
    /<\/?[a-z][^>]*>/i.test(t) ||
    /\$\(function|document\.|window\.|\.onclick\s*=|function\s*\(|var\s+\w+\s*=/.test(t) ||
    /(https?:\/\/|encodeURIComponent|site_code|target="_blank")/.test(t) ||
    /^\[?if\s+[^\]]+\]?>?$/i.test(t) ||
    /^<!\[endif\]?>$/i.test(t) ||
    /^(top|header|footer|nav|bigpic|login|登录|开始|结束)[、,\s]*(开始|结束)?$/i.test(t) ||
    /(^|[、,\s])(top|bigpic|登录)\s*(开始|结束)($|[、,\s])/.test(n)
  );
}
function vc(e) {
  let t = H(e);
  if (!(!t || _c(t))) return t;
}
function yc(e) {
  let t = e.trim(),
    n = t.toLowerCase();
  return !!(
    t === `欢迎` ||
    n.includes(`icp`) ||
    n.includes(`备案`) ||
    t.includes(`联系方式`) ||
    t.includes(`政府网站标识`) ||
    /^\d{5,}$/.test(t) ||
    /北京市小客车指标调控管理信息系统|beijing municipal commission/i.test(t)
  );
}
function bc(e) {
  return e.role?.toLowerCase() ?? ``;
}
function xc(e) {
  return e.tag.toLowerCase();
}
function Sc(e) {
  let t = bc(e);
  return xc(e) === `input` && t !== `` && !Zs.has(t) && fc.has(e.attrs?.type?.toLowerCase() ?? ``);
}
function Cc(e) {
  return e.split(/\s+/).join(` `).toLowerCase();
}
function wc(e) {
  let t = e.trim();
  return t.startsWith(`http://`) || t.startsWith(`https://`);
}
function Tc(e) {
  let t = bc(e);
  if (![`row`, `cell`, `gridcell`, `listitem`, `rowheader`].includes(t)) return !1;
  let n = H(e.name);
  return n !== void 0 && wc(n);
}
function Ec(e) {
  if (!(
    e.disabled ||
    e.inert ||
    e.pointerEvents === `none` ||
    [`statictext`, `inlinetextbox`].includes(bc(e))
  )) {
    if (e.dragHint !== void 0) return e.dragHint || void 0;
    if (e.attrs?.draggable?.toLowerCase() === `true`) return `draggable`;
    if (e.attrs?.ondrop !== void 0 || e.attrs?.ondragover !== void 0) return `drop-target`;
    if ([`grab`, `grabbing`, `move`].includes(e.cursor ?? ``) || e.cursor?.endsWith(`-resize`))
      return `drag-handle`;
  }
}
function Dc(e) {
  let t = e.attrs ?? {},
    n = t[`aria-selected`]?.toLowerCase();
  if (n === `true` || n === `false`) return n === `true` ? `selected` : `unselected`;
  if (!(!Ac(e) && !Mc(e))) {
    if (t[`data-selected`] === `true` || t[`data-state`] === `selected`) return `selected:data`;
    if (t[`data-selected`] === `false` || t[`data-state`] === `unselected`)
      return `unselected:data`;
    if (t.class?.split(/\s+/).some((e) => e === `selected` || e === `is-selected`))
      return `selected:class`;
  }
}
function Oc(e) {
  let t = e.attrs?.[`data-index`];
  return Mc(e) && t !== void 0 && /^\d{1,9}$/.test(t) ? `item ${t}` : void 0;
}
function kc(e) {
  if (Ec(e) || Sc(e)) return !0;
  if (!e.role) return !1;
  let t = bc(e);
  return Zs.has(t) ? !1 : Qs.has(t) || ec(t) ? !0 : H(e.name) !== void 0;
}
function Ac(e) {
  return e.referenceable !== !1 && (Qs.has(bc(e)) || Sc(e) || Tc(e));
}
function jc(e) {
  return Ac(e) || (e.referenceable !== !1 && Ec(e) !== void 0);
}
function Mc(e) {
  if (e.clickable) return !0;
  let t = e.attrs ?? {};
  return uc.some((e) => Object.prototype.hasOwnProperty.call(t, e));
}
function Nc(e) {
  let t = e.attrs?.tabindex;
  if (t === void 0) return !1;
  let n = Number.parseInt(t, 10);
  return Number.isFinite(n) && n >= 0;
}
function Pc(e) {
  let t = e.attrs?.contenteditable?.toLowerCase();
  return t === `` || t === `true` || t === `plaintext-only`;
}
var Fc = new Set([`glyph`, `icon`, `icons`, `symbol`]),
  Ic = new Set([`fill`, `filled`, `line`, `outline`, `outlined`]);
function Lc(e) {
  let t = H(e);
  if (!t) return;
  let n = t.includes(`#`) ? t.slice(t.lastIndexOf(`#`) + 1) : ``,
    r = (n || t)
      ?.split(/[#/.\s:_-]+/)
      .filter(Boolean)
      .map((e) => e.toLowerCase());
  if (r.length === 0) return;
  if (n) {
    let e = r.filter((e) => !Fc.has(e) && !Ic.has(e));
    return e.length > 0 ? e.join(` `) : void 0;
  }
  let i = r.findLastIndex((e) => Fc.has(e));
  if (i < 0) return;
  let a = r.slice(i + 1).filter((e) => !Ic.has(e));
  return a.length > 0 ? a.join(` `) : void 0;
}
function Rc(e, t, n = 0) {
  if (!(n > 3))
    for (let r of t.get(e.id) ?? []) {
      let e = r.attrs ?? {},
        i =
          H(e[`aria-label`]) ??
          H(e.title) ??
          (bc(r) === `img` ? H(r.name) : void 0) ??
          ([`img`, `svg`, `use`].includes(xc(r)) ? (Lc(e.href) ?? Lc(e[`xlink:href`])) : void 0);
      if (i) return i;
      let a = Rc(r, t, n + 1);
      if (a) return a;
    }
}
function zc(e, t) {
  return (
    H(e.attrs?.[`aria-label`]) ??
    H(e.attrs?.title) ??
    H(e.name) ??
    H(e.text) ??
    H(e.nearbyText) ??
    (t ? Rc(e, t) : void 0) ??
    Oc(e)
  );
}
function Bc(e, t) {
  let n = bc(e),
    r = e.attrs?.role?.toLowerCase() ?? ``,
    i = Mc(e),
    a = Nc(e),
    o = zc(e, t) !== void 0;
  if (Pc(e)) return `textbox`;
  if (r === `combobox` && (i || a)) return `combobox`;
  if (mc.has(r) && o && (i || a || e.cursor === `pointer`))
    return r === `switch` || r === `checkbox` || r === `radio` || r === `tab` || r === `menuitem`
      ? r
      : `button`;
  if ((i && o) || ((!n || Zs.has(n)) && e.cursor === `pointer` && o)) return `button`;
}
function Vc(e) {
  return e.rect ? Math.max(0, e.rect.w) * Math.max(0, e.rect.h) : 0;
}
function Hc(e, t) {
  let n = Vc(e),
    r = xc(e);
  if (
    e.pointerEvents === `none` ||
    e.disabled ||
    e.inert ||
    e.insideNative ||
    (e.hasNativeDescendant && !Pc(e))
  )
    return !1;
  let i = n <= oc && zc(e, t) !== void 0 && Mc(e);
  return (n > ac && !Pc(e) && !i) || dc.has(r) || r === `a` || pc.has(r) ? !1 : Bc(e, t) !== void 0;
}
function Uc(e) {
  let t = new Set(e.map((e) => e.id)),
    n = new Map();
  for (let r of e) n.set(r.id, r.parentId !== null && t.has(r.parentId) ? r.parentId : null);
  return n;
}
function Wc(e, t, n) {
  let r = e.get(n) ?? null,
    i = 0;
  for (; r !== null && i <= e.size;) {
    if (r === t) return !0;
    ((r = e.get(r) ?? null), (i += 1));
  }
  return !1;
}
function Gc(e) {
  let t = new Map(e.map((e) => [e.id, e]));
  e = e.map((e) => {
    let n = e.parentId === null ? void 0 : t.get(e.parentId);
    return Ec(e) === `drag-handle` && n && Ec(n) && n.cursor === e.cursor && n.frameId === e.frameId
      ? { ...e, dragHint: !1 }
      : e;
  });
  let n = Uc(e),
    r = Kc(e),
    i = new Set(),
    a = new Map(),
    o = new Map();
  for (let t of e) {
    if (Ac(t)) continue;
    let e = Bc(t, r);
    if (!e || !Hc(t, r)) continue;
    (i.add(t.id), a.set(t.id, e));
    let n = zc(t, r);
    n && o.set(t.id, n);
  }
  for (let t of e) {
    if (!i.has(t.id)) continue;
    let e = n.get(t.id) ?? null,
      r = 0;
    for (; e !== null && r <= n.size;) (i.delete(e), (e = n.get(e) ?? null), (r += 1));
  }
  return e.map((e) => (i.has(e.id) ? { ...e, role: a.get(e.id), name: o.get(e.id) ?? e.name } : e));
}
function Kc(e) {
  let t = new Map(),
    n = new Set(e.map((e) => e.id));
  for (let r of e) {
    let e = r.parentId !== null && n.has(r.parentId) ? r.parentId : null,
      i = t.get(e) ?? [];
    (i.push(r), t.set(e, i));
  }
  return t;
}
var qc = new Set([`heading`, `article`, `section`, `group`, `region`, `row`, `form`]);
function Jc(e) {
  let t = new Map();
  for (let n of e) {
    if (jc(n) || il(n)) continue;
    let e = n.domParentId;
    if (e == null) continue;
    let r = t.get(n.contextScopeId);
    r || ((r = new Map()), t.set(n.contextScopeId, r));
    let i = r.get(e) ?? [];
    (i.push(n), r.set(e, i));
  }
  return { labelsByScopeParent: t };
}
function Yc(e) {
  let t = new Map();
  for (let n of e) {
    if (!jc(n)) continue;
    let e = H(n.name);
    if (!e) continue;
    let r = Cc(e);
    t.set(r, (t.get(r) ?? 0) + 1);
  }
  return new Set([...t].filter(([, e]) => e > 1).map(([e]) => e));
}
function Xc(e, t) {
  let n = Cc(e);
  return n ? t.has(n) : !1;
}
function Zc(e, t) {
  if (qc.has(bc(e))) return $c(H(e.name) ?? H(e.text) ?? H(e.nearbyText), t);
}
function Qc(e, t) {
  if (!jc(e)) return $c(H(e.name) ?? H(e.text) ?? H(e.nearbyText), t);
}
function $c(e, t) {
  let n = vc(e);
  if (!n) return;
  let r = Cc(n);
  if (!(!r || yc(n) || r === Cc(t) || r.startsWith(`ctx_`) || r === `section` || hc.has(r)))
    return n;
}
function el(e) {
  return e === `same` ? 0 : e === `owned` ? 1 : 2;
}
function tl(e) {
  return e.match(/^[a-z\s]+/)?.[0].trim() ?? e;
}
function nl(e) {
  return e.startsWith(`level `) ? 0 : e.startsWith(`group `) ? 1 : 2;
}
function rl(e) {
  let t = new Set(),
    n = new Set(),
    r = [...e].sort(
      (e, t) => el(e.source) - el(t.source) || nl(Cc(e.text)) - nl(Cc(t.text)) || e.order - t.order
    ),
    i = [];
  for (let e of r) {
    let r = vc(e.text);
    if (!r) continue;
    let a = Cc(r),
      o = `${e.source}:${tl(a)}`;
    if (!(!a || t.has(a) || n.has(o)) && (t.add(a), n.add(o), i.push(r), i.length >= 1)) break;
  }
  return i;
}
function il(e) {
  return [`region`, `form`, `section`, `article`, `row`, `listitem`, `group`].includes(bc(e));
}
function al(e, t) {
  return e.contextScopeId === t.contextScopeId;
}
function ol(e, t, n, r, i) {
  if (!al(t, e) || jc(e)) return;
  let a = Qc(e, n);
  if (a) {
    i.push(a);
    return;
  }
  for (let a of r.children.get(e.id) ?? []) if ((ol(a, t, n, r, i), i.length >= sc)) return;
}
function sl(e, t, n) {
  let r = [],
    i = n.parentMap.get(e.id) ?? null,
    a = 0;
  for (; i !== null && a <= n.parentMap.size;) {
    let o = n.nodesById.get(i);
    if (!o || !al(e, o)) break;
    let s = Zc(o, t);
    (s && r.push({ text: s, source: `owned`, order: r.length }),
      (i = n.parentMap.get(i) ?? null),
      (a += 1));
  }
  return r;
}
function cl(e, t, n) {
  let r = [],
    i = e.id,
    a = n.parentMap.get(e.id) ?? null,
    o = 0;
  for (; a !== null && o <= n.parentMap.size;) {
    let s = n.children.get(a) ?? [],
      c = n.siblingIndex.get(i) ?? s.length,
      l = n.siblingContextCache.get(a);
    l || ((l = new Map()), n.siblingContextCache.set(a, l));
    let u = JSON.stringify([e.contextScopeId, t, r]),
      d = l.get(u);
    for (
      (!d || d.nextIndex > c) && (d = { nextIndex: 0, labels: [...r] });
      d.nextIndex < c;
      d.nextIndex++
    )
      for (ol(s[d.nextIndex], e, t, n, d.labels); d.labels.length > sc;) d.labels.shift();
    (r.splice(0, r.length, ...d.labels),
      !l.has(u) && l.size >= 64 && l.delete(l.keys().next().value),
      l.set(u, d));
    let f = n.nodesById.get(a);
    if (!f || !al(e, f) || il(f)) break;
    ((i = a), (a = n.parentMap.get(a) ?? null), (o += 1));
  }
  return r.map((e, t) => ({ text: e, source: `same`, order: t }));
}
function ll(e, t, n) {
  let r = e.domAncestorIds ?? [];
  if (r.length === 0) return [];
  let i = n.domContextIndex.labelsByScopeParent.get(e.contextScopeId);
  for (let a of r) {
    let r = n.nodesById.get(a);
    if (
      r &&
      ([`rootwebarea`, `webarea`, `document`].includes(bc(r)) ||
        [`body`, `html`].includes(r.tag.toLowerCase()))
    )
      break;
    let o = r && al(e, r) && !jc(r) && $c(H(r.text) ?? H(r.name), t);
    if (o) return [{ text: o, source: `dom`, order: 0 }];
    let s = [];
    for (let n of i?.get(a) ?? []) {
      if (n.id === e.id) continue;
      let r = Qc(n, t);
      r && s.push({ text: r, source: `dom`, order: s.length });
    }
    if (s.length) return s;
    if (r && il(r)) break;
  }
  return [];
}
function ul(e, t) {
  let n = H(e.name);
  return !n || !Xc(n, t.duplicateRefNames)
    ? []
    : e.domAncestorIds?.length
      ? rl(ll(e, n, t))
      : rl([...sl(e, n, t), ...cl(e, n, t)]);
}
function dl(e, t, n, r = [], i = void 0, a = !1) {
  let o = `${`  `.repeat(t)}${n ? `@${n} ` : ``}${e.role ?? `generic`}`,
    s = Ec(e);
  s && (o += ` [${s}]`);
  let c = H(e.name);
  (c && (o += ` ${JSON.stringify(c)}`),
    r.length > 0 && (o += ` [ctx: ${r.join(` > `)}]`),
    bc(e) === `link` && e.href && (o += ` [→ ${e.href}]`));
  let l = H(e.value),
    u = bc(e),
    d = [`textbox`, `searchbox`].includes(u);
  e.disabled && (o += ` [disabled]`);
  let f = Dc(e);
  (f && (o += ` [${f}]`),
    e.checked !== void 0 &&
      (o += ` [${e.checked === `mixed` ? `mixed` : e.checked ? `checked` : `unchecked`}]`),
    d && (o += ` [${e.inputState ?? (l === void 0 ? `empty` : `filled`)}]`));
  let p = H(e.placeholder);
  p && (o += ` placeholder=${JSON.stringify(p)}`);
  let m = l !== void 0 || e.inputState === `filled` || e.inputState === `default`,
    h = e.sensitive || a ? (m ? tc : void 0) : l?.slice(0, ic);
  if ((h !== void 0 && (o += ` =${JSON.stringify(h)}`), i && i.subItems.length > 0)) {
    let e = i.subItems.slice(0, cc).join(` | `),
      t = i.subItems.length > cc ? ` | …` : ``,
      n = i.triggerAction === `hover` ? `hover first` : `${i.triggerAction} first`;
    o += ` [${n}: ${e}${t}]`;
  }
  return o;
}
function fl(e) {
  let t = bc(e);
  return [`textbox`, `searchbox`].includes(t) &&
    [`input`, `textarea`].includes((e.tag ?? ``).toLowerCase())
    ? !0
    : H(e.name)
      ? [`button`, `link`, `menuitem`, `tab`, `switch`, `checkbox`, `radio`, `combobox`].includes(t)
      : !1;
}
function pl(e, t) {
  let n = H(e.name);
  if (!n) return !1;
  let r = [...(t.children.get(e.id) ?? [])],
    i = [];
  for (; r.length > 0;) {
    let e = r.pop();
    if (jc(e)) return !1;
    let n = H(e.name) ?? H(e.text) ?? H(e.value);
    (n && i.push(n), r.push(...(t.children.get(e.id) ?? [])));
  }
  return i.length > 0 && i.every((e) => n.includes(e));
}
function ml(e, t) {
  let n = bc(e);
  return [`cell`, `gridcell`, `columnheader`, `rowheader`].includes(n) ? pl(e, t) : !1;
}
function hl(e, t, n) {
  for (let r = t.length - 1; r >= 0; --r) e.push({ node: t[r], depth: n });
}
function* gl(e, t, n = !1, r) {
  let i = [];
  for (hl(i, e.get(null) ?? [], 1); i.length > 0;) {
    let { node: a, depth: o } = i.pop();
    if (r?.has(a.id) || (a.visualKey === void 0 && !kc(a))) {
      hl(i, e.get(a.id) ?? [], o);
      continue;
    }
    if (o > t.maxDepth && a.visualKey === void 0) {
      ((t.truncated = !0), n && t.visualAncestors.has(a.id) && hl(i, e.get(a.id) ?? [], o));
      continue;
    }
    let s = a.visualKey !== void 0,
      c = s || jc(a) ? (t.allocateRef?.(a) ?? `e${t.nextRef++}`) : void 0,
      l = c && !s ? ul(a, t) : [],
      u = t.surfaceMap.get(a.id),
      d = `  `.repeat(Math.min(o, t.maxDepth, 32)),
      f = s ? `${d}@${c} canvas [visual:screenshot]` : void 0,
      p = H(a.name),
      m = s
        ? p
          ? `${d}@${c} canvas ${JSON.stringify(Array.from(p).slice(0, 160).join(``))} [visual:screenshot]`
          : f
        : dl(a, o, c, l, u, t.redactValues),
      h = a.parentId === null ? void 0 : t.nodesById.get(a.parentId),
      g = h ? H(h.name) : void 0;
    yield {
      ...(h
        ? {
            context: `@context ${h.role ?? h.tag}${g ? ` ${JSON.stringify(Array.from(g).slice(0, 80).join(``))}` : ``}`,
          }
        : {}),
      frameId: a.frameId,
      text: m,
      ...(f ? { minimal: f } : {}),
      ...(c
        ? {
            ref: {
              ref: c,
              backendNodeId: a.backendNodeId ?? a.id,
              ...(s ? { visualKey: a.visualKey } : {}),
              ...(a.frameId ? { frameId: a.frameId } : {}),
              ...(a.role ? { role: a.role } : {}),
              ...(p ? { name: p } : {}),
              ...(l.length > 0 ? { ctx: l.join(` > `) } : {}),
              line: 0,
            },
          }
        : {}),
    };
    let _ = t.scopeMap.get(a.id);
    if (_?.lines.length) {
      yield { text: `${`  `.repeat(o + 1)}[§ active: ${_.label}]` };
      for (let e of _.lines.slice(0, lc)) {
        let t = H(e);
        t && (yield { text: `${`  `.repeat(o + 2)}${t}` });
      }
    }
    ((!n || !t.visualAncestors.has(a.id)) && ((c && fl(a)) || ml(a, t))) ||
      hl(i, e.get(a.id) ?? [], o + 1);
  }
}
function _l(e, t, n, r, i) {
  let a = Kc(e),
    o = new Map();
  for (let e of a.values()) for (let t = 0; t < e.length; t++) o.set(e[t].id, t);
  let s = {
    visualAncestors: new Set(),
    siblingIndex: o,
    siblingContextCache: new Map(),
    lines: [...n],
    refs: [],
    nextRef: 1,
    allocateRef: t.allocateRef,
    tokens: Ys(
      n.join(`
`)
    ),
    maxDepth: t.maxDepth ?? nc,
    maxTokens: t.maxTokens ?? rc,
    redactValues: t.redactValues ?? !1,
    truncated: !1,
    children: a,
    parentMap: Uc(e),
    nodesById: new Map(e.map((e) => [e.id, e])),
    domContextIndex: Jc(e),
    duplicateRefNames: Yc(e),
    surfaceMap: new Map(r.map((e) => [e.triggerId, e])),
    scopeMap: new Map(i.map((e) => [e.triggerId, e])),
  };
  for (let t of e) {
    if (t.visualKey === void 0) continue;
    let e = t.parentId;
    for (; e !== null && !s.visualAncestors.has(e);)
      (s.visualAncestors.add(e), (e = s.parentMap.get(e) ?? null));
  }
  return s;
}
function vl(e, t, n, r = [], i = []) {
  let a = _l(e, t, n, r, i),
    o = a.children;
  for (let e of gl(o, a)) {
    let t = Xs(e.text);
    if (a.tokens + t > a.maxTokens) {
      a.truncated = !0;
      break;
    }
    (e.ref && a.refs.push({ ...e.ref, line: a.lines.length }),
      a.lines.push(e.text),
      (a.tokens += t));
  }
  return a;
}
function yl(e) {
  return `L2 page … occluded by L1 (~${e} nodes, not actionable)`;
}
function bl(e) {
  return e.pointerEvents !== `none` && e.rect !== null && gc.has(e.position);
}
function xl(e, t, n) {
  return t >= e.x && t <= e.x + e.w && n >= e.y && n <= e.y + e.h;
}
function Sl(e) {
  let t = Math.min(e.w * 0.15, 8),
    n = Math.min(e.h * 0.15, 8),
    r = e.x + e.w / 2,
    i = e.y + e.h / 2;
  return [
    [r, i],
    [e.x + t, e.y + n],
    [e.x + e.w - t, e.y + n],
    [e.x + t, e.y + e.h - n],
    [e.x + e.w - t, e.y + e.h - n],
    [r, e.y + n],
    [r, e.y + e.h - n],
    [e.x + t, i],
    [e.x + e.w - t, i],
  ];
}
function Cl(e, t, n) {
  let r = new Map(),
    i = e,
    a = 0;
  for (; i && a <= t.size;) {
    r.has(i.frameId) || r.set(i.frameId, i);
    let e = t.get(i.id) ?? null;
    ((i = e === null ? void 0 : n.get(e)), (a += 1));
  }
  return r;
}
function wl(e, t, n, r) {
  let i = r.get(e.id);
  if (i) return i;
  let a = Cl(e, t, n);
  return (r.set(e.id, a), a);
}
function Tl(e, t, n, r, i) {
  if (e.frameId === t.frameId) return { target: e, blocker: t };
  let a = wl(e, n, r, i),
    o = wl(t, n, r, i);
  for (let [e, t] of o) {
    let n = a.get(e);
    if (n) return { target: n, blocker: t };
  }
  return null;
}
function El(e, t, n, r, i, a) {
  if (e.id === t.id || Wc(n, t.id, e.id) || Wc(n, e.id, t.id) || !e.rect || !t.rect) return !1;
  let o = Tl(e, t, n, r, a);
  if (!o) return !1;
  let s = Sl(e.rect);
  return (!i &&
    o.target.paintOrder >= o.blocker.paintOrder &&
    s.some(([e, n]) => xl(t.rect, e, n))) ||
    o.blocker.paintOrder < o.target.paintOrder ||
    (o.blocker.paintOrder === o.target.paintOrder && o.blocker.id <= o.target.id)
    ? !1
    : s.some(([e, n]) => xl(t.rect, e, n));
}
function Dl(e, t) {
  let n = new Map();
  for (let t of e) {
    if (t.parentId === null) continue;
    let e = n.get(t.parentId) ?? [];
    (e.push(t.id), n.set(t.parentId, e));
  }
  let r = new Set(t),
    i = [...t];
  for (let e = 0; e < i.length; e += 1)
    for (let t of n.get(i[e]) ?? []) r.has(t) || (r.add(t), i.push(t));
  return r;
}
function Ol(e, t, n) {
  let r = Uc(e),
    i = new Map(e.map((e) => [e.id, e])),
    a = new Map(),
    o = e
      .filter(bl)
      .map((e) => ({
        node: e,
        viewportCoverage: Ss(e.rect, t.viewport),
        fullCover: Cs(e.rect, t.viewport),
      }))
      .filter((e) => e.viewportCoverage > 0 || e.node.modal === !0),
    s = new Set();
  for (let t of e)
    (t.visualKey === void 0 && !jc(t)) ||
      (o.some((e) => El(n?.get(t.id) ?? t, e.node, r, i, e.fullCover, a)) && s.add(t.id));
  if (s.size === 0) return e;
  let c = Dl(e, s);
  return e.filter((e) => !c.has(e.id));
}
function kl(e) {
  return e.filter(kc).length;
}
function Al(e, t, n) {
  let r = Dl(e.nodes, t.members),
    i = e.nodes.filter((e) => r.has(e.id)),
    a = kl(e.nodes.filter((e) => !r.has(e.id))),
    o = vl(
      i,
      n,
      [
        `@vom 1`,
        `@view ${e.viewport.width}x${e.viewport.height}`,
        `@layers 2 focus=L1`,
        `L1 ${t.kind} cover=${Math.round(t.coverage * 100)}%`,
      ],
      e.surfaces,
      e.activeScopeBlocks
    );
  return (
    o.lines.push(yl(a)),
    {
      text: o.lines.join(`
`),
      refs: o.refs,
      truncated: o.truncated,
    }
  );
}
function jl(e, t = {}) {
  let n = Gc(e.nodes),
    r = { ...e, nodes: n },
    i = Ds(n, e.viewport, e.rootFrameId);
  if (i) return Al(r, i, t);
  let a = vl(
    t.activeRegionPolicy ? Ol(n, e) : n,
    t,
    [`@vom 1`, `@view ${e.viewport.width}x${e.viewport.height}`, `@layers 1 focus=L1`, `L1 page`],
    e.surfaces,
    e.activeScopeBlocks
  );
  return {
    text: a.lines.join(`
`),
    refs: a.refs,
    truncated: a.truncated,
  };
}
function Nl(e, t) {
  return `${e}\u0000${t}`;
}
function Pl(e, t) {
  return `${e}\u0000${t}`;
}
async function Iu(e, t, n = !1) {
  let r = gi(t),
    i = new Map(),
    a = new Map(),
    o = n ? new Map() : void 0,
    s = new Set();
  for (let t = 0; t < e.length; t++) {
    if (t % 256 == 0) {
      let e = r();
      e && (await e);
    }
    let n = e[t];
    i.set(n.backendNodeId, n);
  }
  let c = 0;
  for (let t of e) {
    if (c++ % 256 == 0) {
      let e = r();
      e && (await e);
    }
    if (a.has(t.backendNodeId)) continue;
    let e = [],
      n = new Set(),
      l = t,
      u = !1,
      d = !1;
    for (; l && !a.has(l.backendNodeId);) {
      if (c++ % 256 == 0) {
        let e = r();
        e && (await e);
      }
      if (n.has(l.backendNodeId)) {
        u = e
          .slice(e.findIndex((e) => e.backendNodeId === l.backendNodeId))
          .some((e) => Ka(e.tag, Object.keys(e.attrs)));
        break;
      }
      if ((n.add(l.backendNodeId), e.push(l), l.parentBackendNodeId === null)) {
        (o && (d = !l.parentMissing && l.nodeType === 9), (l = void 0));
        break;
      }
      l = i.get(l.parentBackendNodeId);
    }
    l &&
      a.has(l.backendNodeId) &&
      ((u = a.get(l.backendNodeId)), o && (d = o.get(l.backendNodeId) === !0));
    for (let t = e.length - 1; t >= 0; t--) {
      if (c++ % 256 == 0) {
        let e = r();
        e && (await e);
      }
      let n = e[t];
      ((u ||= Ka(n.tag, Object.keys(n.attrs))),
        a.set(n.backendNodeId, u),
        o && ((d &&= !n.parentMissing), o.set(n.backendNodeId, d)),
        u && s.add(n.backendNodeId));
    }
  }
  return { nodes: i, ...(o ? { ancestryComplete: o } : {}), excludedBackendNodeIds: s };
}
var Lu = 250,
  Ru = 64;
function zu(e) {
  return `(() => {
    const maxControls = ${JSON.stringify(e)};
    let remaining = maxControls;
    const controlSelector = "input,textarea,select";
    const sensitiveSelector = ${JSON.stringify(`input[type="password"],[${ia}],${oa}`)};
    const controlState = (el) => {
      const tag = el.tagName.toLowerCase();
      const type = tag === "input" ? String(el.type || "text").toLowerCase() : tag;
      const sensitive =
        type === "password" ||
        type === "credit-card" ||
        (typeof el.matches === "function" && el.matches(sensitiveSelector));
      const rawValue = typeof el.value === "string" ? el.value : "";
      const defaultValue = typeof el.defaultValue === "string" ? el.defaultValue : "";
      const placeholder = typeof el.placeholder === "string" ? el.placeholder : "";
      const state =
        rawValue === "" ? "empty" : !sensitive && rawValue === defaultValue ? "default" : "filled";
      return {
        state,
        sensitive,
        placeholder,
        inForm: el.form !== null,
        ...(sensitive ? {} : { value: rawValue, defaultValue }),
      };
    };
    const controls = [];
    const collect = (doc) => {
      for (const el of Array.from(doc.querySelectorAll(controlSelector))) {
        if (remaining <= 0) break;
        // Deep serialization supplies the node's backend id. Keep the
        // state as JSON so decoding needs no general-purpose V8 deserializer.
        controls.push([el, JSON.stringify(controlState(el))]);
        remaining -= 1;
      }
      for (const frame of Array.from(doc.querySelectorAll("iframe"))) {
        if (remaining <= 0) break;
        let childDoc = null;
        try { childDoc = frame.contentDocument; } catch { childDoc = null; }
        if (childDoc) collect(childDoc);
      }
    };
    collect(document);
    return controls;
  })()`;
}
function Bu(e) {
  let t = new Map(),
    n = e.result?.deepSerializedValue;
  if (n?.type !== `array` || !Array.isArray(n.value)) return t;
  for (let e of n.value) {
    if (e?.type !== `array` || !Array.isArray(e.value)) continue;
    let [n, r] = e.value;
    if (n?.type !== `node` || r?.type !== `string` || typeof r.value != `string`) continue;
    let i = n.value?.backendNodeId;
    if (!(typeof i != `number` || !Number.isSafeInteger(i)))
      try {
        let e = JSON.parse(r.value);
        if (
          !e ||
          ![`empty`, `filled`, `default`].includes(e.state ?? ``) ||
          typeof e.sensitive != `boolean` ||
          typeof e.placeholder != `string` ||
          (e.inForm !== void 0 && typeof e.inForm != `boolean`) ||
          (!e.sensitive && (typeof e.value != `string` || typeof e.defaultValue != `string`))
        )
          continue;
        t.set(i, e);
      } catch (err) {
        noteSwallowed("snapshot.caught", err);
      }
  }
  return t;
}
function Vu(e, t) {
  for (let n of e) {
    if (![`input`, `textarea`, `select`].includes(n.tag)) continue;
    let e = t.get(n.backendNodeId);
    if (!e) continue;
    let r =
      e.sensitive ||
      (n.tag === `input` &&
        ((n.attrs.type ?? ``).toLowerCase() === `password` ||
          Object.prototype.hasOwnProperty.call(n.attrs, `data-bctl-record-password`))) ||
      aa(n.attrs.autocomplete);
    ((n.inForm = e.inForm),
      (n.formState = r && e.state === `default` ? `filled` : e.state),
      (n.formPlaceholder = e.placeholder ?? ``),
      r
        ? (delete n.formValue, delete n.formDefaultValue, delete n.attrs.value)
        : ((n.formDefaultValue = e.defaultValue ?? ``),
          e.value !== void 0 && (n.formValue = e.value)));
  }
}
async function Hu(e, t, n, r, i) {
  let a = n
      .flat()
      .filter(
        (e) => e.tag === `input` && e.attrs.type?.toLowerCase() === `range` && e.inForm === void 0
      )
      .slice(0, Ru),
    o = 0,
    s = !1,
    c;
  if (
    (await Promise.all(
      Array.from({ length: Math.min(4, a.length) }, async () => {
        for (; o < a.length && !s && !i?.aborted;) {
          let n = a[o++];
          try {
            B(i);
            let a = await e.send(t, `DOM.resolveNode`, {
              backendNodeId: n.backendNodeId,
              objectGroup: r,
            });
            if ((B(i), s)) return;
            if (!a.object?.objectId) continue;
            let o = await e.send(t, `Runtime.callFunctionOn`, {
              objectId: a.object.objectId,
              functionDeclaration: `function() { return this.form !== null; }`,
              returnByValue: !0,
              throwOnSideEffect: !0,
            });
            (B(i),
              !o.exceptionDetails &&
                typeof o.result?.value == `boolean` &&
                (n.inForm = o.result.value));
          } catch (e) {
            hi(e) && (s || (c = e), (s = !0));
          }
        }
      })
    ),
    B(i),
    s)
  )
    throw c;
}
async function Uu(e, t, n, r) {
  if (!n.some((e) => e.some((e) => [`input`, `textarea`, `select`].includes(e.tag)))) return !0;
  let i = `bctl-vom-forms-${makeUuid()}`;
  try {
    B(r);
    let a = await e.send(t, `Runtime.evaluate`, {
      expression: zu(Lu),
      objectGroup: i,
      serializationOptions: {
        serialization: `deep`,
        maxDepth: 3,
        additionalParameters: { maxNodeDepth: 0, includeShadowTree: `none` },
      },
    });
    B(r);
    let o = Bu(a);
    for (let e of n) Vu(e, o);
    return (await Hu(e, t, n, i, r), !0);
  } catch (e) {
    if (hi(e)) throw e;
    return !1;
  } finally {
    (await e
      .send(t, `Runtime.releaseObjectGroup`, { objectGroup: i })
      .catch(swallow("snapshot.ignore")),
      B(r));
  }
}
function Wu(e, t) {
  return `${N(e)}:${t}`;
}
function Gu(e, t) {
  return `${N(e)}:${t}`;
}
function Ku(e, t) {
  let n = new Map();
  for (let t of e?.frames ?? []) n.set(t.frameId, t);
  for (let e of t) n.has(e.frame.frameId) || n.set(e.frame.frameId, e.frame);
  return [...n.values()];
}
async function qu(e, t, n, r, i) {
  let a = gi(r),
    o = 0,
    s = Ku(e, t),
    c = new Map(s.map((e) => [e.frameId, e])),
    l = e?.rootFrameId ?? n.rootFrameId ?? s[0]?.frameId,
    u = (e) => n.frameNodes?.get(e) ?? (e === l ? n.nodes : []),
    d = new Map();
  for (let e of s)
    for (let t of u(e.frameId)) {
      if (o++ % 256 == 0) {
        let e = a();
        e && (await e);
      }
      d.set(Gu(e.target, t.backendNodeId), e.frameId);
    }
  let f = new Map();
  for (let e of t) {
    let t = new Map();
    for (let n of e.nodes) {
      if (o++ % 256 == 0) {
        let e = a();
        e && (await e);
      }
      t.set(n.nodeId, n);
    }
    let n = !1,
      r = new Map();
    for (let s of e.nodes) {
      let l = [],
        u = new Set(),
        p = s,
        m = { frameId: e.frame.frameId, strength: 1 };
      for (; p;) {
        if (o++ % 256 == 0) {
          let e = a();
          e && (await e);
        }
        let s = r.get(p.nodeId);
        if (s) {
          m = s;
          break;
        }
        if (u.has(p.nodeId)) break;
        if ((u.add(p.nodeId), p.frameId)) {
          let t = c.get(p.frameId);
          if (!t || N(t.target) !== N(e.frame.target)) {
            ((n ||= (i?.(e.frame), !0)), (m = { frameId: ``, strength: 0 }));
            break;
          }
          ((m = { frameId: t.frameId, strength: 4 }), r.set(p.nodeId, m));
          break;
        }
        let f =
          typeof p.backendDOMNodeId == `number`
            ? d.get(Gu(e.frame.target, p.backendDOMNodeId))
            : void 0;
        if (f) {
          ((m = { frameId: f, strength: 3 }), r.set(p.nodeId, m));
          break;
        }
        (l.push(p), (p = p.parentId ? t.get(p.parentId) : void 0));
      }
      for (let e = l.length - 1; e >= 0; e--) {
        if (o++ % 256 == 0) {
          let e = a();
          e && (await e);
        }
        ((m = { frameId: m.frameId, strength: Math.min(2, m.strength) }), r.set(l[e].nodeId, m));
      }
      if ((r.has(s.nodeId) || r.set(s.nodeId, m), !m.frameId)) continue;
      let h = Wu(e.frame.target, s.nodeId),
        g = f.get(h);
      (!g || m.strength > g.ownership.strength) &&
        f.set(h, { node: s, target: e.frame.target, ownership: m });
    }
  }
  let p = new Map([...f].map(([e, t]) => [e, t.ownership.frameId])),
    m = new Map();
  for (let e of f.values()) {
    if (o++ % 256 == 0) {
      let e = a();
      e && (await e);
    }
    let { node: t, target: n, ownership: r } = e,
      i = t.parentId ? p.get(Wu(n, t.parentId)) : void 0,
      s = t.childIds?.filter((e) => p.get(Wu(n, e)) === r.frameId),
      c = {
        ...t,
        frameId: r.frameId,
        ...(i === r.frameId ? { parentId: t.parentId } : { parentId: void 0 }),
        ...(s ? { childIds: s } : {}),
      },
      l = m.get(r.frameId) ?? [];
    (l.push(c), m.set(r.frameId, l));
  }
  return s.map((e) => ({
    ...e,
    contextScopeId: e.frameId,
    axNodes: m.get(e.frameId) ?? [],
    domNodes: u(e.frameId),
    excludedBackendNodeIds: n.frameExcludedBackendNodeIds?.get(e.frameId),
  }));
}
async function Ju(e, t) {
  let n = gi(t),
    r = new Map(),
    i = 0;
  for (let t of e.nodes.values()) {
    if (i++ % 256 == 0) {
      let e = n();
      e && (await e);
    }
    if (
      [`input`, `textarea`, `select`].includes(t.tag) ||
      (t.tag !== `progress` &&
        !t.attrs.role
          ?.toLowerCase()
          .split(/\s+/)
          .some((e) => [`slider`, `progressbar`].includes(e)))
    )
      continue;
    let a = [],
      o = new Set(),
      s = t,
      c;
    for (; s;) {
      if (i++ % 256 == 0) {
        let e = n();
        e && (await e);
      }
      if (r.has(s.backendNodeId)) {
        c = r.get(s.backendNodeId);
        break;
      }
      if (o.has(s.backendNodeId)) break;
      if ((o.add(s.backendNodeId), a.push(s.backendNodeId), s.tag === `form`)) {
        c = !0;
        break;
      }
      if (s.parentMissing) break;
      if (s.parentBackendNodeId === null) {
        s.nodeType === 9 && (c = !1);
        break;
      }
      s = e.nodes.get(s.parentBackendNodeId);
    }
    for (let e of a) {
      if (i++ % 256 == 0) {
        let e = n();
        e && (await e);
      }
      r.set(e, c);
    }
    t.inForm = c;
  }
}
async function Yu(e, t, n, r, i = la) {
  let a = await ga(e, t, r, i),
    o = gi(r),
    s = [];
  for (let e = 0; e < a.nodes.length; e++) {
    if (e % 256 == 0) {
      let e = o();
      e && (await e);
    }
    let t = a.nodes[e],
      r = t.layout?.bounds ?? [],
      i = t.layout?.styles.visibility || `visible`,
      c = t.layout?.styles.opacity || `1`;
    s.push({
      ...t,
      ...(n.frameId ? { frameId: n.frameId } : {}),
      ownerFrameBackendNodeId: n.ownerFrameBackendNodeId,
      localRect: null,
      rect: null,
      rendered:
        r.length >= 4 &&
        r.slice(0, 4).every(Number.isFinite) &&
        r[2] > 0 &&
        r[3] > 0 &&
        i !== `hidden` &&
        i !== `collapse` &&
        (Number.parseFloat(c) || 0) > 0,
    });
  }
  let c = await Iu(s, r, i.includeVisualFacts);
  await Ju(c, r);
  let l = {
    nodes: s.filter(
      (e) => !e.tag.startsWith(`#`) && !c.excludedBackendNodeIds.has(e.backendNodeId)
    ),
    index: c,
    documentElementBackendNodeId: s.find(
      (e) =>
        e.nodeType === 1 &&
        e.parentBackendNodeId !== null &&
        c.nodes.get(e.parentBackendNodeId)?.nodeType === 9
    )?.backendNodeId,
  };
  return (n.coordinates && (await Xu(l, n, r, i)), l);
}
async function Xu(e, t, n, r = la) {
  let i = gi(n),
    a = 0;
  for (let n of e.index.nodes.values()) {
    if (a++ % 256 == 0) {
      let e = i();
      e && (await e);
    }
    let e = ss(n.layout?.bounds ?? [], { target: t.target, frameId: t.frameId }, t.coordinates),
      r = e?.rect,
      o = e && t.projection?.status === `available` ? cs(e, t.projection.projection) : null;
    (o &&
      t.targetProjection !== void 0 &&
      (o = t.targetProjection
        ? Yi({ x: o.x, y: o.y, w: o.width, h: o.height }, t.targetProjection)
        : null),
      (n.localRect = r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null),
      (n.rect = o ? { x: o.x, y: o.y, w: o.width, h: o.height } : null));
  }
  r.includeVisualFacts &&
  t.coordinates &&
  t.projection?.status === `available` &&
  t.targetProjection !== null
    ? (e.geometry = {
        projections: [
          t.projection.projection.geometry,
          ...(t.targetProjection ? [t.targetProjection] : []),
        ],
        coordinates: t.coordinates,
        pageScale: t.pageScale,
      })
    : delete e.geometry;
}
async function Zu(e, t, n, r, i, a = la) {
  let o = e.strings ?? [],
    s = new Map(n.map((e) => [e.frameId, e])),
    c = new Set(),
    l = [];
  for (let n of e.documents ?? []) {
    let e = da(n, o),
      u = e ? s.get(e) : void 0;
    if (!e || !u || c.has(e)) {
      r.push({ target: t, frameId: e, stage: `ownership`, reason: `frame-ownership-unresolved` });
      continue;
    }
    c.add(e);
    let d = await Yu(
      n,
      o,
      {
        frameId: e,
        target: t,
        ownerFrameBackendNodeId: u.ownerBackendNodeId ?? null,
        projection: null,
        coordinates: null,
      },
      i,
      a
    );
    l.push({ ...d, frame: u, snapshot: n });
  }
  return l;
}
async function Qu(e, t, n, r, i, a, o, s = la) {
  let c = new Set();
  for (let { snapshot: t } of e)
    for (let e of t.nodes?.contentDocumentIndex?.index ?? []) {
      let n = t.nodes?.backendNodeId?.[e];
      n !== void 0 && c.add(n);
    }
  r.registerSnapshotOwners(t, c);
  let l = new Map(n.map((e) => [e.frameId, e])),
    u = new Map(e.map((e) => [e.frame.frameId, e.snapshot])),
    d = new Map(e.map((e) => [e.frame.frameId, e])),
    f = {};
  try {
    f = await r.layoutMetrics(t);
  } catch (e) {
    if (hi(e)) throw e;
  }
  let p = {
      width: f.cssLayoutViewport?.clientWidth ?? 0,
      height: f.cssLayoutViewport?.clientHeight ?? 0,
    },
    m = Zi(f),
    h = [p.width, p.height].every((e) => Number.isFinite(e) && e > 0),
    g = new Map(),
    _ = [];
  for (let e of n)
    if (!e.parentFrameId || !l.has(e.parentFrameId)) _.push(e);
    else {
      let t = g.get(e.parentFrameId);
      t ? t.push(e) : g.set(e.parentFrameId, [e]);
    }
  let v = new Map(),
    y = null,
    b = o ? l.get(o) : void 0;
  if (t.sessionId && b)
    try {
      let e = await r.frame(b.frameId);
      e && N(e.target) === N(t) && (y = await r.targetProjection(b.frameId));
    } catch (e) {
      if (hi(e)) throw e;
    }
  let x = gi(a),
    S = new Set(),
    C = n[Symbol.iterator]();
  for (let e = 0; S.size < n.length; e++) {
    if (e >= _.length) {
      let e = C.next();
      for (; !e.done && S.has(e.value.frameId);) e = C.next();
      if (e.done) break;
      _.push(e.value);
    }
    if (e % 256 == 0) {
      let e = x();
      e && (await e);
    }
    let n = _[e];
    if (S.has(n.frameId)) continue;
    S.add(n.frameId);
    for (let e of g.get(n.frameId) ?? []) _.push(e);
    let c = u.get(n.frameId);
    if (!c) continue;
    let l = { target: t, frameId: n.frameId },
      b = os(
        c,
        m,
        n.frameId === o ? { x: f.cssLayoutViewport?.pageX, y: f.cssLayoutViewport?.pageY } : void 0
      ),
      w =
        n.frameId === o
          ? h && b
            ? {
                status: `available`,
                projection: { source: l, geometry: { sourceClips: [], edges: [], topViewport: p } },
              }
            : { status: `unavailable`, source: l, reason: `snapshot-coordinates-unavailable` }
          : (v.get(n.frameId) ?? null);
    (!w &&
      n.frameId !== o &&
      i.push({
        target: t,
        frameId: n.frameId,
        stage: `ownership`,
        reason: `frame-ownership-unresolved`,
      }),
      !b &&
        (!w || w.status === `available`) &&
        (w = { status: `unavailable`, source: l, reason: `snapshot-coordinates-unavailable` }),
      v.set(n.frameId, w));
    let T = w?.status === `available` ? w.projection : null;
    (!T || (t.sessionId && !y)) &&
      i.push({
        target: t,
        frameId: n.frameId,
        stage: `geometry`,
        reason: `geometry-unavailable`,
        ...(w && w.status !== `available` ? { projectionIssue: w } : {}),
      });
    let E = (g.get(n.frameId) ?? []).filter((e) => u.has(e.frameId)),
      D = T?.geometry.edges[0],
      O = D ? [D.destinationQuad, ...(D.destinationClips ?? [])] : (T?.geometry.sourceClips ?? []),
      k = 0,
      A;
    if (
      (await Promise.all(
        Array.from({ length: Math.min(4, E.length) }, async () => {
          for (; k < E.length && !a?.aborted && !A;) {
            let e = E[k++],
              n = { target: t, frameId: e.frameId };
            if (!T) {
              v.set(
                e.frameId,
                w && w.status !== `available`
                  ? { status: `blocked`, source: n, cause: w.status === `blocked` ? w.cause : w }
                  : null
              );
              continue;
            }
            if (e.ownerBackendNodeId === void 0) {
              v.set(e.frameId, null);
              continue;
            }
            if (!os(u.get(e.frameId), m)) {
              v.set(e.frameId, {
                status: `unavailable`,
                source: n,
                reason: `snapshot-coordinates-unavailable`,
              });
              continue;
            }
            try {
              v.set(e.frameId, await r.snapshotProjection(n, e.ownerBackendNodeId, O, p));
            } catch (e) {
              A ??= e;
            }
          }
        })
      ),
      A)
    )
      throw A;
    (B(a),
      await Xu(
        d.get(n.frameId),
        {
          frameId: n.frameId,
          ownerFrameBackendNodeId: n.ownerBackendNodeId ?? null,
          projection: w,
          ...(s.includeVisualFacts
            ? { pageScale: f.cssVisualViewport?.scale ?? f.visualViewport?.scale }
            : {}),
          target: t,
          ...(t.sessionId ? { targetProjection: y } : {}),
          coordinates: b,
        },
        a,
        s
      ));
  }
}
var $u = `observation document identity changed or could not be verified; observe again`;
async function ed(e, t, n) {
  let r = 0,
    i = !1,
    a;
  if (
    (await Promise.all(
      Array.from({ length: Math.min(4, e.length) }, async () => {
        try {
          for (; r < e.length && !i && !n?.aborted;) {
            let n = e[r++];
            await t(n);
          }
        } catch (e) {
          (i || (a = e), (i = !0));
        }
      })
    ),
    B(n),
    i)
  )
    throw a;
}
async function td(e, t, n) {
  await ed([...n], async ([n, r]) => {
    e.getAttachmentId?.(t) === r &&
      (await (
        e.sendGuarded && r !== void 0
          ? e.sendGuarded(n, `Accessibility.disable`, {}, { attachmentId: r })
          : L(e, n, `Accessibility.disable`, {})
      ).catch(swallow("snapshot.ignore")));
  });
}
function nd(e, t) {
  if (t instanceof Rt)
    for (let n of e.keys()) (!t.sessionId || n.sessionId === t.sessionId) && e.delete(n);
}
async function rd(e, t, n, r, i, a = {}) {
  let o = new Map(),
    s;
  try {
    let c = await id(e, t, o, r, i, a);
    (B(r), (s = await n(c)));
  } catch (e) {
    throw (nd(o, e), e);
  } finally {
    await td(e, t, o);
  }
  return (B(r), s);
}
async function id(e, t, n, r, i, a) {
  let o = a.includeVisualFacts ? ua : la,
    s = Date.now();
  B(r);
  let c;
  try {
    c = await e.getFrameGraph?.(t, r);
  } catch (e) {
    if ((nd(n, e), hi(e))) throw e;
  }
  B(r);
  let l = new $i(e, t, c, r),
    u = (c?.unavailableFrames ?? []).map((e) => ({
      target: e.target,
      frameId: e.frameId,
      stage: `dom`,
      reason: `capture-unavailable`,
    })),
    d = new Set(c?.unavailableFrames?.map((e) => e.frameId)),
    f = new Map(c?.frames.map((e) => [e.frameId, e]) ?? []),
    p = new Map();
  for (let e of c?.frames ?? []) {
    let t = N(e.target),
      n = p.get(t);
    (n ||
      ((n = { target: e.target, frames: [], documents: [], ax: [], fallbackExcluded: new Set() }),
      p.set(t, n)),
      n.frames.push(
        !e.target.sessionId && e.frameId === c?.rootFrameId && !e.url && i ? { ...e, url: i } : e
      ));
  }
  p.has(N({ tabId: t })) ||
    p.set(N({ tabId: t }), {
      target: { tabId: t },
      frames: [],
      documents: [],
      ax: [],
      fallbackExcluded: new Set(),
    });
  let m = [...p.values()],
    h = (e, t, n) =>
      u.push({ target: e.target, frameId: n, stage: t, reason: `capture-unavailable` }),
    g,
    _ = new Set(),
    v = (e, n) => {
      if (!(e instanceof Rt) || !n.target.sessionId || !e.sessionId || e.tabId !== t) return !1;
      let r = m.find((t) => t.target.sessionId === e.sessionId);
      if (!r) return !1;
      let i = Ut(
        { rootFrameId: c?.rootFrameId ?? `root`, frames: m.flatMap((e) => e.frames) },
        new Map([...r.frames, ...n.frames].map((e) => [e.frameId, e.target]))
      );
      for (let e of i.unavailableFrames ?? []) d.add(e.frameId);
      for (let e of m)
        e.target.sessionId &&
          ((e !== n && !e.frames.some((e) => d.has(e.frameId))) ||
            (_.has(e) || h(e, `dom`), _.add(e)));
      return !0;
    };
  await ed(
    m,
    async (a) => {
      if (_.has(a)) return;
      let s = $r(e, a.target);
      try {
        (B(r),
          await s.send(t, `DOMSnapshot.enable`, {}),
          B(r),
          (a.snapshotAttachmentId = e.getAttachmentId?.(t)));
        let n = await s.send(t, `DOMSnapshot.captureSnapshot`, {
          computedStyles: o.computedStyles,
          includePaintOrder: !0,
          includeDOMRects: !0,
        });
        B(r);
        let c = _a(n, a.target, f, i);
        ((a.snapshotFrameIds = new Set([...c.ids].filter((e) => !d.has(e)))),
          (a.rootFrameId = c.rootFrameId),
          (a.frames = [
            ...c.frames.filter((e) => !d.has(e.frameId)),
            ...a.frames.filter((e) => !c.ids.has(e.frameId)),
          ]),
          (a.documents = await Zu(
            n,
            a.target,
            a.frames.filter((e) => c.ids.has(e.frameId)),
            u,
            r,
            o
          )));
        let l = await Uu(
          s,
          t,
          a.documents.map((e) => e.nodes),
          r
        );
        (B(r), l || h(a, `forms`));
        let p = new Set(a.documents.map((e) => e.frame.frameId));
        for (let e of a.frames) p.has(e.frameId) || h(a, `dom`, e.frameId);
      } catch (e) {
        if ((nd(n, e), B(r), v(e, a))) return;
        if (hi(e)) throw e;
        ((g ??= e), h(a, `dom`), (a.fallbackExcluded = await Fu(s, t, r)));
      }
      if (!_.has(a)) {
        !a.frames.length &&
          !c &&
          (a.frames = [
            { frameId: `root`, target: a.target, ...(!a.target.sessionId && i ? { url: i } : {}) },
          ]);
        try {
          (B(r), await s.send(t, `Accessibility.enable`, {}));
        } catch (e) {
          if ((nd(n, e), B(r), v(e, a))) return;
          if (hi(e)) throw e;
          ((g ??= e), h(a, `ax`));
          return;
        }
        n.set(a.target, e.getAttachmentId?.(t));
      }
    },
    r
  );
  let y = m.flatMap((e) => (n.has(e.target) ? e.frames.map((t) => ({ batch: e, frame: t })) : []));
  await ed(
    y,
    async (i) => {
      let { batch: a, frame: o } = i;
      if (!_.has(a))
        try {
          B(r);
          let n = await $r(e, a.target).send(
            t,
            `Accessibility.getFullAXTree`,
            o.frameId === `root` ? {} : { frameId: o.frameId }
          );
          (B(r), (i.result = { frame: o, nodes: n.nodes ?? [] }));
        } catch (e) {
          if ((nd(n, e), B(r), v(e, a))) return;
          if (hi(e)) throw e;
          ((g ??= e), h(a, `ax`, o.frameId));
        }
    },
    r
  );
  for (let e of y) e.result && e.batch.ax.push(e.result);
  let b = new Map(),
    x = new Set(d);
  for (let e of m) {
    let t = N(e.target);
    for (let n of e.snapshotFrameIds ?? []) {
      let e = b.get(n);
      (e !== void 0 && e !== t && x.add(n), b.set(n, t));
    }
    let n = new Set(e.frames.map((e) => e.frameId));
    for (let t of e.snapshotFrameIds ?? []) n.has(t) || x.add(t);
  }
  let S = m.flatMap((e) =>
      e.frames.filter((t) => !b.has(t.frameId) || b.get(t.frameId) === N(e.target))
    ),
    C = m.find((e) => !e.target.sessionId),
    w = C?.rootFrameId ?? c?.rootFrameId ?? C?.frames[0]?.frameId ?? `root`,
    T = new Set(x),
    E = new Map(),
    D = new Map(S.map((e) => [e.frameId, e])),
    O = m.flatMap((e) => {
      let t = new Map(e.documents.map((e) => [e.frame.frameId, e]));
      return e.frames
        .filter((t) => !x.has(t.frameId) && N(D.get(t.frameId).target) === N(e.target))
        .map((n) => ({ batch: e, frame: n, doc: t.get(n.frameId) }));
    }),
    k = (i = !1) =>
      ed(
        O,
        async ({ batch: a, frame: o, doc: s }) => {
          if ((B(r), _.has(a) || x.has(o.frameId) || (i && !E.has(o.frameId)))) return;
          if (!a.snapshotAttachmentId || s?.documentElementBackendNodeId === void 0) {
            u.push({
              target: o.target,
              frameId: o.frameId,
              stage: `identity`,
              reason: `identity-unverified`,
            });
            return;
          }
          let c = {
              attachmentId: a.snapshotAttachmentId,
              target: o.target,
              frameId: o.frameId,
              documentElementBackendNodeId: s.documentElementBackendNodeId,
            },
            l;
          try {
            l = await ea(e, c, r);
          } catch (e) {
            if ((nd(n, e), B(r), !v(e, a))) throw e;
            for (let e of d) x.add(e);
            return;
          }
          let f = e.getAttachmentId?.(t) === c.attachmentId ? l : `changed`;
          f === `current`
            ? E.set(o.frameId, c)
            : (x.add(o.frameId),
              u.push({
                target: o.target,
                frameId: o.frameId,
                stage: `identity`,
                reason: f === `changed` ? `document-changed` : `identity-unavailable`,
              }));
        },
        r
      );
  await k();
  let A = { width: 0, height: 0 },
    j = !1;
  if (!x.has(w)) {
    try {
      let e = Qi(await l.layoutMetrics({ tabId: t }));
      A = { width: e.width, height: e.height };
    } catch (e) {
      if ((nd(n, e), B(r), e instanceof Rt)) j = !0;
      else if (hi(e)) throw e;
    }
    if (j)
      for (let e of S)
        x.has(e.frameId) ||
          u.push({
            target: e.target,
            frameId: e.frameId,
            stage: `geometry`,
            reason: `geometry-unavailable`,
          });
    else {
      await ed(
        m,
        async (e) => {
          if (!_.has(e))
            try {
              await Qu(
                e.documents,
                e.target,
                e.frames.filter((e) => !x.has(e.frameId)),
                l,
                u,
                r,
                e.rootFrameId,
                o
              );
            } catch (t) {
              if ((nd(n, t), B(r), !v(t, e))) throw t;
            }
        },
        r
      );
      for (let e of d) x.add(e);
      await k(!0);
    }
  }
  for (let [n, r] of E)
    e.getAttachmentId?.(t) !== r.attachmentId &&
      (x.add(n),
      u.push({ target: r.target, frameId: n, stage: `identity`, reason: `document-changed` }));
  let M = new Map();
  for (let e of S) {
    if (!e.parentFrameId) continue;
    let t = M.get(e.parentFrameId);
    t ? t.push(e.frameId) : M.set(e.parentFrameId, [e.frameId]);
  }
  let ee = [...x];
  for (let e = 0; e < ee.length; e++)
    for (let t of M.get(ee[e]) ?? []) x.has(t) || (x.add(t), ee.push(t));
  for (let e of S)
    T.has(e.frameId) &&
      u.push({
        target: e.target,
        frameId: e.frameId,
        stage: `ownership`,
        reason: `frame-ownership-unresolved`,
      });
  if (x.has(w)) throw Error(T.has(w) ? `observation root document ownership is ambiguous` : $u);
  let te = S.filter((e) => !x.has(e.frameId)),
    ne = new Map(te.map((e) => [e.frameId, e])),
    re = (e) => {
      let t = ne.get(e.frameId);
      return t && N(t.target) === N(e.target);
    },
    ie = new Map(
      m
        .flatMap((e) => e.documents)
        .filter((e) => re(e.frame))
        .map((e) => [e.frame.frameId, e])
    ),
    ae = m.flatMap((e) => e.ax).filter((e) => re(e.frame)),
    oe = await qu(
      { rootFrameId: w, frames: te },
      ae,
      {
        nodes: [],
        rootFrameId: w,
        frameNodes: new Map([...ie].map(([e, t]) => [e, t.nodes])),
        frameExcludedBackendNodeIds: new Map(
          [...ie].map(([e, t]) => [e, t.index.excludedBackendNodeIds])
        ),
      },
      r,
      (e) =>
        u.push({
          target: e.target,
          frameId: e.frameId,
          stage: `ownership`,
          reason: `frame-ownership-unresolved`,
        })
    ),
    se = [];
  for (let e of oe) {
    let t = ie.get(e.frameId),
      n = t?.index ?? (await Iu([], r)),
      i = p.get(N(e.target))?.fallbackExcluded,
      { domNodes: a, axNodes: o, contextScopeId: _s, excludedBackendNodeIds: _c, ...l } = e;
    se.push({
      frame: l,
      identity: E.get(e.frameId),
      ...(t?.geometry ? { geometry: t.geometry } : {}),
      index: i?.size ? { ...n, excludedBackendNodeIds: i } : n,
      domNodes: a,
      axNodes: o,
    });
  }
  if ((B(r), g && se.every((e) => !e.domNodes.length && !e.axNodes.length))) throw g;
  return {
    visualFactsCollected: o.includeVisualFacts,
    rootFrameId: w,
    viewport: A,
    documents: se,
    issues: u,
    startedAt: s,
    finishedAt: Date.now(),
  };
}
function ad(e) {
  let t = e.documents.map((e) => ({
      ...e.frame,
      contextScopeId: e.frame.frameId,
      domNodes: e.domNodes.filter((t) => !e.index.excludedBackendNodeIds.has(t.backendNodeId)),
      axNodes: e.axNodes,
      excludedBackendNodeIds: e.index.excludedBackendNodeIds,
    })),
    n = t.find((t) => t.frameId === e.rootFrameId);
  return {
    documents: t,
    captured: {
      nodes: n?.domNodes ?? [],
      viewport: e.viewport,
      rootFrameId: e.rootFrameId,
      excludedBackendNodeIds: n?.excludedBackendNodeIds ?? new Set(),
    },
  };
}
var jd = `data-bctl-record-document`,
  Md = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  Nd = `vom:`;
function Pd(e) {
  let t = e[jd];
  if (!t?.startsWith(Nd)) return;
  let n = t.slice(4);
  return n && Md.test(n) ? n : void 0;
}
function Fd(e) {
  return e.map((e) => {
    let t;
    for (let n of e.domNodes) if (((t = Pd(n.attrs)), t)) break;
    return {
      frameId: e.frameId,
      target: e.target,
      ...(e.parentFrameId ? { parentFrameId: e.parentFrameId } : {}),
      ...(e.ownerBackendNodeId === void 0 ? {} : { ownerBackendNodeId: e.ownerBackendNodeId }),
      ...(t ? { recordingDocumentId: t } : {}),
    };
  });
}
function Id(e) {
  return e.flatMap((e) =>
    e.domNodes.map((t) => ({
      frameId: e.frameId,
      backendNodeId: t.backendNodeId,
      tag: t.tag,
      rect: t.rect,
      ...(t.localRect === void 0 ? {} : { localRect: t.localRect }),
    }))
  );
}
function Ld(e) {
  return {
    text: e.rendered.text,
    refs: e.rendered.refs,
    truncated: e.rendered.truncated,
    rootFrameId: e.rootFrameId,
    frames: Fd(e.frameDocuments),
    matchNodes: Id(e.frameDocuments),
    surfaceProbes: e.surfaceProbes,
    ...(e.hoverProbe ? { hoverProbe: e.hoverProbe } : {}),
  };
}
function Rd(e, t) {
  return JSON.stringify([e, `dom`, t]);
}
function zd(e, t) {
  return JSON.stringify([e, `ax`, t]);
}
function Bd(e) {
  let t =
      e.rootFrameId ??
      e.documents.find((e) => !e.parentFrameId)?.frameId ??
      e.documents[0]?.frameId ??
      `root`,
    n = new Map(),
    r = new Map(),
    i = new Map(),
    a = new Map(),
    o = new Map();
  for (let [s, c] of e.documents.entries()) {
    n.set(c.frameId, {
      frameId: c.frameId,
      ...(c.parentFrameId ? { parentFrameId: c.parentFrameId } : {}),
      ...(c.ownerBackendNodeId === void 0 ? {} : { ownerBackendNodeId: c.ownerBackendNodeId }),
      contextScopeId: c.contextScopeId,
      target: c.target,
      ...(c.url ? { url: c.url } : {}),
      order: s,
    });
    let l = [];
    i.set(c.frameId, l);
    for (let [n, i] of c.domNodes.entries()) {
      let o = Rd(c.frameId, i.backendNodeId),
        s = {
          id: o,
          frameId: c.frameId,
          backendNodeId: i.backendNodeId,
          dom: i,
          sourceOrder: n,
          excluded:
            c.excludedBackendNodeIds?.has(i.backendNodeId) === !0 ||
            (c.frameId === t && e.excludedBackendNodeIds?.has(i.backendNodeId) === !0),
        };
      (r.set(o, s), l.push(o), a.set(Nl(c.frameId, i.backendNodeId), o));
    }
    for (let [n, i] of c.axNodes.entries()) {
      let s =
          (typeof i.backendDOMNodeId == `number`
            ? a.get(Nl(c.frameId, i.backendDOMNodeId))
            : void 0) ?? zd(c.frameId, i.nodeId),
        u = r.get(s);
      (u
        ? ((u.ax = i), (u.axNodeId = i.nodeId))
        : (r.set(s, {
            id: s,
            frameId: c.frameId,
            ...(typeof i.backendDOMNodeId == `number` ? { backendNodeId: i.backendDOMNodeId } : {}),
            axNodeId: i.nodeId,
            ax: i,
            sourceOrder: c.domNodes.length + n,
            excluded:
              typeof i.backendDOMNodeId == `number` &&
              (c.excludedBackendNodeIds?.has(i.backendDOMNodeId) === !0 ||
                (c.frameId === t && e.excludedBackendNodeIds?.has(i.backendDOMNodeId) === !0)),
          }),
          l.push(s)),
        o.set(Pl(c.frameId, i.nodeId), s));
    }
  }
  for (let t of e.documents) {
    for (let e of t.domNodes) {
      let n = a.get(Nl(t.frameId, e.backendNodeId)),
        i = n ? r.get(n) : void 0;
      !i ||
        e.parentBackendNodeId === null ||
        (i.domParentId = a.get(Nl(t.frameId, e.parentBackendNodeId)));
    }
    for (let e of t.axNodes) {
      let n = o.get(Pl(t.frameId, e.nodeId)),
        i = n ? r.get(n) : void 0;
      !i || !e.parentId || (i.axParentId = o.get(Pl(t.frameId, e.parentId)));
    }
  }
  let s = new Map(),
    c = [];
  for (let e of r.values()) {
    if (e.axParentId) {
      let t = s.get(e.axParentId) ?? [];
      (t.push(e.id), s.set(e.axParentId, t));
    }
    e.excluded && c.push(e.id);
  }
  for (let e = 0; e < c.length; e += 1)
    for (let t of s.get(c[e]) ?? []) {
      let e = r.get(t);
      !e || e.excluded || ((e.excluded = !0), c.push(t));
    }
  for (let e of n.values())
    !e.parentFrameId ||
      e.ownerBackendNodeId === void 0 ||
      (e.ownerNodeId = a.get(Nl(e.parentFrameId, e.ownerBackendNodeId)));
  return {
    viewport: e.viewport,
    rootFrameId: t,
    frames: n,
    nodes: r,
    nodeIdsByFrame: i,
    nodeByFrameBackend: a,
  };
}
function Vd(e) {
  return e.structure.kind === `keep` || e.structure.kind === `inferred-group`;
}
function Hd(e) {
  let t = new Set([e.rootFrameId]),
    n = new Map();
  for (let t of e.frames.values()) {
    if (!t.parentFrameId) continue;
    let e = n.get(t.parentFrameId) ?? [];
    (e.push(t.frameId), n.set(t.parentFrameId, e));
  }
  let r = [e.rootFrameId];
  for (let i = 0; i < r.length; i += 1)
    for (let a of n.get(r[i]) ?? []) {
      if (t.has(a)) continue;
      let n = e.frames.get(a);
      if (!n?.ownerNodeId) continue;
      let i = e.nodes.get(n.ownerNodeId);
      !i || !Vd(i) || (t.add(n.frameId), r.push(n.frameId));
    }
  return t;
}
function Ud(e, t, n) {
  let r = [],
    i = new Set(),
    a = t.domParentId;
  for (; a && !i.has(a);) {
    i.add(a);
    let t = n.get(a);
    (t !== void 0 && r.push(t), (a = e.nodes.get(a)?.domParentId));
  }
  return r;
}
function Wd(e) {
  let t = Hd(e),
    n = [...e.frames.values()]
      .filter((e) => t.has(e.frameId))
      .sort((e, t) => e.order - t.order)
      .flatMap((t) =>
        (e.nodeIdsByFrame.get(t.frameId) ?? [])
          .map((t) => e.nodes.get(t))
          .filter((e) => e !== void 0 && Vd(e))
          .sort((e, t) => e.sourceOrder - t.sourceOrder)
      ),
    r = new Map();
  n.forEach((e, t) => r.set(e.id, t + 1));
  for (let t of e.nodes.keys()) r.has(t) || r.set(t, r.size + 1);
  let i = n.map((t) => ({
    ...t.vom,
    id: r.get(t.id),
    parentId: t.semanticParentId ? (r.get(t.semanticParentId) ?? null) : null,
    ...(t.backendNodeId === void 0 ? {} : { backendNodeId: t.backendNodeId }),
    frameId: t.frameId,
    contextScopeId: e.frames.get(t.frameId)?.contextScopeId ?? t.frameId,
    referenceable: t.referenceable,
    ...(t.dom
      ? {
          domParentId: t.domParentId === void 0 ? null : (r.get(t.domParentId) ?? null),
          domAncestorIds: Ud(e, t, r),
        }
      : {}),
  }));
  return { viewport: e.viewport, nodes: i, rootFrameId: e.rootFrameId };
}
var Gd = new Set([`input`, `textarea`, `select`]),
  Kd = new Set([`button`, `input`, `select`, `textarea`]),
  qd = new Set([`statictext`, `inlinetextbox`, `labeltext`, `text`]),
  Jd = new Set([
    `button`,
    `checkbox`,
    `combobox`,
    `link`,
    `listbox`,
    `menuitem`,
    `menuitemcheckbox`,
    `menuitemradio`,
    `option`,
    `radio`,
    `searchbox`,
    `slider`,
    `spinbutton`,
    `switch`,
    `tab`,
    `textbox`,
    `treeitem`,
  ]),
  Yd = new Set([`password`, `credit-card`, `one-time-code`, `current-password`, `new-password`]);
function Xd(e) {
  return e?.replace(/\s+/g, ` `).trim() || void 0;
}
function Zd(e) {
  return e?.value === void 0 ? void 0 : Xd(String(e.value));
}
function Qd(e, t) {
  return Zd(e?.properties?.find((e) => e.name === t)?.value);
}
function $d(e) {
  return Xd(e)?.toLowerCase() || void 0;
}
function ef(e, t) {
  if (e === `button`) return `button`;
  if (e === `textarea`) return `textbox`;
  if (e === `select`) return t.multiple === void 0 ? `combobox` : `listbox`;
  if (e === `a` && t.href) return `link`;
  if (e === `iframe`) return `Iframe`;
  if (e === `dialog`) return `dialog`;
  if (e === `img`) return `img`;
  if (e === `table`) return `table`;
  if (e === `tr`) return `row`;
  if (e === `th`) return `columnheader`;
  if (e === `td`) return `cell`;
  if (e === `ul` || e === `ol`) return `list`;
  if (e === `li`) return `listitem`;
  if (/^h[1-6]$/.test(e)) return `heading`;
  if (e === `nav`) return `navigation`;
  if (e === `main`) return `main`;
  if (e === `form`) return `form`;
  if (e === `input`) {
    let e = (t.type ?? `text`).toLowerCase();
    return e === `hidden`
      ? void 0
      : e === `checkbox`
        ? `checkbox`
        : e === `radio`
          ? `radio`
          : e === `range`
            ? `slider`
            : e === `number`
              ? `spinbutton`
              : e === `search`
                ? `searchbox`
                : [`button`, `submit`, `reset`, `image`].includes(e)
                  ? `button`
                  : `textbox`;
  }
}
function tf(e, t) {
  return $d(t.role) ?? ef(e, t);
}
function nf(e) {
  let t = Xd(Zd(e.ax?.role)),
    n = $d(t),
    r = e.dom?.attrs ?? {},
    i = $d(r.role),
    a = ef(e.dom?.tag.toLowerCase() ?? ``, r),
    o = e.ax?.ignored !== !0;
  return o && n && ![`generic`, `none`, `presentation`].includes(n)
    ? { value: t, source: `ax` }
    : i
      ? { value: i, source: `dom-explicit` }
      : a
        ? { value: a, source: `dom-native` }
        : t
          ? { value: t, source: o ? `ax` : `ax-ignored` }
          : { source: `none` };
}
function rf(e) {
  let t = e.dom?.attrs ?? {};
  return (
    (t.type ?? ``).toLowerCase() === `password` ||
    Object.prototype.hasOwnProperty.call(t, `data-bctl-record-password`) ||
    aa(t.autocomplete) ||
    Yd.has(Qd(e.ax, `inputType`) ?? ``)
  );
}
function af(e, t, n, r) {
  if (e.dom?.formState) return r && e.dom.formState === `default` ? `filled` : e.dom.formState;
  let i = e.dom?.tag.toLowerCase() ?? ``;
  if (!(!Gd.has(i) && ![`textbox`, `searchbox`].includes(t ?? ``)))
    return r || e.dom?.formValue === void 0
      ? n
        ? `filled`
        : `empty`
      : e.dom.formValue === ``
        ? `empty`
        : e.dom.formValue === (e.dom.formDefaultValue ?? ``)
          ? `default`
          : `filled`;
}
function of(e, t) {
  if (
    ![`checkbox`, `radio`, `switch`, `menuitemcheckbox`, `menuitemradio`].includes(
      t?.toLowerCase() ?? ``
    )
  )
    return;
  let n = e.ax?.ignored === !0 ? void 0 : Qd(e.ax, `checked`);
  if (n === `true` || n === `false`) return n === `true`;
  if (n === `mixed`) return `mixed`;
  if (e.dom?.checked !== void 0) return e.dom.checked;
  let r = e.dom?.attrs[`aria-checked`];
  return r === `true` || r === `false` ? r === `true` : r === `mixed` ? `mixed` : void 0;
}
function sf(e, t) {
  if (!(!e || !t))
    try {
      let n = new URL(t),
        r = new URL(e, n);
      return r.origin === n.origin ? void 0 : r.hostname;
    } catch {
      return;
    }
}
function cf(e) {
  let t = new Map(),
    n = new Map(),
    r = new Map(),
    i = new Map(),
    a = new Map(),
    o = new Map();
  for (let i of e.nodes.values()) {
    if (i.domParentId) {
      let e = t.get(i.domParentId) ?? [];
      (r.set(i.id, e.length), e.push(i.id), t.set(i.domParentId, e));
    }
    if (i.axParentId) {
      let e = n.get(i.axParentId) ?? [];
      (e.push(i.id), n.set(i.axParentId, e));
    }
    let e = Xd(i.dom?.attrs.id);
    e && a.set(`${i.frameId}\u0000${e}`, i.id);
    let s = Xd(i.dom?.attrs.for);
    if (i.dom?.tag.toLowerCase() === `label` && s) {
      let e = `${i.frameId}\u0000${s}`,
        t = o.get(e) ?? [];
      (t.push(i.id), o.set(e, t));
    }
  }
  for (let [t, r] of n) {
    let n = e.nodes.get(t)?.ax?.childIds ?? [],
      a = new Map(n.map((e, t) => [e, t]));
    r.sort((t, n) => {
      let r = a.get(e.nodes.get(t)?.axNodeId ?? ``) ?? -1,
        i = a.get(e.nodes.get(n)?.axNodeId ?? ``) ?? -1;
      return (r < 0 ? 2 ** 53 - 1 : r) - (i < 0 ? 2 ** 53 - 1 : i);
    });
    for (let e = 0; e < r.length; e += 1) i.set(r[e], e);
  }
  let s = new Map(),
    c = new Set(),
    l = (n) => {
      if (s.has(n)) return s.get(n);
      if (c.has(n)) return;
      c.add(n);
      let r = e.nodes.get(n),
        i = [],
        a = Xd(r?.dom?.textContent);
      a && i.push(a);
      for (let r of t.get(n) ?? []) {
        let t = e.nodes.get(r),
          n = t ? tf(t.dom?.tag.toLowerCase() ?? ``, t.dom?.attrs ?? {}) : void 0;
        if (n && Jd.has(n.toLowerCase())) continue;
        let a = l(r);
        if ((a && i.push(a), i.join(` `).length >= 240)) break;
      }
      c.delete(n);
      let o = Xd(i.join(` `).slice(0, 240));
      return (s.set(n, o), o);
    },
    u = new Map(),
    d = new Set(),
    f = (t) => {
      if (u.has(t)) return u.get(t);
      if (d.has(t)) return;
      d.add(t);
      let r = (e) => (d.delete(t), u.set(t, e), e),
        i = e.nodes.get(t),
        a = $d(Zd(i?.ax?.role)) ?? ``;
      if (qd.has(a)) {
        let e = Xd(Zd(i?.ax?.name) ?? Zd(i?.ax?.value));
        if (e) return r(e);
      }
      let o = [];
      for (let r of n.get(t) ?? []) {
        let t = $d(Zd(e.nodes.get(r)?.ax?.role)) ?? ``;
        if (Jd.has(t)) continue;
        let n = f(r);
        if ((n && o.push(n), o.join(` `).length >= 240)) break;
      }
      return r(Xd(o.join(` `).slice(0, 240)));
    },
    p = new Map(),
    m = (n) => {
      let r = p.get(n);
      if (r !== void 0) return r;
      p.set(n, !1);
      for (let r of t.get(n) ?? []) {
        let t = e.nodes.get(r),
          i =
            (t?.ax?.ignored === !0 ? void 0 : $d(Zd(t?.ax?.role))) ??
            (t ? tf(t.dom?.tag.toLowerCase() ?? ``, t.dom?.attrs ?? {}) : void 0);
        if ((t?.dom && Kd.has(t.dom.tag.toLowerCase())) || Jd.has(i ?? ``) || m(r))
          return (p.set(n, !0), !0);
      }
      return !1;
    };
  return {
    domChildren: t,
    axChildren: n,
    domSiblingIndex: r,
    axSiblingIndex: i,
    domIdIndex: a,
    labelForIndex: o,
    domText: l,
    axText: f,
    hasNativeDescendant: m,
  };
}
function lf(e, t) {
  return Xd(
    (e.dom?.attrs[`aria-labelledby`] ?? ``)
      .split(/\s+/)
      .filter(Boolean)
      .flatMap((n) => {
        let r = t.domIdIndex.get(`${e.frameId}\u0000${n}`);
        return r ? (t.domText(r) ?? []) : [];
      })
      .join(` `)
  );
}
function uf(e, t, n) {
  let r = Xd(e.dom?.attrs.id);
  if (r) {
    let t = Xd(
      (n.labelForIndex.get(`${e.frameId}\u0000${r}`) ?? [])
        .map((e) => n.domText(e))
        .filter(Boolean)
        .join(` `)
    );
    if (t) return t;
  }
  let i = e.domParentId,
    a = 0;
  for (; i && a <= t.nodes.size;) {
    let e = t.nodes.get(i);
    if (!e) break;
    if (e.dom?.tag.toLowerCase() === `label`) return n.domText(i);
    ((i = e.domParentId), (a += 1));
  }
}
function df(e, t, n) {
  if (!e.axParentId) return;
  let r = n.axChildren.get(e.axParentId) ?? [],
    i = n.axSiblingIndex.get(e.id) ?? -1;
  for (let e = 1; e <= 4 && i - e >= 0; e += 1) {
    let n = t.nodes.get(r[i - e]),
      a = $d(Zd(n?.ax?.role)) ?? ``;
    if (Jd.has(a)) break;
    if (!qd.has(a) && a !== `generic`) continue;
    let o = Xd(Zd(n?.ax?.name) ?? Zd(n?.ax?.value))?.replace(/[：:]\s*$/, ``);
    if (o && o.length <= 80) return o;
  }
}
function ff(e, t, n) {
  if (!e.domParentId) return;
  let r = n.domChildren.get(e.domParentId) ?? [],
    i = n.domSiblingIndex.get(e.id) ?? -1;
  for (let e = 1; e <= 4 && i - e >= 0; e += 1) {
    let a = t.nodes.get(r[i - e]),
      o = a ? tf(a.dom?.tag.toLowerCase() ?? ``, a.dom?.attrs ?? {}) : void 0;
    if (o && Jd.has(o.toLowerCase())) break;
    let s = n.domText(r[i - e])?.replace(/[：:]\s*$/, ``);
    if (s && s.length <= 80) return s;
  }
}
function pf(e, t, n, r, i, a) {
  let o = e.dom?.attrs ?? {},
    s = Gd.has(e.dom?.tag.toLowerCase() ?? ``),
    c = r.domText(e.id),
    l = Jd.has(t?.toLowerCase() ?? ``) || Kd.has(e.dom?.tag.toLowerCase() ?? ``),
    u = [
      e.ax?.ignored === !0 ? void 0 : Zd(e.ax?.name),
      lf(e, r),
      Xd(o[`aria-label`]),
      uf(e, n, r),
      Xd(o.title),
      Xd(o.alt),
      e.ax?.ignored === !0 ? void 0 : r.axText(e.id),
      c,
      s ? df(e, n, r) : void 0,
      s ? ff(e, n, r) : void 0,
      s ? Xd(e.dom?.formPlaceholder ?? o.placeholder) : void 0,
      s || !l || e.backendNodeId === void 0 ? void 0 : Xd(i.get(Nl(e.frameId, e.backendNodeId))),
      a && l ? dd(o) : void 0,
    ].find((e) => e !== void 0),
    d = Qd(e.ax, `hasPopup`);
  return (
    u &&
      d &&
      d !== `false` &&
      (u = Qd(e.ax, `expanded`) === `true` ? `${u} [expanded]` : `${u} [has-submenu]`),
    !u && t?.toLowerCase() === `iframe` ? Xd(o.id) : u
  );
}
function mf(e, t) {
  let n = e.domParentId,
    r = 0;
  for (; n && r <= t.nodes.size;) {
    let e = t.nodes.get(n);
    if (!e) break;
    if (e.dom && Kd.has(e.dom.tag.toLowerCase())) return !0;
    ((n = e.domParentId), (r += 1));
  }
  return !1;
}
function hf(e, t, n) {
  if (!e.domParentId) return;
  let r = n.domChildren.get(e.domParentId) ?? [],
    i = n.domSiblingIndex.get(e.id) ?? -1;
  if (!(i < 0))
    return Xd(
      r
        .slice(Math.max(0, i - 3), i + 4)
        .filter((t) => t !== e.id)
        .flatMap((e) => n.domText(e) ?? [])
        .slice(0, 3)
        .join(` `)
    );
}
function gf(e, t = {}) {
  let n = cf(e),
    r = t.supplementalNames ?? new Map(),
    i = t.identifierFallback ?? !0,
    a = new Map();
  for (let t of e.nodes.values()) {
    let o = nf(t),
      s = o.value,
      c = pf(t, s, e, n, r, i),
      l = rf(t),
      u = t.dom?.formValue ?? Zd(t.ax?.value),
      d = l ? void 0 : u,
      f = of(t, s),
      p = { ...(t.dom?.attrs ?? {}) };
    (l && delete p.value, delete p[ia]);
    let m = e.frames.get(t.frameId),
      h = t.dom?.tag.toLowerCase() ?? ``,
      g = t.dom?.inForm,
      _ = hf(t, e, n),
      v = {
        tag: h,
        rect: t.dom?.rect ?? null,
        paintOrder: t.dom?.paintOrder ?? 0,
        position: t.dom?.position || `static`,
        pointerEvents: t.dom?.pointerEvents || `auto`,
        ...(t.dom?.cursor ? { cursor: t.dom.cursor } : {}),
        ...(t.dom?.clickable ? { clickable: !0 } : {}),
        ...(s ? { role: s } : {}),
        ...(c ? { name: c } : {}),
        ...(d === void 0 ? {} : { value: d }),
        ...(g === void 0 ? {} : { inForm: g }),
        ...(f === void 0 ? {} : { checked: f }),
        ...(t.ax?.ignored !== !0 && Qd(t.ax, `focused`) === `true` ? { focused: !0 } : {}),
        ...(Xd(t.dom?.formPlaceholder ?? p.placeholder)
          ? { placeholder: Xd(t.dom?.formPlaceholder ?? p.placeholder) }
          : {}),
        attrs: p,
        ...(Xd(t.dom?.textContent) ? { text: Xd(t.dom?.textContent) } : {}),
        ...(_ ? { nearbyText: _ } : {}),
        inputState: af(t, s, u, l),
        sensitive: l,
        modal: t.ax
          ? t.ax.ignored !== !0 && Qd(t.ax, `modal`) === `true`
          : (p[`aria-modal`] ?? ``).toLowerCase() === `true`,
        disabled:
          (t.ax?.ignored !== !0 && Qd(t.ax, `disabled`) === `true`) ||
          Object.prototype.hasOwnProperty.call(p, `disabled`) ||
          (p[`aria-disabled`] ?? ``).toLowerCase() === `true`,
        inert: Object.prototype.hasOwnProperty.call(p, `inert`),
        hasNativeDescendant: n.hasNativeDescendant(t.id),
        insideNative: mf(t, e),
        ...(s?.toLowerCase() === `link` ? { href: sf(p.href, m?.url) } : {}),
      },
      y = t.ax?.ignored === !0 ? void 0 : Qd(t.ax, `selected`),
      b = t.ax?.ignored === !0 ? void 0 : Qd(t.ax, `expanded`),
      x = t.ax?.ignored === !0 ? void 0 : Qd(t.ax, `controls`);
    ((y === `true` || y === `false`) &&
      !v.attrs?.[`aria-selected`] &&
      (v.attrs = { ...(v.attrs ?? {}), "aria-selected": y }),
      b === `true` &&
        !v.attrs?.[`aria-expanded`] &&
        (v.attrs = { ...(v.attrs ?? {}), "aria-expanded": `true` }),
      x && !v.attrs?.[`aria-controls`] && (v.attrs = { ...(v.attrs ?? {}), "aria-controls": x }),
      a.set(t.id, {
        ...t,
        vom: v,
        referenceable: t.backendNodeId !== void 0,
        roleSource: o.source,
      }));
  }
  return { ...e, nodes: a };
}
var _f = new Set([``, `generic`, `none`, `presentation`, `inlinetextbox`]),
  vf = new Set([`rootwebarea`, `webarea`]),
  yf = new Set([
    `article`,
    `dialog`,
    `document`,
    `feed`,
    `form`,
    `grid`,
    `heading`,
    `iframe`,
    `list`,
    `main`,
    `navigation`,
    `paragraph`,
    `region`,
    `section`,
    `table`,
    `tree`,
  ]);
function bf(e) {
  let t = e.vom.attrs ?? {};
  return [`aria-controls`, `aria-labelledby`, `aria-owns`, `aria-describedby`].some((e) =>
    t[e]?.trim()
  );
}
function xf(e) {
  return ec(e.vom.role) && e.roleSource !== `none` && e.roleSource !== `ax-ignored`;
}
function Sf(e) {
  return e.ax !== void 0 && e.ax.ignored !== !0;
}
function Cf(e, t) {
  let n = new Set();
  for (let t of e) {
    let e = t.dom?.attrs ?? {};
    (Object.prototype.hasOwnProperty.call(e, `hidden`) ||
      Object.prototype.hasOwnProperty.call(e, `inert`) ||
      (e[`aria-hidden`] ?? ``).toLowerCase() === `true`) &&
      n.add(t.id);
  }
  let r = [...n];
  for (let e = 0; e < r.length; e++)
    for (let i of t.get(r[e]) ?? []) n.has(i) || (n.add(i), r.push(i));
  return n;
}
function wf(e, t) {
  return !e.dom || t.has(e.id)
    ? !1
    : (e.dom.rendered ?? (e.dom.localRect != null || e.dom.rect != null));
}
function Tf(e, t) {
  let n = t.axParentId ?? t.domParentId;
  if (t.axParentId && t.domParentId && t.axParentId !== t.domParentId) {
    let r = e.nodes.get(t.axParentId),
      i = r?.vom.role?.toLowerCase() ?? ``;
    n =
      r !== void 0 && !vf.has(i) && (xf(r) || !_f.has(i) || r.vom.name || r.vom.text || bf(r))
        ? t.axParentId
        : t.domParentId;
  }
  if (n) return n;
  if (t.frameId !== e.rootFrameId) return e.frames.get(t.frameId)?.ownerNodeId;
}
function Ef(e) {
  return [...e.frames.values()]
    .sort((e, t) => e.order - t.order)
    .flatMap((t) =>
      (e.nodeIdsByFrame.get(t.frameId) ?? [])
        .map((t) => e.nodes.get(t))
        .filter((e) => e !== void 0)
        .sort((e, t) => e.sourceOrder - t.sourceOrder)
    );
}
function Df(e, t) {
  let n = new Map(t.map((e, t) => [e.id, t + 1])),
    r = new Map([...n].map(([e, t]) => [t, e])),
    i = t.map((t) => ({
      ...t.vom,
      id: n.get(t.id),
      parentId: (() => {
        let r = Tf(e, t);
        return r ? (n.get(r) ?? null) : null;
      })(),
      ...(t.backendNodeId === void 0 ? {} : { backendNodeId: t.backendNodeId }),
      frameId: t.frameId,
      contextScopeId: e.frames.get(t.frameId)?.contextScopeId ?? t.frameId,
      referenceable: t.referenceable,
    }));
  return new Map(
    Gc(i).flatMap((e) => {
      let t = r.get(e.id);
      return t ? [[t, e]] : [];
    })
  );
}
function Of(e, t, n) {
  let r = new Map();
  for (let i of t) {
    let t = n.get(i.id),
      a = t.name?.trim().toLowerCase() ?? ``;
    if (!a || !jc({ ...t, referenceable: !0 })) continue;
    let o = `${i.frameId}\u0000${Tf(e, i) ?? ``}\u0000${t.role?.toLowerCase() ?? ``}\u0000${a}\u0000${t.sensitive === !0}`,
      s = r.get(o) ?? [];
    (s.push(i), r.set(o, s));
  }
  let i = new Set();
  for (let e of r.values()) {
    let t = e.filter((e) => e.ax && !e.dom),
      n = e.filter((e) => e.dom && !e.ax);
    e.length === 2 && t.length === 1 && n.length === 1 && i.add(n[0].id);
  }
  return i;
}
function kf(e, t, n, r, i, a) {
  if (t.excluded) return { kind: `excluded`, reason: `excluded` };
  if (i.has(t.id)) return { kind: `excluded`, reason: `redundant-source` };
  if (!Sf(t) && !wf(t, a)) return { kind: `excluded`, reason: `non-rendered-dom-fallback` };
  if (r.has(t.id)) return { kind: `keep`, reason: `frame-owner` };
  if (t.frameId !== e.rootFrameId && vf.has(n.role?.toLowerCase() ?? ``))
    return { kind: `transparent`, reason: `child-document-root` };
  if (t.ax?.ignored === !0 && !t.dom) return { kind: `transparent`, reason: `ax-ignored` };
  let o = n.role?.toLowerCase() ?? ``;
  return !_f.has(o) ||
    jc(n) ||
    n.name ||
    n.text ||
    n.value ||
    n.placeholder ||
    bf(t) ||
    (n.rect && [`fixed`, `sticky`].includes(n.position))
    ? { kind: `keep`, reason: `semantic` }
    : { kind: `transparent`, reason: `wrapper` };
}
function Af(e, t) {
  let n = new Map();
  for (let r of e) {
    let e = r[t];
    if (!e) continue;
    let i = n.get(e) ?? [];
    (i.push(r.id), n.set(e, i));
  }
  return n;
}
function jf(e, t, n) {
  let r = new Set(),
    i = t.filter((e) => !e.domParentId).map((e) => e.id);
  for (let t = 0; t < i.length; t += 1) {
    let a = i[t],
      o = e.nodes.get(a),
      s = o !== void 0 && xf(o) && !vf.has(o.vom.role?.toLowerCase() ?? ``);
    for (let e of n.get(a) ?? []) ((r.has(a) || s) && r.add(e), i.push(e));
  }
  return r;
}
function Mf(e, t, n, r, i) {
  let a = jf(e, t, i),
    o = new Map(t.map((e) => [e.id, i.get(e.id)?.length ?? 0])),
    s = new Map(),
    c = t.filter((e) => (o.get(e.id) ?? 0) === 0).map((e) => e.id);
  for (let t = 0; t < c.length; t += 1) {
    let a = c[t],
      l = e.nodes.get(a),
      u = n.get(a);
    if (!l || !u) continue;
    let d = u.role?.toLowerCase() ?? ``,
      f = r.get(a)?.kind === `excluded`,
      p = f || xf(l) || yf.has(d),
      m = f
        ? { blocked: !0, interactions: 0 }
        : jc(u)
          ? { blocked: !1, interactions: 1 }
          : p
            ? { blocked: !0, interactions: 0 }
            : (i.get(a) ?? []).reduce(
                (e, t) => {
                  let n = s.get(t);
                  return {
                    blocked: e.blocked || !n || n.blocked,
                    interactions: Math.min(2, e.interactions + (n?.interactions ?? 0)),
                  };
                },
                { blocked: !1, interactions: 0 }
              );
    s.set(a, m);
    let h = l.domParentId;
    if (!h) continue;
    let g = (o.get(h) ?? 1) - 1;
    (o.set(h, g), g === 0 && c.push(h));
  }
  let l = new Set();
  for (let e of t) {
    let t = n.get(e.id).role?.toLowerCase() ?? ``;
    if (
      !e.dom ||
      e.dom.tag.toLowerCase() !== `div` ||
      !_f.has(t) ||
      a.has(e.id) ||
      r.get(e.id)?.kind === `excluded` ||
      e.dom.attrs.hidden !== void 0 ||
      (e.dom.attrs[`aria-hidden`] ?? ``).toLowerCase() === `true` ||
      e.dom.attrs.inert !== void 0
    )
      continue;
    let o = (i.get(e.id) ?? []).map((e) => s.get(e)),
      c = o.some((e) => !e || e.blocked),
      u = o.filter((e) => (e?.interactions ?? 0) > 0).length,
      d = o.reduce((e, t) => Math.min(2, e + (t?.interactions ?? 0)), 0);
    !c && u >= 2 && d >= 2 && l.add(e.id);
  }
  return l;
}
function Nf(e, t, n) {
  let r = new Map(e.flatMap((e) => (e.domParentId ? [[e.id, e.domParentId]] : []))),
    i = new Map(e.map((e) => [e.id, n.get(e.id)?.length ?? 0])),
    a = new Set(),
    o = e.filter((e) => (i.get(e.id) ?? 0) === 0).map((e) => e.id),
    s = new Set();
  for (let e = 0; e < o.length; e += 1) {
    let n = o[e];
    t.has(n) && !a.has(n) && s.add(n);
    let c = r.get(n);
    if (!c) continue;
    (t.has(n) || a.has(n)) && a.add(c);
    let l = (i.get(c) ?? 1) - 1;
    (i.set(c, l), l === 0 && o.push(c));
  }
  return s;
}
function Pf(e, t, n, r, i) {
  let a = t,
    o = [],
    s = new Set(),
    c;
  for (; a && !s.has(a);) {
    if (r.has(a)) {
      c = a;
      break;
    }
    if (i.has(a)) {
      c = i.get(a);
      break;
    }
    (s.add(a), o.push(a), (a = e.nodes.get(a)?.[n]));
  }
  for (let e of o) i.set(e, c);
  return c;
}
function Ff(e, t, n, r, i, a) {
  let o = Pf(e, t.axParentId, `axParentId`, n, i),
    s = Pf(e, t.domParentId, `domParentId`, n, a),
    c = o ? e.nodes.get(o) : void 0,
    l = s ? e.nodes.get(s) : void 0,
    u = vf.has(c?.vom.role?.toLowerCase() ?? ``),
    d = c ? xf(c) && !u : !1,
    f = l !== void 0 && (xf(l) || r.get(l.id)?.kind === `inferred-group`);
  if (d) return o;
  if (f) return s;
  if (o && !u) return o;
  if (s) return s;
  if (o) return o;
  if (t.frameId !== e.rootFrameId) return e.frames.get(t.frameId)?.ownerNodeId;
}
function If(e, t) {
  let {
    id: _n,
    parentId: _r,
    backendNodeId: _i,
    frameId: _a2,
    contextScopeId: _o,
    referenceable: _s2,
    ...c
  } = e;
  if (!t) return c;
  let { name: _l2, text: _u2, nearbyText: _d2, ...f } = c;
  return { ...f, role: `group` };
}
function Lf(e) {
  let t = Ef(e),
    n = Df(e, t),
    r = Of(e, t, n),
    i = new Set([...e.frames.values()].flatMap((e) => e.ownerNodeId ?? [])),
    a = Af(t, `domParentId`),
    o = Cf(t, a),
    s = new Map();
  for (let a of t) s.set(a.id, kf(e, a, n.get(a.id), i, r, o));
  let c = Mf(e, t, n, s, a);
  for (let e of Nf(t, c, a))
    s.set(e, { kind: `inferred-group`, reason: `independent-interaction-branches` });
  let l = new Set(
      t
        .filter((e) => {
          let t = s.get(e.id)?.kind;
          return t === `keep` || t === `inferred-group`;
        })
        .map((e) => e.id)
    ),
    u = new Map(),
    d = new Map(),
    f = new Map();
  for (let r of t) {
    let t = s.get(r.id),
      i = t.kind === `inferred-group`;
    f.set(r.id, {
      ...r,
      vom: If(n.get(r.id), i),
      structure: t,
      ...(l.has(r.id) ? { semanticParentId: Ff(e, r, l, s, u, d) } : {}),
    });
  }
  return { ...e, nodes: f };
}
export function Rf(e) {
  return Bd(e);
}
export function zf(e, t = {}) {
  return gf(e, t);
}
export function Bf(e) {
  return Lf(e);
}
export function Vf(e) {
  return Wd(e);
}
function Qf(e) {
  return e?.toLowerCase() ?? ``;
}
function $f(e) {
  return e?.replace(/\s+/g, ` `).trim() || void 0;
}
var ep = 8,
  tp = 40,
  np = 160,
  rp = 8e3,
  ip = new Set([`script`, `style`, `noscript`, `template`]);
function ap(e) {
  let t = new Map();
  for (let n of e) {
    if (n.parentBackendNodeId === null) continue;
    let e = t.get(n.parentBackendNodeId);
    e ? e.push(n) : t.set(n.parentBackendNodeId, [n]);
  }
  return t;
}
function op(e) {
  let t = new Map();
  for (let n of e) t.set(n.backendNodeId, n);
  return { capturedByBackendId: t, childrenByParentId: ap(e) };
}
function sp(e) {
  return $f(e)?.toLowerCase() ?? ``;
}
function cp(e) {
  return (e[`aria-controls`] ?? ``).split(/\s+/).filter(Boolean);
}
function lp(e) {
  let t = e.attrs ?? {};
  return cp(t).length === 0
    ? !1
    : ((Qf(t.role) || up(e)) === `tab` && (t[`aria-selected`] ?? ``).toLowerCase() === `true`) ||
        (t[`aria-expanded`] ?? ``).toLowerCase() === `true`;
}
function up(e) {
  return e.role?.toLowerCase() ?? ``;
}
function dp(e, t, n) {
  let r = [],
    i = new Set(),
    a = sp(t),
    o = [e];
  for (; o.length > 0 && r.length < tp;) {
    let e = o.shift(),
      t = Qf(e.tag);
    if (ip.has(t) || (e.attrs.type ?? ``).toLowerCase() === `password`) continue;
    let s = $f(e.textContent),
      c = sp(s);
    (s && c !== a && !i.has(c) && (i.add(c), r.push(s.length > np ? s.slice(0, np) : s)),
      o.push(...(n.get(e.backendNodeId) ?? [])));
  }
  return r;
}
function fp(e, t) {
  let n = new Map();
  for (let e of t.capturedByBackendId.values()) {
    let t = e.attrs.id;
    t && n.set(t, e);
  }
  let r = [],
    i = 0;
  for (let a of e) {
    if (r.length >= ep) break;
    if (!lp(a)) continue;
    let e = $f(a.name) ?? $f(a.text) ?? $f(a.attrs?.[`aria-label`]);
    if (!e) continue;
    let o = [];
    for (let r of cp(a.attrs ?? {})) {
      let i = n.get(r);
      if (i && (o.push(...dp(i, e, t.childrenByParentId)), o.length >= tp)) break;
    }
    let s = [],
      c = new Set();
    for (let e of o) {
      let t = sp(e);
      if (!(!t || c.has(t)) && (c.add(t), s.push(e), (i += e.length), s.length >= tp || i >= rp))
        break;
    }
    if (s.length !== 0 && (r.push({ triggerId: a.id, label: e, lines: s }), i >= rp)) break;
  }
  return r;
}

function Ka(tag, attrNames) {
  const lower = String(tag || "").toLowerCase();
  if (lower === "browserctl-overlay" || lower === "browser-skill-overlay") return true;
  if (!attrNames) return false;
  for (const attr of attrNames) {
    const a = String(attr).toLowerCase();
    if (a === "data-bctl-overlay" || a === "data-browserctl-overlay" || a === "data-bsk-overlay") return true;
  }
  return false;
}

async function Fu() {
  return new Set();
}

function _p(scene, frameDocuments, captured) {
  const rootDom =
    frameDocuments.find((d) => d.frameId === scene.rootFrameId)?.domNodes ?? captured.nodes;
  const domIndex = op(rootDom);
  const scopeBlocks = fp(scene.nodes, domIndex);
  return {
    ...scene,
    ...(scopeBlocks.length > 0 ? { activeScopeBlocks: scopeBlocks } : {}),
  };
}

var attachmentIds = new Map();
var frameDiscovery = new Map();
var readGate = new Bt();

function frameDiscoveryState(tabId) {
  let state = frameDiscovery.get(tabId);
  if (!state) {
    state = {
      sessions: new Set(),
      pending: new Set(),
      generation: 0,
      enabled: new Map(),
      frameIds: new Map(),
    };
    frameDiscovery.set(tabId, state);
  }
  return state;
}

function sendDebuggerCommand(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === "undefined" || !chrome.debugger?.sendCommand) {
      return reject(new Error("chrome.debugger API is not available"));
    }
    const debuggee = target.sessionId
      ? { tabId: target.tabId, sessionId: target.sessionId }
      : { tabId: target.tabId };
    chrome.debugger.sendCommand(debuggee, method, params, (res) => {
      const lastErr = chrome.runtime?.lastError;
      if (lastErr) return reject(new Error(lastErr.message));
      resolve(res || {});
    });
  });
}

function enableFrameDiscovery(target) {
  const state = frameDiscoveryState(target.tabId);
  const key = target.sessionId ?? "root";
  const existing = state.enabled.get(key);
  if (existing) return existing;
  let dispatched = false;
  const p = readGate
    .run(target, "Target.setAutoAttach", () => {
      dispatched = true;
      return sendDebuggerCommand(target, "Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [{ type: "iframe", exclude: false }],
      }).then(
        () => {
          if (state.enabled.get(key) === p) state.enabled.set(key, Promise.resolve());
        },
        (err) => {
          if (state.enabled.get(key) === p) state.enabled.delete(key);
          throw err;
        }
      );
    })
    .catch((err) => {
      if ((!dispatched || !(err instanceof Rt)) && state.enabled.get(key) === p) {
        state.enabled.delete(key);
      }
      throw err;
    });
  state.enabled.set(key, p);
  return p;
}

async function initializeFrameTarget(target) {
  try {
    await enableFrameDiscovery(target);
  } catch (err) {
    if (err instanceof Rt) return;
    const state = frameDiscovery.get(target.tabId);
    if (state?.sessions.delete(target.sessionId)) state.generation += 1;
    noteSwallowed("snapshot.initializeFrameTarget", err);
  }
}

function retryChildFrameDiscovery(tabId) {
  const state = frameDiscovery.get(tabId);
  if (!state) return;
  for (const sessionId of state.sessions) {
    if (state.enabled.has(sessionId)) continue;
    const p = initializeFrameTarget({ tabId, sessionId });
    state.pending.add(p);
    p.finally(() => state.pending.delete(p));
  }
}

async function drainFrameAttachTasks(tabId) {
  const deadline = Date.now() + nn;
  while (Date.now() < deadline) {
    const state = frameDiscovery.get(tabId);
    const gen = state?.generation ?? 0;
    if (state?.pending.size && !(await an([...state.pending], deadline))) break;
    const step = Math.min(rn, deadline - Date.now());
    if (step <= 0) break;
    await new Promise((r) => setTimeout(r, step));
    const after = frameDiscovery.get(tabId);
    if (after === state && (after?.generation ?? 0) === gen && !after?.pending.size) return;
  }
}

export function dropVomTabState(tabId) {
  attachmentIds.delete(tabId);
  frameDiscovery.delete(tabId);
  readGate.reset(tabId);
}

if (typeof chrome !== "undefined" && chrome.debugger?.onEvent?.addListener) {
  chrome.debugger.onEvent.addListener((source, method, params = {}) => {
    const tabId = source?.tabId;
    if (typeof tabId !== "number" || !isAttached(tabId)) return;
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
    if (!sessionId) return;
    if (method === "Target.detachedFromTarget") {
      const state = frameDiscovery.get(tabId);
      state?.enabled.delete(sessionId);
      state?.frameIds.delete(sessionId);
      readGate.reset(tabId, sessionId);
      if (state?.sessions.delete(sessionId)) state.generation += 1;
      return;
    }
    if (method !== "Target.attachedToTarget") return;
    const info = params.targetInfo;
    if (info?.type && info.type !== "iframe") return;
    const state = frameDiscoveryState(tabId);
    if (info?.type === "iframe" && typeof info.targetId === "string") {
      state.frameIds.set(sessionId, info.targetId);
    }
    if (state.sessions.has(sessionId)) return;
    state.sessions.add(sessionId);
    state.generation += 1;
    const init = initializeFrameTarget({ tabId, sessionId });
    state.pending.add(init);
    init.finally(() => state.pending.delete(init));
  });
}

if (typeof chrome !== "undefined" && chrome.debugger?.onDetach?.addListener) {
  chrome.debugger.onDetach.addListener((source) => {
    if (source?.tabId != null) dropVomTabState(source.tabId);
  });
}

const vomCdpBridge = {
  getAttachmentId(tabId) {
    if (!isAttached(tabId)) {
      attachmentIds.delete(tabId);
      return undefined;
    }
    if (!attachmentIds.has(tabId)) attachmentIds.set(tabId, makeUuid());
    return attachmentIds.get(tabId);
  },
  async ensureTabReady(tabId) {
    const wasAttached = isAttached(tabId);
    await ensureAttached(tabId);
    if (!attachmentIds.has(tabId) || !wasAttached) {
      attachmentIds.set(tabId, makeUuid());
    }
  },
  async send(tabId, method, params = {}) {
    await this.ensureTabReady(tabId);
    try {
      return await readGate.run({ tabId }, method, () =>
        sendDebuggerCommand({ tabId }, method, params)
      );
    } catch (err) {
      throw On(err);
    }
  },
  async sendToTarget(target, method, params = {}, timeoutMs) {
    await this.ensureTabReady(target.tabId);
    try {
      return await readGate.run(
        target,
        method,
        () => sendDebuggerCommand(target, method, params),
        timeoutMs
      );
    } catch (err) {
      throw On(err);
    }
  },
  async sendGuarded(target, method, params = {}, opts = {}) {
    if (opts.signal?.aborted) throw fi();
    if (opts.attachmentId === undefined) await this.ensureTabReady(target.tabId);
    try {
      return await readGate.run(
        target,
        method,
        () => {
          if (opts.signal?.aborted) throw fi();
          if (
            opts.attachmentId !== undefined &&
            this.getAttachmentId(target.tabId) !== opts.attachmentId
          ) {
            throw new Error("Debugger attachment changed before dispatch");
          }
          return sendDebuggerCommand(target, method, params);
        },
        undefined,
        opts.signal
      );
    } catch (err) {
      throw On(err);
    }
  },
  async getFrameGraph(tabId, signal) {
    if (signal?.aborted) throw fi();
    await this.ensureTabReady(tabId);
    const attId = this.getAttachmentId(tabId);
    const checkAtt = () => {
      if (signal?.aborted) throw fi();
      if (attId === undefined || this.getAttachmentId(tabId) !== attId) {
        const err = new Error("Debugger attachment changed during frame discovery");
        err.name = "CdpAttachmentChangedError";
        throw err;
      }
    };
    const runFrameCmd = async (target, method, params, timeoutMs) => {
      checkAtt();
      try {
        const out = await readGate.run(
          target,
          method,
          () => sendDebuggerCommand(target, method, params),
          timeoutMs
        );
        checkAtt();
        return out;
      } catch (err) {
        checkAtt();
        throw err;
      }
    };
    checkAtt();
    await enableFrameDiscovery({ tabId }).catch(swallow("snapshot.enableFrameDiscovery"));
    checkAtt();
    retryChildFrameDiscovery(tabId);
    await drainFrameAttachTasks(tabId);
    checkAtt();

    const trees = [];
    const failedFrames = new Map();
    const recordFailure = (err, target) => {
      checkAtt();
      if (!(err instanceof Rt)) return;
      const frameId = target.sessionId && frameDiscovery.get(tabId)?.frameIds.get(target.sessionId);
      if (!frameId || frameId === trees[0]?.tree.frame.id || err.sessionId !== target.sessionId) {
        throw err;
      }
      failedFrames.set(frameId, target);
    };

    const mainTree = await runFrameCmd({ tabId }, "Page.getFrameTree", {}, At);
    if (mainTree.frameTree) trees.push({ target: { tabId }, tree: mainTree.frameTree });

    const childSessions = [...(frameDiscovery.get(tabId)?.sessions ?? [])];
    const childTrees = await Promise.all(
      childSessions.map(async (sessionId) => {
        const target = { tabId, sessionId };
        try {
          const res = await runFrameCmd(target, "Page.getFrameTree", {}, At);
          if (res.frameTree) {
            frameDiscovery.get(tabId)?.frameIds.set(sessionId, res.frameTree.frame.id);
            return { target, tree: res.frameTree };
          }
          return null;
        } catch (err) {
          recordFailure(err, target);
          return null;
        }
      })
    );
    for (const ct of childTrees) if (ct) trees.push(ct);

    const rootGraph = Kt(trees);
    if (!rootGraph) throw new Error("Page.getFrameTree returned no root frame");
    const pruned = Ut(rootGraph, failedFrames);
    const byId = new Map(pruned.frames.map((f) => [f.frameId, f]));
    await Promise.all(
      pruned.frames.map(async (f) => {
        if (!f.parentFrameId) return;
        const parent = byId.get(f.parentFrameId);
        if (!parent) return;
        try {
          const owner = await runFrameCmd(parent.target, "DOM.getFrameOwner", {
            frameId: f.frameId,
          });
          if (owner.backendNodeId !== undefined) f.ownerBackendNodeId = owner.backendNodeId;
        } catch (err) {
          recordFailure(err, parent.target);
        }
      })
    );
    checkAtt();
    return Ut(pruned, failedFrames);
  },
};

function rectIntersectsViewport(rect, viewport) {
  if (!rect || !viewport) return false;
  if (!(rect.w > 0 && rect.h > 0 && viewport.width > 0 && viewport.height > 0)) return false;
  return (
    rect.x + rect.w > 0 &&
    rect.y + rect.h > 0 &&
    rect.x < viewport.width &&
    rect.y < viewport.height
  );
}

export function scopeVomScene(scene, scope = "viewport", documents = null) {
  if (scope === "all" || !scene?.viewport || !(scene.viewport.width > 0 && scene.viewport.height > 0)) {
    return { scene, offscreenCount: 0 };
  }
  const nodes = Array.isArray(scene.nodes) ? scene.nodes : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hasChild = new Set();
  for (const n of nodes) {
    if (n.parentId !== null && byId.has(n.parentId)) hasChild.add(n.parentId);
  }
  const localRectByKey = new Map();
  if (Array.isArray(documents)) {
    for (const doc of documents) {
      const fId = doc.frameId || "";
      for (const dom of doc.domNodes || []) {
        if (dom.backendNodeId !== undefined && dom.localRect) {
          localRectByKey.set(`${fId}\u0000${dom.backendNodeId}`, dom.localRect);
        }
      }
    }
  }
  const isNodeInViewport = (node) => {
    let cur = node;
    const seen = new Set();
    while (cur && !seen.has(cur.id)) {
      if (cur.rect) return rectIntersectsViewport(cur.rect, scene.viewport);
      if (
        cur.backendNodeId !== undefined &&
        localRectByKey.has(`${cur.frameId || ""}\u0000${cur.backendNodeId}`)
      ) {
        // Measured layout box clipped out of top viewport means the element is offscreen.
        return false;
      }
      seen.add(cur.id);
      cur = cur.parentId !== null ? byId.get(cur.parentId) : null;
    }
    // Keep nodes whose geometry is unavailable (e.g. unmeasured cross-origin frame content).
    return true;
  };
  const kept = new Set();
  const markWithAncestors = (node) => {
    let cur = node;
    const seen = new Set();
    while (cur && !seen.has(cur.id)) {
      kept.add(cur.id);
      seen.add(cur.id);
      cur = cur.parentId !== null ? byId.get(cur.parentId) : null;
    }
  };
  for (const n of nodes) {
    if (n.modal === true) {
      markWithAncestors(n);
      continue;
    }
    const role = bc(n);
    const interactive = jc(n) || n.visualKey !== undefined;
    const contentLike = interactive || !hasChild.has(n.id) || qd.has(role) || Boolean(H(n.text)) || role === "heading" || role === "img";
    if (!contentLike) continue;
    if (isNodeInViewport(n)) markWithAncestors(n);
  }
  let offscreenCount = 0;
  for (const n of nodes) {
    if ((jc(n) || n.visualKey !== undefined) && !kept.has(n.id)) offscreenCount++;
  }
  return {
    scene: { ...scene, nodes: nodes.filter((n) => kept.has(n.id)) },
    offscreenCount,
  };
}

export function sliceVomByTarget(scene, targetMatch) {
  if (!scene || !targetMatch || targetMatch.backendNodeId === undefined) return null;
  const nodes = Array.isArray(scene.nodes) ? scene.nodes : [];
  const hit = nodes.find(
    (n) =>
      n.backendNodeId === targetMatch.backendNodeId &&
      (!targetMatch.frameId || n.frameId === targetMatch.frameId)
  );
  if (!hit) return null;
  const subtreeIds = Dl(nodes, [hit.id]);
  const scopedNodes = nodes
    .filter((n) => subtreeIds.has(n.id))
    .map((n) => (n.id === hit.id ? { ...n, parentId: null } : n));
  return { ...scene, nodes: scopedNodes };
}

export function paginateVomSnapshot({ text = "", refs = [], limit, cursor } = {}) {
  const allRefs = Array.isArray(refs) ? refs : [];
  const hasLimit = Number.isFinite(limit) && limit > 0;
  const hasCursor = Number.isFinite(cursor) && cursor > 0;
  if (!hasLimit && !hasCursor) {
    return {
      text,
      refs: allRefs,
      offset: 0,
      shown: allRefs.length,
      inScope: allRefs.length,
      truncated: false,
    };
  }
  const lines = String(text || "").split("\n");
  let headerEnd = 0;
  while (headerEnd < lines.length && /^(@vom |@view |@layers |L\d+\s)/.test(lines[headerEnd])) {
    headerEnd++;
  }
  let bodyEnd = lines.length;
  while (bodyEnd > headerEnd && lines[bodyEnd - 1].startsWith("@warning ")) {
    bodyEnd--;
  }
  const headerLines = lines.slice(0, headerEnd);
  const warningLines = lines.slice(bodyEnd);

  const offset = hasCursor ? Math.floor(cursor) : 0;
  const lim = hasLimit ? Math.floor(limit) : Math.max(1, allRefs.length - offset);
  if (allRefs.length === 0 || offset >= allRefs.length) {
    const emptyLines =
      allRefs.length === 0
        ? lines
        : [...headerLines, `  (no more elements at cursor ${offset})`, ...warningLines];
    return {
      text: emptyLines.join("\n"),
      refs: [],
      offset,
      shown: 0,
      inScope: allRefs.length,
      truncated: false,
    };
  }
  const slice = allRefs.slice(offset, offset + lim);
  const nextIdx = offset + slice.length;
  const firstRefLine = Number.isInteger(slice[0].line) ? slice[0].line : headerEnd;
  const startLine = offset === 0 ? headerEnd : Math.max(headerEnd, firstRefLine);
  const nextRefLine =
    nextIdx < allRefs.length && Number.isInteger(allRefs[nextIdx].line)
      ? allRefs[nextIdx].line
      : bodyEnd;
  const endLine = Math.max(startLine, Math.min(bodyEnd, nextRefLine));
  const pageLines = [...headerLines, ...lines.slice(startLine, endLine), ...warningLines];
  const truncated = nextIdx < allRefs.length;
  return {
    text: pageLines.join("\n"),
    refs: slice,
    offset,
    shown: slice.length,
    inScope: allRefs.length,
    truncated,
    ...(truncated ? { next: nextIdx } : {}),
  };
}

export async function captureVomSnapshot(tabId, url, options = {}) {
  const signal = options.signal;
  B(signal);
  await vomCdpBridge.ensureTabReady(tabId);
  B(signal);

  const rawCapture = await rd(
    vomCdpBridge,
    tabId,
    async (capture) => {
      const { captured, documents } = ad(capture);
      B(signal);
      const fused = Rf({
        documents,
        viewport: captured.viewport,
        rootFrameId: captured.rootFrameId,
        excludedBackendNodeIds: captured.excludedBackendNodeIds,
      });
      const vomGraph = Bf(zf(fused, { identifierFallback: true }));
      let scene = _p(Vf(vomGraph), documents, captured);
      let offscreenCount = 0;
      if (options.targetBackendNodeId !== undefined) {
        const scoped = sliceVomByTarget(scene, {
          backendNodeId: options.targetBackendNodeId,
          frameId: options.targetFrameId,
        });
        if (!scoped) {
          const err = new Error("snapshot target was not found in the current VOM tree");
          err.code = "ELEMENT_NOT_FOUND";
          throw err;
        }
        scene = scoped;
      } else {
        const scoped = scopeVomScene(scene, options.scope || "viewport", documents);
        scene = scoped.scene;
        offscreenCount = scoped.offscreenCount;
      }
      const warnings = [];
      if (capture.issues.some((x) => x.stage === "geometry")) {
        warnings.push(
          "@warning geometry incomplete: some page or frame content has no top-level coordinates."
        );
      }
      const missingStages = ["dom", "ax", "forms", "ownership"].filter((st) =>
        capture.issues.some((x) => x.stage === st)
      );
      if (missingStages.length) {
        warnings.push(
          `@warning observation incomplete: some ${missingStages.join(", ")} data is unavailable or omitted.`
        );
      }
      if (
        capture.issues.some((x) => x.stage === "identity" && x.reason !== "identity-unverified")
      ) {
        warnings.push(
          "@warning observation incomplete: some documents were omitted because their identity changed or could not be revalidated."
        );
      }
      if (capture.issues.some((x) => x.reason === "identity-unverified")) {
        warnings.push(
          "@warning document identity unverified: some retained documents could not be checked for changes during capture."
        );
      }
      const warningText = warnings.join("\n");
      const maxTokens =
        !warningText || options.maxTokens === undefined
          ? options.maxTokens
          : Math.max(0, options.maxTokens - Xs(warningText));
      const rendered = jl(scene, {
        maxDepth: options.maxDepth,
        maxTokens,
        redactValues: options.redactValues,
        activeRegionPolicy: options.activeRegionPolicy ?? true,
      });
      if (warningText) rendered.text += `\n${warningText}`;
      const normalizedNodes = Gc(scene.nodes);
      const layer = Ds(normalizedNodes, scene.viewport, scene.rootFrameId);
      const frameMap = new Map(documents.map((d) => [d.frameId, d]));
      const rootFId = captured.rootFrameId ?? documents[0]?.frameId ?? "root";
      const buildNodeState = (n) => {
        const st = {};
        if (n.checked !== undefined) {
          st.checked = n.checked === "mixed" ? "mixed" : n.checked ? "true" : "false";
        }
        if (n.disabled) st.disabled = true;
        const selState = Dc(n);
        if (selState && selState.startsWith("selected")) st.selected = true;
        else if (selState && selState.startsWith("unselected")) st.selected = false;
        const expAttr = n.attrs?.["aria-expanded"]?.toLowerCase();
        if (expAttr === "true") st.expanded = true;
        else if (expAttr === "false") st.expanded = false;
        return Object.keys(st).length ? st : undefined;
      };
      const nodeMeta = new Map(
        normalizedNodes.map((n) => {
          const state = buildNodeState(n);
          const inIframe = Boolean(n.frameId && rootFId && n.frameId !== rootFId);
          const rawHref =
            n.attrs && typeof n.attrs.href === "string" && n.attrs.href !== ""
              ? n.attrs.href
              : n.href;
          return [
            `${n.frameId || ""}\u0000${n.backendNodeId ?? n.id}`,
            {
              tag: n.tag,
              rect: n.rect,
              ...(rawHref ? { href: rawHref } : {}),
              ...(n.placeholder ? { placeholder: n.placeholder } : {}),
              ...(!n.sensitive && typeof n.value === "string" && n.value !== ""
                ? { value: n.value }
                : {}),
              ...(state ? { state } : {}),
              inIframe,
            },
          ];
        })
      );
      const refByNodeKey = new Map(
        rendered.refs.map((r) => [`${r.frameId || ""}\u0000${r.backendNodeId}`, r.ref])
      );
      const openDialogs = normalizedNodes
        .filter((n) => bc(n) === "dialog" || bc(n) === "alertdialog" || n.tag === "dialog")
        .map((n) => {
          const key = `${n.frameId || ""}\u0000${n.backendNodeId ?? n.id}`;
          return {
            label: H(n.name) || "",
            role: bc(n),
            blocking: Boolean(layer && layer.kind === "modal"),
            ...(refByNodeKey.has(key) ? { ref: refByNodeKey.get(key) } : {}),
          };
        });
      const enrichedRefs = rendered.refs.map((r) => {
        const frameDoc = r.frameId ? frameMap.get(r.frameId) : undefined;
        const meta = nodeMeta.get(`${r.frameId || ""}\u0000${r.backendNodeId}`);
        return {
          ...r,
          ...(meta || {}),
          ...(frameDoc?.target?.sessionId ? { cdpSessionId: frameDoc.target.sessionId } : {}),
          ...(frameDoc?.url ? { frameUrl: frameDoc.url } : {}),
        };
      });
      return {
        ...Ld({
          rootFrameId: rootFId,
          frameDocuments: documents,
          rendered: { ...rendered, refs: enrichedRefs },
          surfaceProbes: [],
        }),
        viewport: captured.viewport,
        offscreenCount,
        layer,
        openDialogs,
        warnings,
      };
    },
    signal,
    url,
    { includeVisualFacts: false }
  );
  return rawCapture;
}

export async function resolveVomBackendNode(tabId, entry, refToken) {
  await vomCdpBridge.ensureTabReady(tabId);
  const target = entry.cdpSessionId ? { tabId, sessionId: entry.cdpSessionId } : { tabId };
  const objectGroup = `bctl-resolve-${makeUuid()}`;
  try {
    const resolved = await L(vomCdpBridge, target, "DOM.resolveNode", {
      backendNodeId: entry.backendNodeId,
      objectGroup,
    });
    const objectId = resolved.object?.objectId;
    if (!objectId) return { connected: false };
    const callRes = await L(vomCdpBridge, target, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function(token) {
        if (!this || !this.isConnected) return { connected: false };
        if (typeof this.setAttribute === "function") {
          this.setAttribute("data-bctl-cdp-ref", token);
        }
        if (this.ownerDocument && this.ownerDocument.documentElement) {
          this.ownerDocument.documentElement.setAttribute("data-bctl-cdp-frame", token);
        }
        return { connected: true, href: location.href };
      }`,
      arguments: [{ value: refToken }],
      returnByValue: true,
    });
    if (callRes.exceptionDetails) return { connected: false };
    return callRes.result?.value || { connected: false };
  } catch (err) {
    noteSwallowed("snapshot.resolveVomBackendNode", err);
    return { connected: false };
  } finally {
    await L(vomCdpBridge, target, "Runtime.releaseObjectGroup", { objectGroup }).catch(
      swallow("snapshot.resolveVomBackendNode.releaseObjectGroup")
    );
  }
}

export async function resolveAttrTokenBackendNode(tabId, attrName, attrValue, cdpSessionId) {
  await vomCdpBridge.ensureTabReady(tabId);
  const target = cdpSessionId ? { tabId, sessionId: cdpSessionId } : { tabId };
  const sel = `[${attrName}="${String(attrValue).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
  await L(vomCdpBridge, target, "DOM.enable", {}).catch(swallow("snapshot.domEnable"));
  const doc = await L(vomCdpBridge, target, "DOM.getDocument", { depth: 0 });
  const rootNodeId = doc?.root?.nodeId;
  if (rootNodeId) {
    const q = await L(vomCdpBridge, target, "DOM.querySelector", {
      nodeId: rootNodeId,
      selector: sel,
    }).catch(() => ({ nodeId: 0 }));
    if (q?.nodeId) {
      const desc = await L(vomCdpBridge, target, "DOM.describeNode", { nodeId: q.nodeId });
      if (desc?.node?.backendNodeId) return desc.node.backendNodeId;
    }
  }
  const search = await L(vomCdpBridge, target, "DOM.performSearch", {
    query: sel,
    includeUserAgentShadowDOM: false,
  }).catch(() => null);
  if (search?.searchId) {
    try {
      if (search.resultCount > 0) {
        const res = await L(vomCdpBridge, target, "DOM.getSearchResults", {
          searchId: search.searchId,
          fromIndex: 0,
          toIndex: 1,
        });
        const nodeId = res?.nodeIds?.[0];
        if (nodeId) {
          const desc = await L(vomCdpBridge, target, "DOM.describeNode", { nodeId });
          if (desc?.node?.backendNodeId) return desc.node.backendNodeId;
        }
      }
    } finally {
      await L(vomCdpBridge, target, "DOM.discardSearchResults", {
        searchId: search.searchId,
      }).catch(swallow("snapshot.discardSearch"));
    }
  }
  return null;
}

export { Ds as detectFocusLayer, jl as renderVomTree, Ol as applyOcclusionFilter };
