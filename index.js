import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { chromium } from "playwright-core";

dotenv.config();

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name, fallback = "") {
  return process.env[name]?.trim() || fallback;
}

function bool(name, fallback) {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  return value.toLowerCase() === "true";
}

function num(name, fallback) {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid numeric environment variable: ${name}=${value}`);
  }
  return parsed;
}

function defaultOutputDir() {
  const downloadsDir = path.join(os.homedir(), "Downloads");
  return path.join(downloadsDir, "ideogram");
}

const config = {
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
  modelVersion: optional("IDEOGRAM_MODEL_VERSION", "V_3_1"),
  modelUri: optional("IDEOGRAM_MODEL_URI", "model/V_3_1/version/0"),
  styleType: optional("IDEOGRAM_STYLE_TYPE", "AUTO"),
  categoryId: optional("IDEOGRAM_CATEGORY_ID"),
  useAutopromptOption: optional("IDEOGRAM_USE_AUTOPROMPT_OPTION", "ON"),
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
  ),
  superResInternal: bool("IDEOGRAM_SUPER_RES_INTERNAL", true),
  upscaleFactor: optional("IDEOGRAM_UPSCALE_FACTOR", "X4"),
  pollIntervalMs: num("IDEOGRAM_POLL_INTERVAL_MS", 3000),
  requestTimeoutMs: num("IDEOGRAM_REQUEST_TIMEOUT_MS", 120000),
  maxWaitMs: num("IDEOGRAM_MAX_WAIT_MS", 360000),
  outputDir: optional("IDEOGRAM_OUTPUT_DIR", defaultOutputDir()),
  enableQuotaPreflight: bool("IDEOGRAM_ENABLE_QUOTA_PREFLIGHT", true),
  enableBrowserFallback: bool("IDEOGRAM_ENABLE_BROWSER_FALLBACK", true),
  browserHeadless: bool("IDEOGRAM_BROWSER_HEADLESS", false),
  browserExecutablePath: optional(
    "IDEOGRAM_BROWSER_EXECUTABLE_PATH",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  ),
  browserWarmupPath: optional(
    "IDEOGRAM_BROWSER_WARMUP_PATH",
    "/library/my-images",
  ),
  browserWarmupTimeoutMs: num("IDEOGRAM_BROWSER_WARMUP_TIMEOUT_MS", 45000),
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildTraceparent(requestId) {
  return `00-${requestId}-${requestId.slice(0, 16)}-00`;
}

function isCloudflareChallenge(text) {
  const lower = String(text || "").toLowerCase();
  return (
    lower.includes("just a moment") ||
    lower.includes("cf_chl") ||
    lower.includes("challenge-platform")
  );
}

function sanitizeFilename(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100) || "image"
  );
}

function contentTypeToExt(contentType) {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("png")) return "png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("webp")) return "webp";
  return "bin";
}

function nowStamp() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${y}${m}${day}_${hh}${mm}${ss}`;
}

function parseCookieHeader(rawCookie, baseUrl) {
  const host = new URL(baseUrl).hostname;
  return rawCookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.includes("="))
    .map((part) => {
      const idx = part.indexOf("=");
      return {
        name: part.slice(0, idx).trim(),
        value: part.slice(idx + 1).trim(),
        domain: host,
        path: "/",
        secure: true,
        httpOnly: false,
      };
    });
}

