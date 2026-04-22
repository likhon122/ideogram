import dotenv from "dotenv";

dotenv.config();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return value.toLowerCase() === "true";
}

function num(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid numeric environment variable ${name}: ${value}`);
  }
  return parsed;
}

function jsonHeaders(name: string): Record<string, string> {
  const value = process.env[name]?.trim();
  if (!value) return {};

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const headers: Record<string, string> = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val === "string") {
        headers[key] = val;
      }
    }
    return headers;
  } catch (error) {
    throw new Error(`Invalid JSON in ${name}: ${(error as Error).message}`);
  }
}

export const config = {
  apiBaseUrl: optional("IDEOGRAM_API_BASE_URL", "https://ideogram.ai"),
  userId: required("IDEOGRAM_USER_ID"),
  cookie: required("IDEOGRAM_COOKIE"),
  bearerToken: required("IDEOGRAM_BEARER_TOKEN"),
  org: required("IDEOGRAM_ORG"),
  userAgent: optional(
    "IDEOGRAM_USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  ),
  acceptLanguage: optional(
    "IDEOGRAM_ACCEPT_LANGUAGE",
    "en-US,en;q=0.9,bn;q=0.8",
  ),
  acceptEncoding: optional(
    "IDEOGRAM_ACCEPT_ENCODING",
    "gzip, deflate, br, zstd",
  ),
  secChUa: optional(
    "IDEOGRAM_SEC_CH_UA",
    '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
  ),
  secChUaMobile: optional("IDEOGRAM_SEC_CH_UA_MOBILE", "?0"),
  secChUaPlatform: optional("IDEOGRAM_SEC_CH_UA_PLATFORM", '"Windows"'),
  secFetchDest: optional("IDEOGRAM_SEC_FETCH_DEST", "empty"),
  secFetchMode: optional("IDEOGRAM_SEC_FETCH_MODE", "cors"),
  secFetchSite: optional("IDEOGRAM_SEC_FETCH_SITE", "same-origin"),
  requestPriority: optional("IDEOGRAM_REQUEST_PRIORITY", "u=1, i"),
  amplitudeSessionId: optional("IDEOGRAM_AMPLITUDE_SESSION_ID"),
  enableQuotaPreflight: bool("IDEOGRAM_ENABLE_QUOTA_PREFLIGHT", true),
  enableBrowserFallback: bool("IDEOGRAM_ENABLE_BROWSER_FALLBACK", true),
  browserHeadless: bool("IDEOGRAM_BROWSER_HEADLESS", false),
  browserExecutablePath: optional("IDEOGRAM_BROWSER_EXECUTABLE_PATH"),
  browserWarmupPath: optional(
    "IDEOGRAM_BROWSER_WARMUP_PATH",
    "/library/my-images",
  ),
  browserWarmupTimeoutMs: num("IDEOGRAM_BROWSER_WARMUP_TIMEOUT_MS", 45000),

  modelVersion: optional("IDEOGRAM_MODEL_VERSION", "V_3_1"),
  modelUri: optional("IDEOGRAM_MODEL_URI", "model/V_3_1/version/0"),
  styleType: optional("IDEOGRAM_STYLE_TYPE", "AUTO"),
  categoryId: optional("IDEOGRAM_CATEGORY_ID"),
  useAutopromptOption: optional("IDEOGRAM_USE_AUTOPROMPT_OPTION", "ON") as
    | "ON"
    | "OFF"
    | "AUTO",
  samplingSpeed: num("IDEOGRAM_SAMPLING_SPEED", -2),
  privateGeneration: bool("IDEOGRAM_PRIVATE", true),
  numImages: num("IDEOGRAM_NUM_IMAGES", 1),
  resolutionWidth: num("IDEOGRAM_RESOLUTION_WIDTH", 1312),
  resolutionHeight: num("IDEOGRAM_RESOLUTION_HEIGHT", 736),

  superResModelVersion: optional("IDEOGRAM_SUPER_RES_MODEL_VERSION", "AUTO"),
  superResModelUri: optional(
    "IDEOGRAM_SUPER_RES_MODEL_URI",
    "model/AUTO/version/0",
  ),
  superResUseAutopromptOption: optional(
    "IDEOGRAM_SUPER_RES_USE_AUTOPROMPT_OPTION",
    "OFF",
  ) as "ON" | "OFF" | "AUTO",
  superResInternal: bool("IDEOGRAM_SUPER_RES_INTERNAL", true),
  upscaleFactor: optional("IDEOGRAM_UPSCALE_FACTOR", "X4"),
  upscaleFactor8k: optional("IDEOGRAM_UPSCALE_FACTOR_8K", "X8"),

  pollIntervalMs: num("IDEOGRAM_POLL_INTERVAL_MS", 3000),
  requestTimeoutMs: num("IDEOGRAM_REQUEST_TIMEOUT_MS", 120000),
  maxWaitMs: num("IDEOGRAM_MAX_WAIT_MS", 360000),
  outputDir: optional("IDEOGRAM_OUTPUT_DIR", "outputs"),

  extraHeaders: jsonHeaders("IDEOGRAM_EXTRA_HEADERS_JSON"),
};

export type AppConfig = typeof config;
