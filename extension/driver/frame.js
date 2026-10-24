// Frame Tree Manager and Multi-Frame Executor for browserctl.
// Adheres strictly to docs/spec/00-architecture-overview.md and docs/spec/02-driver-and-cdp.md.

import { sendCdpCommand } from "./session.js";

/**
 * Retrieves the frame tree hierarchy for a tab via Page.getFrameTree.
 *
 * @param {number} tabId
 * @returns {Promise<object>} Root frame tree node.
 */
export async function getFrameTree(tabId) {
  const res = await sendCdpCommand(tabId, "Page.getFrameTree");
  return res.frameTree;
}

/**
 * Recursively flattens a nested frame tree into an array of frames.
 *
 * @param {object} frameTree - Node from Page.getFrameTree.
 * @param {string} [parentId=null]
 * @returns {Array<{ frame: object, parentId: string|null }>}
 */
export function flattenFrameTree(frameTree, parentId = null) {
  if (!frameTree || !frameTree.frame) return [];
  const current = { frame: frameTree.frame, parentId };
  let results = [current];
  if (Array.isArray(frameTree.childFrames)) {
    for (const child of frameTree.childFrames) {
      results = results.concat(flattenFrameTree(child, frameTree.frame.id));
    }
  }
  return results;
}

/**
 * Recursively searches a frame tree for a frame matching a predicate.
 *
 * @param {object} frameTree - Root or subframe tree node.
 * @param {(frame: object) => boolean} predicate
 * @returns {object|null} Matched frame object or null.
 */
export function findFrame(frameTree, predicate) {
  if (!frameTree || !frameTree.frame) return null;
  if (predicate(frameTree.frame)) return frameTree.frame;
  if (Array.isArray(frameTree.childFrames)) {
    for (const child of frameTree.childFrames) {
      const match = findFrame(child, predicate);
      if (match) return match;
    }
  }
  return null;
}

/**
 * Finds an execution context ID matching a target frameId.
 *
 * @param {string} frameId
 * @param {Array<{ id: number, auxData?: { frameId?: string, isDefault?: boolean } }>} contexts
 * @returns {number|null} Context ID or null.
 */
export function mapFrameToContext(frameId, contexts) {
  if (!frameId || !Array.isArray(contexts)) return null;
  const match = contexts.find(
    (c) => c.auxData && c.auxData.frameId === frameId && c.auxData.isDefault
  );
  if (match) return match.id;
  const anyMatch = contexts.find((c) => c.auxData && c.auxData.frameId === frameId);
  return anyMatch ? anyMatch.id : null;
}

/**
 * Projects a local iframe bounding rect across the frame hierarchy
 * into top-level window viewport coordinates.
 *
 * @param {number} tabId
 * @param {number} frameId
 * @param {object} localRect - { x, y, width, height }
 * @param {function} [toContentFn] - Message bridge to content script
 * @returns {Promise<object>} Projected rect with updated x, y.
 */
export async function projectFrameRect(tabId, frameId, localRect, toContentFn = null) {
  if (!localRect || frameId === 0 || localRect.reachedTop) return localRect;
  let curFrameId = frameId;
  let x = localRect.x;
  let y = localRect.y;

  if (typeof chrome === "undefined" || !chrome.webNavigation?.getFrame) {
    return { ...localRect, x, y };
  }

  while (curFrameId !== 0) {
    let frameInfo = null;
    try {
      frameInfo = await chrome.webNavigation.getFrame({ tabId, frameId: curFrameId });
    } catch {}
    if (!frameInfo || frameInfo.parentFrameId == null) break;

    const parentFrameId = frameInfo.parentFrameId;
    if (toContentFn) {
      const parentReply = await toContentFn(
        "iframe_rect",
        { url: frameInfo.url, tabId },
        parentFrameId
      );
      if (parentReply && parentReply.ok && parentReply.result) {
        x += (parentReply.result.x || 0) + (parentReply.result.borderLeft || 0);
        y += (parentReply.result.y || 0) + (parentReply.result.borderTop || 0);
      }
    }
    curFrameId = parentFrameId;
  }

  return {
    ...localRect,
    x,
    y,
  };
}
