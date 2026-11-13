// Standard JSON-RPC 2.0 and application error definitions for browserctl.

/**
 * Standard JSON-RPC 2.0 error codes (-32700 to -32603)
 * and application error codes (-32001 to -32010).
 */
export const RPC_ERRORS = Object.freeze({
  // JSON-RPC 2.0 standard codes
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  // Application error codes
  TARGET_NOT_FOUND: -32001,
  ELEMENT_NOT_FOUND: -32002,
  ELEMENT_NOT_INTERACTABLE: -32003,
  NAVIGATION_TIMEOUT: -32004,
  CDP_ATTACH_FAILED: -32005,
  EXECUTION_ABORTED: -32006,
  DOWNLOAD_FAILED: -32007,
  POLICY_RESTRICTION: -32008,
  BUDGET_EXCEEDED: -32009,
  NETWORK_REPLAY_FAILED: -32010,
});

export const PARSE_ERROR = RPC_ERRORS.PARSE_ERROR;
export const INVALID_REQUEST = RPC_ERRORS.INVALID_REQUEST;
export const METHOD_NOT_FOUND = RPC_ERRORS.METHOD_NOT_FOUND;
export const INVALID_PARAMS = RPC_ERRORS.INVALID_PARAMS;
export const INTERNAL_ERROR = RPC_ERRORS.INTERNAL_ERROR;

export const TARGET_NOT_FOUND = RPC_ERRORS.TARGET_NOT_FOUND;
export const ELEMENT_NOT_FOUND = RPC_ERRORS.ELEMENT_NOT_FOUND;
export const ELEMENT_NOT_INTERACTABLE = RPC_ERRORS.ELEMENT_NOT_INTERACTABLE;
export const NAVIGATION_TIMEOUT = RPC_ERRORS.NAVIGATION_TIMEOUT;
export const CDP_ATTACH_FAILED = RPC_ERRORS.CDP_ATTACH_FAILED;
export const EXECUTION_ABORTED = RPC_ERRORS.EXECUTION_ABORTED;
export const DOWNLOAD_FAILED = RPC_ERRORS.DOWNLOAD_FAILED;
export const POLICY_RESTRICTION = RPC_ERRORS.POLICY_RESTRICTION;
export const BUDGET_EXCEEDED = RPC_ERRORS.BUDGET_EXCEEDED;
export const NETWORK_REPLAY_FAILED = RPC_ERRORS.NETWORK_REPLAY_FAILED;

/**
 * Standardized RpcError class inheriting from Error.
 */
export class RpcError extends Error {
  /**
   * @param {number|string} code
   * @param {string} message
   * @param {object} [data]
   * @param {string} [data.reason]
   * @param {boolean} [data.retriable=false]
   * @param {*} [data.details]
   */
  constructor(code, message, data = {}) {
    let finalCode = code;
    let finalMsg = message;
    if (typeof code === "string" && typeof message === "number") {
      finalCode = message;
      finalMsg = code;
    }
    super(finalMsg);
    this.name = "RpcError";
    this.code = typeof finalCode === "number" ? finalCode : (RPC_ERRORS[finalCode] ?? -32603);
    const { reason, retriable, details, disposition, recovery, ...rest } = data || {};
    this.data = {
      reason: reason || (typeof finalCode === "string" ? finalCode : "UNKNOWN_ERROR"),
      retriable: Boolean(retriable),
      details: details !== undefined ? details : null,
      ...(disposition ? { disposition } : {}),
      ...(recovery ? { recovery } : {}),
      ...rest,
    };
    this.ok = false;
  }

  get disposition() {
    return this.data ? this.data.disposition : undefined;
  }

  set disposition(val) {
    if (!this.data) this.data = {};
    this.data.disposition = val;
  }

  get recovery() {
    return this.data ? this.data.recovery : undefined;
  }

  set recovery(val) {
    if (!this.data) this.data = {};
    this.data.recovery = val;
  }

  get error() {
    return this.message;
  }

  set error(val) {
    this.message = String(val || "");
  }

  get reason() {
    return this.data ? this.data.reason : undefined;
  }

  set reason(val) {
    if (!this.data) this.data = {};
    this.data.reason = val;
  }

  get retriable() {
    return this.data ? this.data.retriable : false;
  }

  set retriable(val) {
    if (!this.data) this.data = {};
    this.data.retriable = Boolean(val);
  }

  get details() {
    return this.data ? this.data.details : null;
  }

  set details(val) {
    if (!this.data) this.data = {};
    this.data.details = val;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      data: this.data,
    };
  }

  static fromError(err) {
    if (err instanceof RpcError) return err;
    if (!err) {
      return new RpcError(RPC_ERRORS.INTERNAL_ERROR, "Internal server error", {
        reason: "INTERNAL_ERROR",
        retriable: false,
        details: null,
      });
    }
    const message = err.message || (typeof err === "string" ? err : "Internal server error");
    const code =
      typeof err.code === "number"
        ? err.code
        : typeof err.code === "string" && RPC_ERRORS[err.code] !== undefined
          ? RPC_ERRORS[err.code]
          : RPC_ERRORS.INTERNAL_ERROR;
    const reason = err.reason || (typeof err.code === "string" ? err.code : "INTERNAL_ERROR");
    const retriable = Boolean(err.retriable || err.data?.retriable);
    const details = err.data?.details ?? err.details ?? err.diagnostics ?? err.stack ?? null;
    const disposition = err.disposition ?? err.data?.disposition;
    const recovery = err.recovery ?? err.data?.recovery;
    return new RpcError(code, message, {
      reason,
      retriable,
      details,
      ...(disposition ? { disposition } : {}),
      ...(recovery ? { recovery } : {}),
    });
  }
}
