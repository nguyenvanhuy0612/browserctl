// Tool Registry and ExecutionContext for browserctl.
// Adheres strictly to docs/spec/00-architecture-overview.md and docs/spec/03-tools-and-handlers.md.

import {
  RpcError,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  EXECUTION_ABORTED,
} from "../transport/errors.js";

/**
 * Execution context providing dependency-injected services to tool handlers.
 */
export class ExecutionContext {
  /**
   * @param {object} [options]
   * @param {number|null} [options.tabId=null]
   * @param {string} [options.browserProfile="core"]
   * @param {AbortSignal|null} [options.signal=null]
   * @param {object|null} [options.driver=null] - CDP Driver instance
   * @param {object|null} [options.contentBridge=null] - Tab IPC bridge
   */
  constructor({
    tabId = null,
    browserProfile = "core",
    signal = null,
    driver = null,
    contentBridge = null,
  } = {}) {
    this.tabId = tabId;
    this.browserProfile = browserProfile;
    this.signal = signal;
    this.driver = driver;
    this.contentBridge = contentBridge;
  }

  /**
   * Resolves the target tab ID from context or explicit parameter.
   *
   * @param {number|object|string|null} [target]
   * @returns {number|null}
   */
  resolveTabId(target) {
    if (typeof target === "number") return target;
    if (target && typeof target === "object" && typeof target.tabId === "number") {
      return target.tabId;
    }
    return this.tabId != null ? this.tabId : null;
  }
}

/**
 * Tool registry holding tool descriptors and executing handlers.
 */
export class ToolRegistry {
  constructor() {
    /** @type {Map<string, object>} */
    this.tools = new Map();
  }

  /**
   * Registers a tool descriptor.
   *
   * @param {object} descriptor
   * @param {string} descriptor.name
   * @param {string} [descriptor.profile="core"]
   * @param {object} [descriptor.schema]
   * @param {Function} descriptor.handler
   * @param {string[]} [descriptor.aliases]
   * @returns {ToolRegistry}
   */
  register(descriptor) {
    if (!descriptor || typeof descriptor.name !== "string") {
      throw new Error("ToolDescriptor must have a string 'name'");
    }
    if (typeof descriptor.handler !== "function") {
      throw new Error(`ToolDescriptor '${descriptor.name}' must provide a handler function`);
    }

    const toolEntry = {
      name: descriptor.name,
      profile: descriptor.profile || "core",
      schema: descriptor.schema || null,
      handler: descriptor.handler,
      aliases: descriptor.aliases || [],
    };

    this.tools.set(descriptor.name, toolEntry);

    if (Array.isArray(descriptor.aliases)) {
      for (const alias of descriptor.aliases) {
        this.tools.set(alias, toolEntry);
      }
    }

    return this;
  }

  /**
   * Retrieves a tool descriptor by name or alias.
   *
   * @param {string} name
   * @returns {object|null}
   */
  get(name) {
    return this.tools.get(name) || null;
  }

  /**
   * Checks whether a tool is registered.
   *
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this.tools.has(name);
  }

  /**
   * Lists all unique tool descriptors, optionally filtered by profile.
   *
   * @param {string} [profile]
   * @returns {object[]}
   */
  list(profile) {
    const seen = new Set();
    const result = [];

    for (const descriptor of this.tools.values()) {
      if (!seen.has(descriptor.name)) {
        seen.add(descriptor.name);
        if (!profile || profile === "all" || descriptor.profile === profile) {
          result.push(descriptor);
        }
      }
    }

    return result;
  }

  /**
   * Executes a registered tool handler with validation and abort propagation.
   *
   * @param {string} name
   * @param {object} [params={}]
   * @param {ExecutionContext} [ctx]
   * @returns {Promise<any>}
   */
  async execute(name, params = {}, ctx = null) {
    const descriptor = this.get(name);
    if (!descriptor) {
      throw new RpcError(METHOD_NOT_FOUND, `Tool '${name}' not found`, {
        reason: "method_not_found",
        tool: name,
      });
    }

    // 1. Check signal before starting
    if (ctx?.signal?.aborted) {
      throw new RpcError(EXECUTION_ABORTED, "Execution aborted", {
        reason: "execution_aborted",
      });
    }

    // 2. Schema / Parameter validation
    if (descriptor.schema) {
      if (typeof descriptor.schema.validate === "function") {
        const res = descriptor.schema.validate(params);
        if (res && res.valid === false) {
          throw new RpcError(INVALID_PARAMS, res.error || "Invalid parameters", {
            reason: "invalid_params",
            details: res.details,
          });
        }
      } else {
        if (Array.isArray(descriptor.schema.required)) {
          for (const req of descriptor.schema.required) {
            if (params[req] === undefined || params[req] === null || params[req] === "") {
              throw new RpcError(INVALID_PARAMS, `Missing required parameter '${req}'`, {
                reason: "invalid_params",
                missingParameter: req,
              });
            }
          }
        }
        if (descriptor.schema.properties && typeof descriptor.schema.properties === "object") {
          for (const [key, propDef] of Object.entries(descriptor.schema.properties)) {
            if (params[key] !== undefined && propDef?.type) {
              if (
                propDef.type === "number" &&
                (typeof params[key] !== "number" || Number.isNaN(params[key]))
              ) {
                throw new RpcError(INVALID_PARAMS, `Parameter '${key}' must be a number`, {
                  reason: "invalid_params",
                  param: key,
                });
              }
              if (propDef.type === "string" && typeof params[key] !== "string") {
                throw new RpcError(INVALID_PARAMS, `Parameter '${key}' must be a string`, {
                  reason: "invalid_params",
                  param: key,
                });
              }
              if (propDef.type === "boolean" && typeof params[key] !== "boolean") {
                throw new RpcError(INVALID_PARAMS, `Parameter '${key}' must be a boolean`, {
                  reason: "invalid_params",
                  param: key,
                });
              }
            }
          }
        }
      }
    }

    // 3. Execution with abort propagation
    if (ctx?.signal) {
      let abortListener = null;
      const abortPromise = new Promise((_, reject) => {
        abortListener = () => {
          reject(
            new RpcError(EXECUTION_ABORTED, "Execution aborted", {
              reason: "execution_aborted",
            })
          );
        };
        ctx.signal.addEventListener("abort", abortListener, { once: true });
      });

      try {
        return await Promise.race([descriptor.handler(params, ctx), abortPromise]);
      } catch (err) {
        throw RpcError.fromError(err);
      } finally {
        if (abortListener && ctx.signal) {
          ctx.signal.removeEventListener("abort", abortListener);
        }
      }
    }

    try {
      return await descriptor.handler(params, ctx);
    } catch (err) {
      throw RpcError.fromError(err);
    }
  }
}
