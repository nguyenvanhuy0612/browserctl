import { test } from "node:test";
import assert from "node:assert/strict";

const prevChrome = globalThis.chrome;
if (!globalThis.chrome) {
  globalThis.chrome = {
    debugger: {
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
    },
    tabs: {
      onRemoved: { addListener() {} },
    },
    runtime: {
      onMessage: { addListener() {} },
    },
  };
}

const { Rf, zf, Bf, Vf, detectFocusLayer, renderVomTree, applyOcclusionFilter } =
  await import("../../extension/snapshot.js");

if (prevChrome === undefined) {
  delete globalThis.chrome;
}

test("snapshot DOM/AX fusion renders @vom 1 tree and sequential refs across frames", () => {
  const docRoot = {
    frameId: "root",
    contextScopeId: "root",
    url: "https://example.test/",
    target: { tabId: 1 },
    domNodes: [
      {
        backendNodeId: 1,
        nodeType: 9,
        parentBackendNodeId: null,
        tag: "#document",
        attrs: {},
        paintOrder: 0,
        position: "static",
        pointerEvents: "auto",
        cursor: "auto",
        rect: { x: 0, y: 0, w: 1280, h: 800 },
        rendered: true,
      },
      {
        backendNodeId: 2,
        nodeType: 1,
        parentBackendNodeId: 1,
        tag: "button",
        attrs: { type: "button" },
        paintOrder: 1,
        position: "static",
        pointerEvents: "auto",
        cursor: "pointer",
        textContent: "Submit",
        rect: { x: 20, y: 20, w: 100, h: 36 },
        rendered: true,
      },
      {
        backendNodeId: 3,
        nodeType: 1,
        parentBackendNodeId: 1,
        tag: "iframe",
        attrs: { title: "Embedded frame" },
        paintOrder: 2,
        position: "static",
        pointerEvents: "auto",
        cursor: "auto",
        rect: { x: 20, y: 80, w: 400, h: 200 },
        rendered: true,
      },
    ],
    axNodes: [
      {
        nodeId: "ax1",
        backendDOMNodeId: 1,
        role: { type: "role", value: "RootWebArea" },
        name: { type: "computedString", value: "Demo" },
      },
      {
        nodeId: "ax2",
        parentId: "ax1",
        backendDOMNodeId: 2,
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Submit" },
      },
      {
        nodeId: "ax3",
        parentId: "ax1",
        backendDOMNodeId: 3,
        role: { type: "role", value: "Iframe" },
        name: { type: "computedString", value: "Embedded frame" },
      },
    ],
  };

  const docChild = {
    frameId: "child1",
    parentFrameId: "root",
    ownerBackendNodeId: 3,
    contextScopeId: "child1",
    url: "https://sub.example.test/widget",
    target: { tabId: 1, sessionId: "sess-1" },
    domNodes: [
      {
        backendNodeId: 10,
        nodeType: 9,
        parentBackendNodeId: null,
        tag: "#document",
        attrs: {},
        paintOrder: 0,
        position: "static",
        pointerEvents: "auto",
        cursor: "auto",
        rect: { x: 20, y: 80, w: 400, h: 200 },
        rendered: true,
      },
      {
        backendNodeId: 11,
        nodeType: 1,
        parentBackendNodeId: 10,
        tag: "a",
        attrs: { href: "https://docs.other.test/guide" },
        paintOrder: 3,
        position: "static",
        pointerEvents: "auto",
        cursor: "pointer",
        textContent: "Docs",
        rect: { x: 30, y: 90, w: 60, h: 24 },
        rendered: true,
      },
    ],
    axNodes: [
      {
        nodeId: "cax1",
        backendDOMNodeId: 10,
        role: { type: "role", value: "RootWebArea" },
        name: { type: "computedString", value: "Widget" },
      },
      {
        nodeId: "cax2",
        parentId: "cax1",
        backendDOMNodeId: 11,
        role: { type: "role", value: "link" },
        name: { type: "computedString", value: "Docs" },
      },
    ],
  };

  const fused = Rf({
    documents: [docRoot, docChild],
    viewport: { width: 1280, height: 800 },
    rootFrameId: "root",
  });
  const scene = Vf(Bf(zf(fused, { identifierFallback: true })));
  const rendered = renderVomTree(scene, { activeRegionPolicy: true });

  assert.match(rendered.text, /^@vom 1\n@view 1280x800\n@layers 1 focus=L1\nL1 page/);
  assert.match(rendered.text, /@e1 button "Submit"/);
  assert.match(rendered.text, /@e2 link "Docs" \[→ docs\.other\.test\]/);
  assert.equal(rendered.refs.length, 2);
  assert.equal(rendered.refs[1].frameId, "child1");
});

