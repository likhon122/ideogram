import { existsSync } from "node:fs";
import { URL } from "node:url";
import { config, type AppConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import type { DownloadProgress } from "./ideogramClient.js";

type PlaywrightModule = typeof import("playwright-core");

type HeaderMap = Record<string, string>;

function parseCookieHeader(
  rawCookie: string,
  originUrl: string,
): Array<{
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
}> {
  const host = new URL(originUrl).hostname;
  return rawCookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part.includes("="))
    .map((part) => {
      const eq = part.indexOf("=");
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      return {
        name,
        value,
        domain: host,
        path: "/",
        secure: true,
        httpOnly: false,
      };
    });
}

function findBrowserExecutable(explicitPath: string): string {
  const candidates = [
    explicitPath,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ].filter((x) => x !== "");

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "No local browser executable found. Set IDEOGRAM_BROWSER_EXECUTABLE_PATH to your Chrome/Edge executable.",
  );
}

function cleanHeadersForBrowser(headers: HeaderMap): HeaderMap {
  const allowed = new Set([
    "accept",
    "content-type",
    "authorization",
    "x-ideo-org",
    "x-amplitude-session-id",
    "x-request-id",
    "traceparent",
  ]);

  const out: HeaderMap = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase();
    if (allowed.has(normalized) && value !== "") {
      out[key] = value;
    }
  }
  return out;
}

function isCloudflareBlockHtml(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("just a moment") ||
    normalized.includes("cf_chl") ||
    normalized.includes("challenge-platform")
  );
}

export class BrowserTransport {
  private playwright?: PlaywrightModule;
  private browser?: import("playwright-core").Browser;
  private context?: import("playwright-core").BrowserContext;
  private page?: import("playwright-core").Page;
  private initialized = false;

  constructor(private readonly cfg: AppConfig = config) {}

  private async waitForChallengeClear(): Promise<boolean> {
    if (!this.page) {
      return false;
    }

    const deadline = Date.now() + this.cfg.browserWarmupTimeoutMs;
    while (Date.now() < deadline) {
      const title = (await this.page.title()).toLowerCase();
      const url = this.page.url().toLowerCase();
      const inChallenge =
        title.includes("just a moment") || url.includes("/cdn-cgi/challenge");

      if (!inChallenge) {
        return true;
      }

      await this.page.waitForTimeout(1500);
    }

    return false;
  }

  private async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.playwright = await import("playwright-core");
    const executablePath = findBrowserExecutable(
      this.cfg.browserExecutablePath,
    );

    this.browser = await this.playwright.chromium.launch({
      executablePath,
      headless: this.cfg.browserHeadless,
      ignoreDefaultArgs: ["--enable-automation"],
      args: ["--disable-blink-features=AutomationControlled"],
    });

