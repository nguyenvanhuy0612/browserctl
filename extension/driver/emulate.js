// Emulation and Device Controller for browserctl.
// Adheres strictly to docs/spec/00-architecture-overview.md and docs/spec/02-driver-and-cdp.md.

import { sendCdpCommand } from "./session.js";

export const DEVICE_PRESETS = Object.freeze({
  "iphone-14": {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1",
  },
  "iphone-14-pro-max": {
    width: 430,
    height: 932,
    deviceScaleFactor: 3,
    mobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1",
  },
  "pixel-7": {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36",
  },
  ipad: {
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    mobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1",
  },
  desktop: {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
    hasTouch: false,
    userAgent: "",
  },
});

/**
 * Overrides viewport metrics (width, height, deviceScaleFactor, mobile).
 * @param {number} tabId
 * @param {object} metrics
 * @returns {Promise<any>}
 */
export async function setDeviceMetrics(tabId, metrics) {
  return sendCdpCommand(tabId, "Emulation.setDeviceMetricsOverride", {
    width: Math.round(metrics.width || 0),
    height: Math.round(metrics.height || 0),
    deviceScaleFactor: metrics.deviceScaleFactor ?? 1,
    mobile: Boolean(metrics.mobile),
  });
}

/**
 * Overrides User-Agent header and navigator properties.
 * @param {number} tabId
 * @param {string} userAgent
 * @returns {Promise<any>}
 */
export async function setUserAgent(tabId, userAgent) {
  return sendCdpCommand(tabId, "Emulation.setUserAgentOverride", {
    userAgent: userAgent || "",
  });
}

/**
 * Enables or disables touch emulation.
 * @param {number} tabId
 * @param {boolean} enabled
 * @returns {Promise<any>}
 */
export async function setTouchEmulation(tabId, enabled) {
  return sendCdpCommand(tabId, "Emulation.setTouchEmulationEnabled", {
    enabled: Boolean(enabled),
  });
}

/**
 * Emulates media features like prefers-color-scheme.
 * @param {number} tabId
 * @param {object} options
 * @param {string} [options.colorScheme] - "dark", "light", or "none"
 * @param {string} [options.media="page"] - media type
 * @returns {Promise<any>}
 */
export async function setEmulatedMedia(tabId, { colorScheme, media = "page" } = {}) {
  const features = [];
  if (colorScheme && colorScheme !== "none") {
    features.push({ name: "prefers-color-scheme", value: colorScheme });
  }
  return sendCdpCommand(tabId, "Emulation.setEmulatedMedia", {
    media: media || "",
    features,
  });
}

/**
 * Overrides geolocation coordinates.
 * @param {number} tabId
 * @param {object} coords
 * @param {number} coords.latitude
 * @param {number} coords.longitude
 * @param {number} [coords.accuracy=1]
 * @returns {Promise<any>}
 */
export async function setGeolocationOverride(tabId, { latitude, longitude, accuracy = 1 }) {
  return sendCdpCommand(tabId, "Emulation.setGeolocationOverride", {
    latitude: Number(latitude),
    longitude: Number(longitude),
    accuracy: Number(accuracy),
  });
}

/**
 * Simulates network throttling or offline mode.
 * @param {number} tabId
 * @param {object} conditions
 * @param {boolean} [conditions.offline=false]
 * @param {number} [conditions.latency=0]
 * @param {number} [conditions.downloadThroughput=-1]
 * @param {number} [conditions.uploadThroughput=-1]
 * @returns {Promise<any>}
 */
export async function setNetworkConditions(
  tabId,
  { offline = false, latency = 0, downloadThroughput = -1, uploadThroughput = -1 } = {}
) {
  return sendCdpCommand(tabId, "Network.emulateNetworkConditions", {
    offline: Boolean(offline),
    latency: Number(latency) || 0,
    downloadThroughput: Number(downloadThroughput),
    uploadThroughput: Number(uploadThroughput),
  });
}

/**
 * Resets all device metrics, user agent, media, geolocation, and network overrides.
 * @param {number} tabId
 * @returns {Promise<{ ok: boolean, result: { cleared: boolean } }>}
 */
export async function clearEmulation(tabId) {
  await sendCdpCommand(tabId, "Emulation.clearDeviceMetricsOverride");
  await sendCdpCommand(tabId, "Emulation.setUserAgentOverride", { userAgent: "" });
  await sendCdpCommand(tabId, "Emulation.setTouchEmulationEnabled", { enabled: false });
  await sendCdpCommand(tabId, "Emulation.setEmulatedMedia", { media: "" });
  try {
    await sendCdpCommand(tabId, "Emulation.clearGeolocationOverride");
  } catch {}
  await setNetworkConditions(tabId, {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  return { ok: true, result: { cleared: true } };
}

/**
 * High-level emulation coordinator matching handleCdp("emulate") contract.
 * @param {number} tabId
 * @param {object} params
 * @returns {Promise<any>}
 */
export async function emulate(tabId, params = {}) {
  if (params.clear || params.off) {
    return clearEmulation(tabId);
  }

  let preset = null;
  if (params.device && DEVICE_PRESETS[params.device.toLowerCase()]) {
    preset = DEVICE_PRESETS[params.device.toLowerCase()];
  }

  const width = params.viewport?.width ?? preset?.width;
  const height = params.viewport?.height ?? preset?.height;
  const deviceScaleFactor = params.viewport?.deviceScaleFactor ?? preset?.deviceScaleFactor ?? 1;
  const mobile = params.viewport?.mobile ?? preset?.mobile ?? false;
  const hasTouch = params.viewport?.hasTouch ?? preset?.hasTouch ?? false;
  const userAgent = params.userAgent ?? preset?.userAgent;

  if (width && height) {
    await setDeviceMetrics(tabId, { width, height, deviceScaleFactor, mobile });
  }
  if (hasTouch !== undefined) {
    await setTouchEmulation(tabId, Boolean(hasTouch));
  }
  if (userAgent) {
    await setUserAgent(tabId, userAgent);
  }
  if (params.colorScheme || params.color_scheme) {
    const cs = params.colorScheme || params.color_scheme;
    await setEmulatedMedia(tabId, { colorScheme: cs, media: "page" });
  }
  if (params.geolocation) {
    await setGeolocationOverride(tabId, {
      latitude: params.geolocation.latitude,
      longitude: params.geolocation.longitude,
      accuracy: params.geolocation.accuracy ?? 1,
    });
  }
  if (params.offline !== undefined) {
    await setNetworkConditions(tabId, {
      offline: Boolean(params.offline),
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  }

  return {
    ok: true,
    result: {
      emulating: {
        device: params.device || null,
        viewport: width && height ? { width, height, deviceScaleFactor, mobile } : null,
        touch: hasTouch,
        colorScheme: params.colorScheme || params.color_scheme || null,
        geolocation: Boolean(params.geolocation),
        offline: params.offline ?? false,
      },
    },
  };
}

export const emulateDevice = emulate;
export const setEmulation = emulate;
export const clear = clearEmulation;