test("detectFocusLayer and renderVomTree isolate full-screen modal and count occluded nodes", () => {
  const viewport = { width: 1000, height: 800 };
  const nodes = [
    {
      id: 1,
      parentId: null,
      frameId: "root",
      tag: "button",
      role: "button",
      name: "Background",
      paintOrder: 1,
      position: "static",
      pointerEvents: "auto",
      rect: { x: 10, y: 10, w: 80, h: 30 },
      attrs: {},
    },
    {
      id: 2,
      parentId: null,
      frameId: "root",
      tag: "div",
      role: "dialog",
      name: "Settings Modal",
      modal: true,
      paintOrder: 10,
      position: "fixed",
      pointerEvents: "auto",
      rect: { x: 0, y: 0, w: 1000, h: 800 },
      attrs: { "aria-modal": "true" },
    },
    {
      id: 3,
      parentId: 2,
      frameId: "root",
      tag: "button",
      role: "button",
      name: "Save",
      paintOrder: 11,
      position: "static",
      pointerEvents: "auto",
      rect: { x: 400, y: 400, w: 90, h: 32 },
      attrs: {},
    },
  ];

  const layer = detectFocusLayer(nodes, viewport, "root");
  assert.equal(layer.kind, "modal");
  assert.equal(layer.coverage, 1);

  const rendered = renderVomTree(
    { viewport, nodes, rootFrameId: "root" },
    { activeRegionPolicy: true }
  );
  assert.match(rendered.text, /@layers 2 focus=L1\nL1 modal cover=100%/);
  assert.match(rendered.text, /@e1 button "Save"/);
  assert.doesNotMatch(rendered.text, /Background/);
  assert.match(rendered.text, /L2 page … occluded by L1 \(~1 nodes, not actionable\)/);
  assert.equal(rendered.refs.length, 1);
});

test("applyOcclusionFilter hides interactive controls behind partial fixed overlays", () => {
  const viewport = { width: 1000, height: 800 };
  const nodes = [
    {
      id: 1,
      parentId: null,
      frameId: "root",
      tag: "button",
      role: "button",
      name: "Covered",
      paintOrder: 1,
      position: "static",
      pointerEvents: "auto",
      rect: { x: 100, y: 100, w: 100, h: 40 },
      attrs: {},
    },
    {
      id: 2,
      parentId: null,
      frameId: "root",
      tag: "button",
      role: "button",
      name: "Clear",
      paintOrder: 2,
      position: "static",
      pointerEvents: "auto",
      rect: { x: 600, y: 100, w: 100, h: 40 },
      attrs: {},
    },
    {
      id: 3,
      parentId: null,
      frameId: "root",
      tag: "div",
      role: "group",
      paintOrder: 10,
      position: "fixed",
      pointerEvents: "auto",
      rect: { x: 50, y: 50, w: 300, h: 200 },
      attrs: {},
    },
  ];

  const visible = applyOcclusionFilter(nodes, { viewport });
  assert.deepEqual(visible.map((n) => n.name).filter(Boolean), ["Clear"]);
});

test("scopeVomScene filters offscreen controls in viewport scope and keeps them in all", async () => {
  const { scopeVomScene } = await import("../../extension/snapshot.js");
  const scene = {
    viewport: { width: 1000, height: 800 },
    nodes: [
      {
        id: 1,
        parentId: null,
        frameId: "root",
        tag: "main",
        role: "main",
        name: "Main",
        rect: { x: 0, y: 0, w: 1000, h: 3000 },
      },
      {
        id: 2,
        parentId: 1,
        frameId: "root",
        tag: "button",
        role: "button",
        name: "InView",
        rect: { x: 20, y: 40, w: 100, h: 30 },
      },
      {
        id: 3,
        parentId: 1,
        frameId: "root",
        tag: "button",
        role: "button",
        name: "BelowFold",
        rect: { x: 20, y: 2400, w: 100, h: 30 },
      },
    ],
  };

  const vp = scopeVomScene(scene, "viewport");
  assert.equal(vp.offscreenCount, 1);
  assert.deepEqual(
    vp.scene.nodes.map((n) => n.name),
    ["Main", "InView"]
  );

  const all = scopeVomScene(scene, "all");
  assert.equal(all.offscreenCount, 0);
  assert.deepEqual(
    all.scene.nodes.map((n) => n.name),
    ["Main", "InView", "BelowFold"]
  );
});

