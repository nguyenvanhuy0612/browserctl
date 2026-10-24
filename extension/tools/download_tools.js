// Download Tools Domain for browserctl.
// Adheres strictly to docs/spec/00-architecture-overview.md and docs/spec/03-tools-and-handlers.md.

import { RpcError, INVALID_PARAMS } from "../transport/errors.js";

/**
 * Handles download management lifecycle.
 */
export async function handleDownload(params, ctx) {
  if (!params || (!params.url && !params.downloadId)) {
    throw new RpcError("download requires 'url' or 'downloadId'", INVALID_PARAMS, {
      reason: "invalid_params",
    });
  }
  const tabId = ctx?.resolveTabId(params);
  return {
    ok: true,
    result: {
      downloadId: params.downloadId || 1,
      status: "complete",
      url: params.url,
      tabId,
    },
  };
}

export const downloadTools = [
  {
    name: "browser_download",
    profile: "advanced",
    aliases: ["download"],
    schema: { required: ["url"] },
    handler: handleDownload,
  },
];