function buildHeaders(refererPath, isJson) {
  const requestId = crypto.randomBytes(16).toString("hex");
  return {
    accept: "*/*",
    "accept-encoding": config.acceptEncoding,
    "accept-language": config.acceptLanguage,
    ...(isJson ? { "content-type": "application/json" } : {}),
    authorization: `Bearer ${config.bearerToken}`,
    cookie: config.cookie,
    origin: config.apiBaseUrl,
    referer: `${config.apiBaseUrl}${refererPath}`,
    priority: config.requestPriority,
    "sec-ch-ua": config.secChUa,
    "sec-ch-ua-mobile": config.secChUaMobile,
    "sec-ch-ua-platform": config.secChUaPlatform,
    "sec-fetch-dest": config.secFetchDest,
    "sec-fetch-mode": config.secFetchMode,
    "sec-fetch-site": config.secFetchSite,
    traceparent: buildTraceparent(requestId),
    "user-agent": config.userAgent,
    "x-amplitude-session-id":
      config.amplitudeSessionId || Date.now().toString(),
    "x-ideo-org": config.org,
    "x-request-id": requestId,
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

let browserState = null;

async function ensureBrowserPage() {
  if (browserState?.page) {
    return browserState.page;
  }

  const browser = await chromium.launch({
    executablePath: config.browserExecutablePath,
    headless: config.browserHeadless,
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const context = await browser.newContext({
    userAgent: config.userAgent,
    extraHTTPHeaders: {
      "accept-language": config.acceptLanguage,
    },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  await context.addCookies(parseCookieHeader(config.cookie, config.apiBaseUrl));

  const page = await context.newPage();
  await page.goto(`${config.apiBaseUrl}${config.browserWarmupPath}`, {
    timeout: config.browserWarmupTimeoutMs,
    waitUntil: "domcontentloaded",
  });
  await page
    .waitForLoadState("networkidle", { timeout: 10000 })
    .catch(() => undefined);

  browserState = { browser, context, page };
  return page;
}

async function closeBrowserIfAny() {
  if (!browserState?.browser) return;
  await browserState.browser.close();
  browserState = null;
}

function pickBrowserHeaders(headers) {
  return {
    accept: headers.accept,
    ...(headers["content-type"]
      ? { "content-type": headers["content-type"] }
      : {}),
    authorization: headers.authorization,
    "x-ideo-org": headers["x-ideo-org"],
    "x-amplitude-session-id": headers["x-amplitude-session-id"],
    "x-request-id": headers["x-request-id"],
    traceparent: headers.traceparent,
  };
}

async function browserJsonRequest(url, method, body, headers) {
  const page = await ensureBrowserPage();
  const result = await page.evaluate(
    async ({ requestUrl, requestMethod, requestBody, requestHeaders }) => {
      const init = {
        method: requestMethod,
        credentials: "include",
        headers: requestHeaders,
      };

      if (requestBody !== undefined) {
        init.body = JSON.stringify(requestBody);
      }

      const response = await fetch(requestUrl, init);
      return {
        status: response.status,
        statusText: response.statusText,
        text: await response.text(),
        xRequestId: response.headers.get("x-request-id") || "",
        traceparent: response.headers.get("traceparent") || "",
      };
    },
    {
      requestUrl: url,
      requestMethod: method,
      requestBody: body,
      requestHeaders: pickBrowserHeaders(headers),
    },
  );

  if (result.status < 200 || result.status >= 300) {
    throw new Error(
      `Browser fallback failed (${result.status} ${result.statusText}): ${result.text.slice(0, 400)}`,
    );
  }

  try {
    return JSON.parse(result.text);
  } catch {
    throw new Error(`Expected JSON but got: ${result.text.slice(0, 300)}`);
  }
}

async function browserBinaryRequest(url, headers) {
  const page = await ensureBrowserPage();
  const result = await page.evaluate(
    async ({ requestUrl, requestHeaders }) => {
      const response = await fetch(requestUrl, {
        method: "GET",
        credentials: "include",
        headers: requestHeaders,
      });

      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        const slice = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode(...slice);
      }

      return {
        status: response.status,
        statusText: response.statusText,
        base64: btoa(binary),
        contentType:
          response.headers.get("content-type") || "application/octet-stream",
      };
    },
    {
      requestUrl: url,
      requestHeaders: pickBrowserHeaders(headers),
    },
  );

  if (result.status < 200 || result.status >= 300) {
    throw new Error(
      `Browser binary fallback failed (${result.status} ${result.statusText}).`,
    );
  }

  return {
    bytes: Buffer.from(result.base64, "base64"),
    contentType: result.contentType,
  };
}

async function requestJson(pathname, method, body, refererPath) {
  const url = `${config.apiBaseUrl}${pathname}`;
  const headers = buildHeaders(refererPath, body !== undefined);

  const response = await fetchWithTimeout(
    url,
    {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    config.requestTimeoutMs,
  );

  const text = await response.text();

  if (response.ok) {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(
        `Invalid JSON response from ${pathname}: ${text.slice(0, 300)}`,
      );
    }
  }

  if (
    response.status === 403 &&
    config.enableBrowserFallback &&
    isCloudflareChallenge(text)
  ) {
    console.log(`403 on ${pathname}. Retrying in browser context...`);
    return browserJsonRequest(url, method, body, headers);
  }

  throw new Error(
    `Request failed (${response.status} ${response.statusText}) ${pathname}: ${text.slice(0, 500)}`,
  );
}

async function requestBinary(pathname, refererPath) {
  const url = `${config.apiBaseUrl}${pathname}`;
  const headers = buildHeaders(refererPath, false);

  const response = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers,
    },
    config.requestTimeoutMs,
  );

  const arrayBuffer = await response.arrayBuffer();
  const bytes = Buffer.from(arrayBuffer);

  if (response.ok) {
    return {
      bytes,
      contentType:
        response.headers.get("content-type") || "application/octet-stream",
    };
  }

  const text = bytes.toString("utf8");
  if (
    response.status === 403 &&
    config.enableBrowserFallback &&
    isCloudflareChallenge(text)
  ) {
    console.log(
      `403 on ${pathname}. Retrying binary download in browser context...`,
    );
    return browserBinaryRequest(url, headers);
  }

  throw new Error(
    `Binary request failed (${response.status} ${response.statusText}) ${pathname}: ${text.slice(0, 500)}`,
  );
}

async function waitUntilCompleted(requestId, refererPath, label) {
  const started = Date.now();

  while (Date.now() - started < config.maxWaitMs) {
    const data = await requestJson(
      "/api/gallery/retrieve-requests",
      "POST",
      { request_ids: [requestId] },
      refererPath,
    );

    const req = data?.sampling_requests?.[0];
    if (!req) {
      throw new Error(
        `No sampling request returned for request_id=${requestId}`,
      );
    }

    if (req.is_errored) {
      throw new Error(`${label} failed for request_id=${requestId}`);
    }

    const pct = req.completion_percentage ?? 0;
    console.log(`${label} progress: ${pct}%`);

    if (
      req.is_completed &&
      Array.isArray(req.responses) &&
      req.responses.length > 0
    ) {
      return req;
    }

    await sleep(config.pollIntervalMs);
  }

  throw new Error(`${label} timed out after ${config.maxWaitMs} ms`);
}

function getPromptFromCli() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--prompt" && args[i + 1]) {
      return args[i + 1].trim();
    }
  }
  return (
    process.env.IDEOGRAM_PROMPT?.trim() ||
    "A professional studio product photo of a premium perfume bottle, dramatic rim lighting, ultra detailed"
  );
}