test("sliceVomByTarget re-roots the scene to the matched element and its descendants", async () => {
  const { sliceVomByTarget } = await import("../../extension/snapshot.js");
  const scene = {
    viewport: { width: 1000, height: 800 },
    nodes: [
      { id: 1, parentId: null, frameId: "root", tag: "nav", role: "navigation", name: "Nav" },
      { id: 2, parentId: 1, frameId: "root", tag: "a", role: "link", name: "Home" },
      {
        id: 10,
        parentId: null,
        frameId: "root",
        tag: "section",
        role: "region",
        name: "Editor",
        backendNodeId: 500,
      },
      { id: 11, parentId: 10, frameId: "root", tag: "button", role: "button", name: "Run" },
    ],
  };

  const sliced = sliceVomByTarget(scene, { backendNodeId: 500, frameId: "root" });
  assert.ok(sliced);
  assert.deepEqual(
    sliced.nodes.map((n) => n.name),
    ["Editor", "Run"]
  );
  assert.equal(sliced.nodes[0].parentId, null);
});

test("paginateVomSnapshot slices ref lines cleanly and exposes next cursor", async () => {
  const { paginateVomSnapshot } = await import("../../extension/snapshot.js");
  const text = [
    "@vom 1",
    "@view 1000x800",
    "nav",
    '  @e1 link "One"',
    '  @e2 link "Two"',
    '  @e3 link "Three"',
    "@warning truncation_note",
  ].join("\n");
  const refs = [
    { ref: "@e1", role: "link", name: "One", line: 3 },
    { ref: "@e2", role: "link", name: "Two", line: 4 },
    { ref: "@e3", role: "link", name: "Three", line: 5 },
  ];

  const page1 = paginateVomSnapshot({ text, refs, limit: 2, cursor: 0 });
  assert.equal(page1.offset, 0);
  assert.equal(page1.shown, 2);
  assert.equal(page1.inScope, 3);
  assert.equal(page1.truncated, true);
  assert.equal(page1.next, 2);
  assert.ok(page1.text.includes("@e1"));
  assert.ok(page1.text.includes("@e2"));
  assert.ok(!page1.text.includes("@e3"));

  const page2 = paginateVomSnapshot({ text, refs, limit: 2, cursor: page1.next });
  assert.equal(page2.offset, 2);
  assert.equal(page2.shown, 1);
  assert.equal(page2.truncated, false);
  assert.equal(page2.next, undefined);
  assert.ok(page2.text.includes("@e3"));
});

test("scopeVomScene drops clipped-out nodes that have localRect when ancestor intersects viewport", async () => {
  const { scopeVomScene } = await import("../../extension/snapshot.js");
  const scene = {
    viewport: { width: 1200, height: 800 },
    nodes: [
      {
        id: 1,
        parentId: null,
        frameId: "root",
        backendNodeId: 10,
        tag: "main",
        role: "main",
        name: "Main",
        rect: { x: 0, y: 0, w: 1200, h: 800 },
      },
      {
        id: 2,
        parentId: 1,
        frameId: "root",
        backendNodeId: 11,
        tag: "a",
        role: "link",
        name: "Visible",
        rect: { x: 10, y: 20, w: 100, h: 20 },
      },
      {
        id: 3,
        parentId: 1,
        frameId: "root",
        backendNodeId: 12,
        tag: "a",
        role: "link",
        name: "OffscreenClipped",
        rect: null,
      },
    ],
  };
  const documents = [
    {
      frameId: "root",
      domNodes: [
        { backendNodeId: 10, localRect: { x: 0, y: 0, w: 1200, h: 4000 } },
        { backendNodeId: 11, localRect: { x: 10, y: 20, w: 100, h: 20 } },
        { backendNodeId: 12, localRect: { x: 10, y: 3500, w: 100, h: 20 } },
      ],
    },
  ];
  const vp = scopeVomScene(scene, "viewport", documents);
  assert.equal(vp.offscreenCount, 1);
  assert.deepEqual(
    vp.scene.nodes.map((n) => n.name),
    ["Main", "Visible"]
  );
});
