// @ts-check
// The tool registry: one entry per tool, the single source for validation, MCP schemas, CLI flags
// and docs (specs/interface.md).
import { Ajv } from "ajv";
import { BctlError } from "./errors.js";

/**
 * @typedef {{
 *   name: string,
 *   description: string,
 *   inputSchema: {type: "object", properties: Record<string, any>, required?: string[]},
 *   handler: (params: any, ctx: {daemon: import("./app.js").Daemon, session: import("./sessions.js").Session}) => Promise<object>,
 * }} Tool
 */

export class Registry {
  /** @type {Map<string, Tool>} */
  #tools = new Map();
  /** @type {Map<string, import("ajv").ValidateFunction>} */
  #validators = new Map();

  /** @param {Tool[]} tools */
  constructor(tools) {
    const ajv = new Ajv({ allErrors: true, strict: true, useDefaults: true, coerceTypes: false });
    for (const tool of tools) {
      const schema = { ...tool.inputSchema, additionalProperties: false };
      this.#tools.set(tool.name, { ...tool, inputSchema: schema });
      this.#validators.set(tool.name, ajv.compile(schema));
    }
  }

  list() {
    return [...this.#tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  /** @param {string} name */
  get(name) {
    const tool = this.#tools.get(name);
    if (!tool) throw new BctlError("INVALID_PARAMS", `unknown tool ${name}`, { tools: [...this.#tools.keys()] });
    return tool;
  }

  /** @param {string} name @param {unknown} params */
  validate(name, params) {
    const tool = this.get(name);
    const copy = structuredClone(params ?? {});
    const validate = /** @type {import("ajv").ValidateFunction} */ (this.#validators.get(name));
    if (validate(copy)) return copy;
    const valid = Object.keys(tool.inputSchema.properties);
    const problems = (validate.errors ?? []).map((e) =>
      e.keyword === "additionalProperties"
        ? `unknown parameter '${/** @type {any} */ (e.params).additionalProperty}'`
        : `${e.instancePath.replace(/^\//, "").replace(/\//g, ".") || "params"} ${e.message}`,
    );
    throw new BctlError("INVALID_PARAMS", `${name}: ${[...new Set(problems)].join("; ")}`, {
      hint: `Valid parameters: ${valid.join(", ")}.`,
      validParameters: valid,
    });
  }
}
