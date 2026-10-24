// Emulation Tools Domain for browserctl.
// Adheres strictly to docs/spec/00-architecture-overview.md and docs/spec/03-tools-and-handlers.md.

/**
 * Handles device, viewport, geolocation, media, and network emulation.
 */
export async function handleEmulate(params = {}, ctx) {
  const tabId = ctx?.resolveTabId(params);
  if (ctx?.driver) {
    return await ctx.driver.emulate(tabId, params);
  }
  return { ok: true, result: { emulated: true, preset: params?.preset || "custom", tabId } };
}

export const emulateTools = [
  {
    name: "browser_emulate",
    profile: "advanced",
    aliases: ["emulate", "emulate_device", "set_emulation"],
    handler: handleEmulate,
  },
];