    this.context = await this.browser.newContext({
      userAgent: this.cfg.userAgent,
      extraHTTPHeaders: {
        "accept-language": this.cfg.acceptLanguage,
      },
    });

    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined,
      });
    });

    if (this.cfg.cookie) {
      await this.context.addCookies(
        parseCookieHeader(this.cfg.cookie, this.cfg.apiBaseUrl),
      );
    }

    this.page = await this.context.newPage();
    await this.page.goto(
      `${this.cfg.apiBaseUrl}${this.cfg.browserWarmupPath}`,
      {
        timeout: this.cfg.browserWarmupTimeoutMs,
        waitUntil: "domcontentloaded",
      },
    );

    const cleared = await this.waitForChallengeClear();
    if (!cleared) {
      logger.warn(
        "Browser warmup is still on Cloudflare challenge. If a browser window opened, complete challenge and rerun command.",
      );
    }

    this.initialized = true;
  }

  async postJson<T>(
    path: string,
    payload: unknown,
    headers: HeaderMap,
  ): Promise<T> {
    await this.init();
    if (!this.page) {
      throw new Error("Browser page not initialized.");
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.page.evaluate(
        async ({ url, requestHeaders, requestBody }) => {
          const res = await fetch(url, {
            method: "POST",
            headers: requestHeaders,
            credentials: "include",
            body: JSON.stringify(requestBody),
          });

          return {
            ok: res.ok,
            status: res.status,
            text: await res.text(),
          };
        },
        {
          url: `${this.cfg.apiBaseUrl}${path}`,
          requestHeaders: cleanHeadersForBrowser(headers),
          requestBody: payload,
        },
      );

      if (response.ok) {
        return JSON.parse(response.text) as T;
      }

      if (
        response.status === 403 &&
        isCloudflareBlockHtml(response.text) &&
        attempt === 0
      ) {
        const cleared = await this.waitForChallengeClear();
        if (cleared) {
          continue;
        }
      }

      if (response.status === 403 && isCloudflareBlockHtml(response.text)) {
        throw new Error(
          "Cloudflare challenge still active in browser session. Solve challenge in opened browser and retry.",
        );
      }

      throw new Error(
        `Browser fallback POST failed: ${response.status} ${response.text.slice(0, 300)}`,
      );
    }

    throw new Error("Browser fallback POST exhausted retries.");
  }

  async postMultipart<T>(
    path: string,
    fileBase64: string,
    fileName: string,
    mimeType: string,
    additionalData: Record<string, string>,
    headers: HeaderMap,
  ): Promise<T> {
    await this.init();
    if (!this.page) {
      throw new Error("Browser page not initialized.");
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.page.evaluate(
        async ({ url, requestHeaders, base64, filename, mime, formFields }) => {
          // Convert base64 to Blob
          const bstr = atob(base64);
          let n = bstr.length;
          const u8arr = new Uint8Array(n);
          while (n--) {
            u8arr[n] = bstr.charCodeAt(n);
          }
          const blob = new Blob([u8arr], { type: mime });

          const formData = new FormData();
          formData.append("file", blob, filename);
          for (const [k, v] of Object.entries(formFields)) {
            formData.append(k, v);
          }

          const fetchHeaders = new Headers(requestHeaders);
          fetchHeaders.delete("content-type");

          const res = await fetch(url, {
            method: "POST",
            headers: fetchHeaders,
            credentials: "include",
            body: formData,
          });

          return {
            ok: res.ok,
            status: res.status,
            text: await res.text(),
          };
        },
        {
          url: `${this.cfg.apiBaseUrl}${path}`,
          requestHeaders: cleanHeadersForBrowser(headers),
          base64: fileBase64,
          filename: fileName,
          mime: mimeType,
          formFields: additionalData,
        },
      );

      if (response.ok) {
        return JSON.parse(response.text) as T;
      }

      if (
        response.status === 403 &&
        isCloudflareBlockHtml(response.text) &&
        attempt === 0
      ) {
        const cleared = await this.waitForChallengeClear();
        if (cleared) {
          continue;
        }
      }

      if (response.status === 403 && isCloudflareBlockHtml(response.text)) {
        throw new Error(
          "Cloudflare challenge still active in browser session. Solve challenge in opened browser and retry.",
        );
      }

      throw new Error(
        `Browser fallback POST (multipart) failed: ${response.status} ${response.text.slice(0, 300)}`,
      );
    }

    throw new Error("Browser fallback POST (multipart) exhausted retries.");
  }

  async getJson<T>(path: string, headers: HeaderMap): Promise<T> {
    await this.init();
    if (!this.page) {
      throw new Error("Browser page not initialized.");
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.page.evaluate(
        async ({ url, requestHeaders }) => {
          const res = await fetch(url, {
            method: "GET",
            headers: requestHeaders,
            credentials: "include",
          });

          return {
            ok: res.ok,
            status: res.status,
            text: await res.text(),
          };
        },
        {
          url: `${this.cfg.apiBaseUrl}${path}`,
          requestHeaders: cleanHeadersForBrowser(headers),
        },
      );

      if (response.ok) {
        return JSON.parse(response.text) as T;
      }

      if (
        response.status === 403 &&
        isCloudflareBlockHtml(response.text) &&
        attempt === 0
      ) {
        const cleared = await this.waitForChallengeClear();
        if (cleared) {
          continue;
        }
      }

      if (response.status === 403 && isCloudflareBlockHtml(response.text)) {
        throw new Error(
          "Cloudflare challenge still active in browser session. Solve challenge in opened browser and retry.",
        );
      }

      throw new Error(
        `Browser fallback GET failed: ${response.status} ${response.text.slice(0, 300)}`,
      );
    }

    throw new Error("Browser fallback GET exhausted retries.");
  }

  async getBinary(
    path: string,
    headers: HeaderMap,
    onProgress?: (progress: DownloadProgress) => void,
  ): Promise<{ bytes: Buffer; contentType: string }> {
    await this.init();
    if (!this.page) {
      throw new Error("Browser page not initialized.");
    }

    const progressPrefix = "__IDEOGRAM_DL_PROGRESS__";
    const onConsole = (msg: import("playwright-core").ConsoleMessage): void => {
      if (!onProgress) {
        return;
      }

      const text = msg.text();
      if (!text.startsWith(progressPrefix)) {
        return;
      }

      const payload = text.slice(progressPrefix.length);
      const parts = payload.split("/");
      const downloaded = Number(parts[0]);
      const total = Number(parts[1]);

      if (Number.isNaN(downloaded) || Number.isNaN(total) || total <= 0) {
        return;
      }

      const percent = Math.min(100, Math.floor((downloaded / total) * 100));
      onProgress({
        downloadedBytes: downloaded,
        totalBytes: total,
        percent,
      });
    };

    this.page.on("console", onConsole);

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await this.page.evaluate(
          async ({ url, requestHeaders, progressTag }) => {
            const res = await fetch(url, {
              method: "GET",
              headers: requestHeaders,
              credentials: "include",
            });

            const contentType =
              res.headers.get("content-type") || "application/octet-stream";

            if (!res.ok) {
              return {
                ok: false,
                status: res.status,
                contentType,
                text: await res.text(),
                base64: "",
              };
            }

            const total = Number(res.headers.get("content-length") || "0");
            if (total > 0) {
              console.log(`${progressTag}0/${total}`);
            }

            let bytes: Uint8Array;
            if (res.body && total > 0) {
              const reader = res.body.getReader();
              const chunks: Uint8Array[] = [];
              let received = 0;
              let lastProgressBucket = -1;

              while (true) {
                const { done, value } = await reader.read();
                if (done) {
                  break;
                }

                if (!value) {
                  continue;
                }

                chunks.push(value);
                received += value.length;
                const percent = Math.floor((received / total) * 100);
                const progressBucket = Math.floor(percent / 5);
                if (progressBucket > lastProgressBucket || percent >= 100) {
                  lastProgressBucket = progressBucket;
                  console.log(`${progressTag}${received}/${total}`);
                }
              }

              bytes = new Uint8Array(received);
              let offset = 0;
              for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.length;
              }
            } else {
              bytes = new Uint8Array(await res.arrayBuffer());
            }

            let binary = "";
            const chunk = 0x8000;
            for (let i = 0; i < bytes.length; i += chunk) {
              binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
            }

            return {
              ok: true,
              status: res.status,
              contentType,
              text: "",
              base64: btoa(binary),
            };
          },
          {
            url: `${this.cfg.apiBaseUrl}${path}`,
            requestHeaders: cleanHeadersForBrowser(headers),
            progressTag: progressPrefix,
          },
        );

        if (response.ok) {
          return {
            bytes: Buffer.from(response.base64, "base64"),
            contentType: response.contentType,
          };
        }

        if (
          response.status === 403 &&
          isCloudflareBlockHtml(response.text) &&
          attempt === 0
        ) {
          const cleared = await this.waitForChallengeClear();
          if (cleared) {
            continue;
          }
        }

        if (response.status === 403 && isCloudflareBlockHtml(response.text)) {
          throw new Error(
            "Cloudflare challenge still active in browser session. Solve challenge in opened browser and retry.",
          );
        }

        throw new Error(
          `Browser fallback binary GET failed: ${response.status} ${response.text.slice(0, 300)}`,
        );
      }

      throw new Error("Browser fallback binary GET exhausted retries.");
    } finally {
      this.page.off("console", onConsole);
    }
  }
}
