import axios, { AxiosError, AxiosInstance } from "axios";
import { randomUUID } from "node:crypto";
import { config, type AppConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { BrowserTransport } from "./browserTransport.js";
import {
  type DownloadResult,
  type GenerateImagePayload,
  type RetrieveRequestsResponse,
  type SampleResponse,
  type SuperResPayload,
} from "../types/ideogram.js";

export type DownloadResolution = "4K" | "8K";
export type DownloadProgress = {
  downloadedBytes: number;
  totalBytes?: number;
  percent?: number;
};

function compact<T extends Record<string, string>>(
  obj: T,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== ""),
  );
}

export class IdeogramClient {
  private readonly http: AxiosInstance;
  private readonly cfg: AppConfig;
  private readonly browserTransport: BrowserTransport;
  private fallbackNoticeShown = false;

  constructor(appConfig = config) {
    this.cfg = appConfig;
    this.browserTransport = new BrowserTransport(this.cfg);
    this.http = axios.create({
      baseURL: this.cfg.apiBaseUrl,
      timeout: this.cfg.requestTimeoutMs,
      validateStatus: (status) => status >= 200 && status < 300,
    });
  }

  private buildTraceparent(requestId: string): string {
    const spanId = requestId.slice(0, 16);
    return `00-${requestId}-${spanId}-00`;
  }

  private headers(refererPath: string, isJson = true): Record<string, string> {
    const requestId = randomUUID().replace(/-/g, "");
    const amplitudeSessionId =
      this.cfg.amplitudeSessionId || Date.now().toString();

    const authHeaders = compact({
      cookie: this.cfg.cookie,
      authorization: this.cfg.bearerToken
        ? `Bearer ${this.cfg.bearerToken}`
        : "",
      "x-ideo-org": this.cfg.org,
      "x-request-id": requestId,
      "x-amplitude-session-id": amplitudeSessionId,
      traceparent: this.buildTraceparent(requestId),
    });

    return {
      accept: "*/*",
      "accept-encoding": this.cfg.acceptEncoding,
      "accept-language": this.cfg.acceptLanguage,
      ...(isJson ? { "content-type": "application/json" } : {}),
      origin: this.cfg.apiBaseUrl,
      referer: `${this.cfg.apiBaseUrl}${refererPath}`,
      "user-agent": this.cfg.userAgent,
      priority: this.cfg.requestPriority,
      "sec-ch-ua": this.cfg.secChUa,
      "sec-ch-ua-mobile": this.cfg.secChUaMobile,
      "sec-ch-ua-platform": this.cfg.secChUaPlatform,
      "sec-fetch-dest": this.cfg.secFetchDest,
      "sec-fetch-mode": this.cfg.secFetchMode,
      "sec-fetch-site": this.cfg.secFetchSite,
      ...authHeaders,
      ...this.cfg.extraHeaders,
    };
  }

  private shouldUseBrowserFallback(error: unknown): error is AxiosError {
    if (!this.cfg.enableBrowserFallback) {
      return false;
    }

    if (!axios.isAxiosError(error)) {
      return false;
    }

    const status = error.response?.status;
    return status === 403;
  }

  private warnFallbackOnce(): void {
    if (this.fallbackNoticeShown) {
      return;
    }

    this.fallbackNoticeShown = true;
    logger.warn(
      "Cloudflare challenge detected; switching blocked requests to browser fallback.",
    );
  }

  private async withBrowserFallbackPost<T>(
    path: string,
    payload: unknown,
    refererPath: string,
    originalError: unknown,
  ): Promise<T> {
    if (!this.shouldUseBrowserFallback(originalError)) {
      throw originalError;
    }

    this.warnFallbackOnce();
    const headers = this.headers(refererPath, true);
    return this.browserTransport.postJson<T>(path, payload, headers);
  }

  private async withBrowserFallbackGetJson<T>(
    path: string,
    refererPath: string,
    originalError: unknown,
  ): Promise<T> {
    if (!this.shouldUseBrowserFallback(originalError)) {
      throw originalError;
    }

    this.warnFallbackOnce();
    const headers = this.headers(refererPath, false);
    return this.browserTransport.getJson<T>(path, headers);
  }

  private async withBrowserFallbackGetBinary(
    path: string,
    refererPath: string,
    originalError: unknown,
    onProgress?: (progress: DownloadProgress) => void,
  ): Promise<DownloadResult> {
    if (!this.shouldUseBrowserFallback(originalError)) {
      throw originalError;
    }

    this.warnFallbackOnce();
    const headers = this.headers(refererPath, false);
    return this.browserTransport.getBinary(path, headers, onProgress);
  }