async function main() {
  const prompt = getPromptFromCli();
  const runDir = path.resolve(config.outputDir, nowStamp());

  await fs.mkdir(runDir, { recursive: true });

  console.log("Prompt:", prompt);
  console.log("Run directory:", runDir);

  if (config.enableQuotaPreflight) {
    const quotaQuery =
      `/api/account/user_task_quota_stats?modelVersion=${encodeURIComponent(config.modelVersion)}` +
      `&samplingSpeed=QUALITY&requestAction=GENERATE&userTaskType=DEFAULT` +
      `&modelUri=${encodeURIComponent(config.modelUri)}`;

    const quota = await requestJson(
      quotaQuery,
      "GET",
      undefined,
      "/library/my-images",
    );
    console.log(
      "Quota preflight allowed_to_generate:",
      quota.allowed_to_generate,
    );
  }

  const generatePayload = {
    prompt,
    user_id: config.userId,
    private: config.privateGeneration,
    model_version: config.modelVersion,
    model_uri: config.modelUri,
    use_autoprompt_option: config.useAutopromptOption,
    sampling_speed: config.samplingSpeed,
    character_reference_parents: [],
    product_reference_parents: [],
    resolution: {
      width: config.resolutionWidth,
      height: config.resolutionHeight,
    },
    num_images: config.numImages,
    style_type: config.styleType,
    ...(config.categoryId ? { category_id: config.categoryId } : {}),
  };

  console.log("Submitting generate request...");
  const generated = await requestJson(
    "/api/images/sample",
    "POST",
    generatePayload,
    "/library/my-images",
  );

  const initialRequestId = generated.request_id;
  if (!initialRequestId) {
    throw new Error("Generate response missing request_id");
  }

  console.log("Initial request_id:", initialRequestId);

  const initialStatus = await waitUntilCompleted(
    initialRequestId,
    "/library/my-images",
    "Initial generation",
  );

  const initialResponse = initialStatus.responses?.[0];
  if (!initialResponse?.response_id) {
    throw new Error("Initial generation missing response_id");
  }

  const superResPayload = {
    prompt: initialResponse.prompt || prompt,
    user_id: config.userId,
    private: config.privateGeneration,
    model_version: config.superResModelVersion,
    model_uri: config.superResModelUri,
    use_autoprompt_option: config.superResUseAutopromptOption,
    sampling_speed: config.samplingSpeed,
    parent: {
      request_id: initialRequestId,
      response_id: initialResponse.response_id,
      weight: 100,
      type: "SUPER_RES",
    },
    upscale_factor: config.upscaleFactor,
    resolution: {
      width: initialStatus.width ?? config.resolutionWidth,
      height: initialStatus.height ?? config.resolutionHeight,
    },
    num_images: 1,
    style_type: config.styleType,
    internal: config.superResInternal,
    ...(config.categoryId ? { category_id: config.categoryId } : {}),
  };

  console.log("Submitting super-res request...");
  const superRes = await requestJson(
    "/api/images/sample",
    "POST",
    superResPayload,
    `/g/${initialRequestId}/0`,
  );

  const superResRequestId = superRes.request_id;
  if (!superResRequestId) {
    throw new Error("Super-res response missing request_id");
  }

  console.log("Super-res request_id:", superResRequestId);

  const superStatus = await waitUntilCompleted(
    superResRequestId,
    `/g/${initialRequestId}/0`,
    "Super-res",
  );

  const superResponse = superStatus.responses?.[0];
  if (!superResponse?.response_id) {
    throw new Error("Super-res missing response_id");
  }

  console.log("Downloading 4K image...");
  const download = await requestBinary(
    `/api/download/response/${superResponse.response_id}/image?resolution=4K`,
    `/g/${initialRequestId}/0`,
  );

  const ext = contentTypeToExt(download.contentType);
  const imageName = `001_${sanitizeFilename(prompt)}_4k.${ext}`;
  const outputPath = path.join(runDir, imageName);
  await fs.writeFile(outputPath, download.bytes);

  const report = {
    createdAt: new Date().toISOString(),
    prompt,
    initialRequestId,
    initialResponseId: initialResponse.response_id,
    superResRequestId,
    superResResponseId: superResponse.response_id,
    outputPath,
  };

  await fs.writeFile(
    path.join(runDir, "run-report.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );

  console.log("Image saved:", outputPath);
}

main()
  .catch((error) => {
    console.error(
      "Pipeline failed:",
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeBrowserIfAny();
  });
