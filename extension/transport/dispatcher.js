// In-flight request tracking and abort dispatcher for browserctl.
// Adheres strictly to docs/spec/00-architecture-overview.md and docs/spec/01-protocol-and-errors.md.

import { RpcError, RPC_ERRORS } from "./errors.js";

/**
 * In-flight requests tracked by requestId -> AbortController.
 * @type {Map<string|number, AbortController>}
 */
export const inFlightRequests = new Map();

export const DEFAULT_ACTION_BUDGET_MS = 60_000;
export const TRANSPORT_GRACE_SLACK_MS = 5_000;

/**
 * Computes the outer transport watchdog timeout following the Hierarchical Timing Envelope:
 * OuterWatchdog = ActionBudget + GRACE_SLACK (5,000ms).
 *
 * @param {object} [params] - Action parameters.
 * @returns {number} Transport timeout in milliseconds.
 */
export function computeTransportTimeout(params) {
  const actionTimeout = Number(params && (params.timeoutMs || params.timeout));
  if (Number.isFinite(actionTimeout) && actionTimeout > 0) {
    return actionTimeout + TRANSPORT_GRACE_SLACK_MS;
  }
  return DEFAULT_ACTION_BUDGET_MS;
}

/**
 * Executes an async operation with abort and timeout management.
 *
 * @param {string|number} requestId - Unique identifier for the in-flight request.
 * @param {number} timeoutMs - Timeout duration in milliseconds.
 * @param {(signal: AbortSignal) => Promise<any>} handler - Async function accepting an AbortSignal.
 * @returns {Promise<any>}
 */
export async function executeWithAbort(requestId, timeoutMs, handler) {
  const controller = new AbortController();
  let timer = null;

  if (typeof timeoutMs === "number" && timeoutMs > 0 && timeoutMs < Infinity) {
    timer = setTimeout(() => {
      controller.abort(
        new RpcError(RPC_ERRORS.NAVIGATION_TIMEOUT, "Operation timed out", {
          reason: "TIMEOUT",
          retriable: true,
        })
      );
    }, timeoutMs);
  }

  if (requestId != null) {
    inFlightRequests.set(requestId, controller);
  }

  try {
    const abortPromise = new Promise((_, reject) => {
      if (controller.signal.aborted) {
        reject(
          controller.signal.reason ||
            new RpcError(RPC_ERRORS.EXECUTION_ABORTED, "Operation cancelled by signal", {
              reason: "ABORTED_BY_SIGNAL",
              retriable: false,
            })
        );
        return;
      }
      controller.signal.addEventListener(
        "abort",
        () => {
          reject(
            controller.signal.reason ||
              new RpcError(RPC_ERRORS.EXECUTION_ABORTED, "Operation cancelled by signal", {
                reason: "ABORTED_BY_SIGNAL",
                retriable: false,
              })
          );
        },
        { once: true }
      );
    });

    let handlerPromise;
    try {
      handlerPromise = Promise.resolve(handler(controller.signal));
    } catch (err) {
      handlerPromise = Promise.reject(err);
    }

    return await Promise.race([handlerPromise, abortPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    if (requestId != null) {
      inFlightRequests.delete(requestId);
    }
  }
}

/**
 * Abort a single in-flight request by its ID.
 *
 * @param {string|number} requestId
 * @param {*} [reason]
 * @returns {boolean} True if the request was found and aborted, false otherwise.
 */
export function abortRequest(requestId, reason) {
  if (requestId == null) return false;
  const controller = inFlightRequests.get(requestId);
  if (!controller) return false;

  const abortReason =
    reason instanceof Error
      ? reason
      : new RpcError(
          RPC_ERRORS.EXECUTION_ABORTED,
          typeof reason === "string" ? reason : "Operation cancelled by signal",
          {
            reason: "ABORTED_BY_SIGNAL",
            retriable: false,
          }
        );

  controller.abort(abortReason);
  inFlightRequests.delete(requestId);
  return true;
}

/**
 * Abort all currently in-flight requests.
 *
 * @param {*} [reason]
 * @returns {number} The count of requests that were aborted.
 */
export function abortAll(reason) {
  const abortReason =
    reason instanceof Error
      ? reason
      : new RpcError(
          RPC_ERRORS.EXECUTION_ABORTED,
          typeof reason === "string" ? reason : "All operations cancelled",
          {
            reason: "ABORTED_BY_SIGNAL",
            retriable: false,
          }
        );

  const controllers = Array.from(inFlightRequests.values());
  inFlightRequests.clear();
  for (const controller of controllers) {
    controller.abort(abortReason);
  }
  return controllers.length;
}