  async checkQuotaStats(): Promise<void> {
    const query =
      `/api/account/user_task_quota_stats` +
      `?modelVersion=${encodeURIComponent(this.cfg.modelVersion)}` +
      `&samplingSpeed=QUALITY` +
      `&requestAction=GENERATE` +
      `&userTaskType=DEFAULT` +
      `&modelUri=${encodeURIComponent(this.cfg.modelUri)}`;

    try {
      await this.http.get(query, {
        headers: this.headers("/library/my-images", false),
      });
    } catch (error) {
      await this.withBrowserFallbackGetJson<unknown>(
        query,
        "/library/my-images",
        error,
      );
    }
  }

  async submitGenerate(payload: GenerateImagePayload): Promise<SampleResponse> {
    const path = "/api/images/sample";
    const refererPath = "/library/my-images";

    try {
      const { data } = await this.http.post<SampleResponse>(path, payload, {
        headers: this.headers(refererPath, true),
      });
      return data;
    } catch (error) {
      return this.withBrowserFallbackPost<SampleResponse>(
        path,
        payload,
        refererPath,
        error,
      );
    }
  }

  async submitSuperRes(
    parentRequestId: string,
    payload: SuperResPayload,
  ): Promise<SampleResponse> {
    const path = "/api/images/sample";
    const refererPath = `/g/${parentRequestId}/0`;

    try {
      const { data } = await this.http.post<SampleResponse>(path, payload, {
        headers: this.headers(refererPath, true),
      });
      return data;
    } catch (error) {
      return this.withBrowserFallbackPost<SampleResponse>(
        path,
        payload,
        refererPath,
        error,
      );
    }
  }

  async retrieveRequests(
    requestIds: string[],
    refererPath = "/library/my-images",
  ): Promise<RetrieveRequestsResponse> {
    const path = "/api/gallery/retrieve-requests";
    const payload = { request_ids: requestIds };

    try {
      const { data } = await this.http.post<RetrieveRequestsResponse>(
        path,
        payload,
        { headers: this.headers(refererPath, true) },
      );
      return data;
    } catch (error) {
      return this.withBrowserFallbackPost<RetrieveRequestsResponse>(
        path,
        payload,
        refererPath,
        error,
      );
    }
  }

  async downloadImage(
    responseId: string,
    parentRequestId: string,
    resolution: DownloadResolution,
    onProgress?: (progress: DownloadProgress) => void,
  ): Promise<DownloadResult> {
    const path = `/api/download/response/${responseId}/image?resolution=${resolution}`;
    const refererPath = `/g/${parentRequestId}/0`;

    try {
      const { data, headers } = await this.http.get<NodeJS.ReadableStream>(path, {
        headers: this.headers(refererPath, false),
        responseType: "stream",
      });

      const totalHeader = String(headers["content-length"] || "").trim();
      const totalBytes = totalHeader ? Number(totalHeader) : undefined;
      let downloadedBytes = 0;
      let lastPercent = -1;
      const chunks: Buffer[] = [];

      if (onProgress) {
        onProgress({
          downloadedBytes: 0,
          totalBytes,
          percent: totalBytes ? 0 : undefined,
        });
      }

      await new Promise<void>((resolve, reject) => {
        data.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          chunks.push(bytes);
          downloadedBytes += bytes.length;

          if (!onProgress) {
            return;
          }

          if (totalBytes && totalBytes > 0) {
            const percent = Math.min(
              100,
              Math.floor((downloadedBytes / totalBytes) * 100),
            );
            if (percent !== lastPercent) {
              lastPercent = percent;
              onProgress({ downloadedBytes, totalBytes, percent });
            }
            return;
          }

          onProgress({ downloadedBytes, totalBytes });
        });

        data.on("end", () => {
          if (onProgress && totalBytes && lastPercent < 100) {
            onProgress({ downloadedBytes, totalBytes, percent: 100 });
          }
          resolve();
        });

        data.on("error", (error) => reject(error));
      });

      return {
        bytes: Buffer.concat(chunks),
        contentType: String(
          headers["content-type"] || "application/octet-stream",
        ),
      };
    } catch (error) {
      return this.withBrowserFallbackGetBinary(path, refererPath, error, onProgress);
    }
  }

  async download4k(
    responseId: string,
    parentRequestId: string,
  ): Promise<DownloadResult> {
    return this.downloadImage(responseId, parentRequestId, "4K");
  }
}
