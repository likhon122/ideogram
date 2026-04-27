import path from "node:path";
import { config } from "../config.js";
import { IdeogramClient } from "../client/ideogramClient.js";
import { logger } from "../utils/logger.js";
import {
  contentTypeToExtension,
  ensureDir,
  sanitizeFilename,
} from "../utils/files.js";
import { writeImageWithMetadata } from "../utils/imageMetadata.js";
import { type DownloadResolution } from "../client/ideogramClient.js";
import {
  type GenerateImagePayload,
  type RunResult,
  type SamplingRequestStatus,
  type SuperResPayload,
} from "../types/ideogram.js";

export type QualityMode = "4K" | "8K";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstRequestOrThrow(
  status: { sampling_requests: SamplingRequestStatus[] },
  requestId: string,
): SamplingRequestStatus {
  const req = status.sampling_requests?.[0];
  if (!req) {
    throw new Error(`No sampling request returned for request_id=${requestId}`);
  }
  return req;
}

async function waitUntilCompleted(
  client: IdeogramClient,
  requestId: string,
  refererPath: string,
  label: string,
  promptIndex: number,
): Promise<SamplingRequestStatus> {
  const started = Date.now();
  let lastProgressBucket = -1;

  while (Date.now() - started < config.maxWaitMs) {
    const data = await client.retrieveRequests([requestId], refererPath);
    const req = firstRequestOrThrow(data, requestId);

    if (req.is_errored) {
      throw new Error(`${label} request failed (request_id=${requestId}).`);
    }

    const pct = req.completion_percentage ?? 0;
    const progressBucket = Math.floor(pct / 25);
    if (progressBucket > lastProgressBucket || pct >= 100) {
      lastProgressBucket = progressBucket;
      logger.info(`[${promptIndex}] ${label}: ${pct}%`);
    }

    if (req.is_completed && req.responses && req.responses.length > 0) {
      return req;
    }

    await sleep(config.pollIntervalMs);
  }

  throw new Error(
    `${label} timed out after ${config.maxWaitMs} ms (request_id=${requestId}).`,
  );
}

export async function runPromptPipeline(
  client: IdeogramClient,
  prompt: string,
  promptIndex: number,
  outputRunDir: string,
  quality: QualityMode,
): Promise<RunResult> {
  logger.info(`[${promptIndex}] Generating image...`);

  const generatePayload: GenerateImagePayload = {
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

  const generated = await client.submitGenerate(generatePayload);
  const initialRequestId = generated.request_id;

  const finalInitialStatus = await waitUntilCompleted(
    client,
    initialRequestId,
    "/library/my-images",
    "Initial generation",
    promptIndex,
  );

  const initialResponse = finalInitialStatus.responses[0];
  if (!initialResponse?.response_id) {
    throw new Error(
      `[${promptIndex}] Missing response_id from initial generation.`,
    );
  }

  logger.info(`[${promptIndex}] Upscaling image...`);

  const upscaleFactor = quality === "8K" ? config.upscaleFactor8k : config.upscaleFactor;

  const superResPayload: SuperResPayload = {
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
    upscale_factor: upscaleFactor,
    resolution: {
      width: finalInitialStatus.width ?? config.resolutionWidth,
      height: finalInitialStatus.height ?? config.resolutionHeight,
    },
    num_images: 1,
    style_type: config.styleType,
    internal: config.superResInternal,
    ...(config.categoryId ? { category_id: config.categoryId } : {}),
  };

  const superRes = await client.submitSuperRes(
    initialRequestId,
    superResPayload,
  );
  const superResRequestId = superRes.request_id;

  const finalSuperStatus = await waitUntilCompleted(
    client,
    superResRequestId,
    `/g/${initialRequestId}/0`,
    "Super-res",
    promptIndex,
  );

  const superResResponse = finalSuperStatus.responses[0];
  if (!superResResponse?.response_id) {
    throw new Error(`[${promptIndex}] Missing response_id from super-res.`);
  }

  logger.info(`[${promptIndex}] Downloading ${quality} image...`);
  const downloadStartedAt = Date.now();
  let lastDownloadProgressBucket = -1;

  const download = await client.downloadImage(
    superResResponse.response_id,
    initialRequestId,
    quality as DownloadResolution,
    (progress) => {
      if (progress.percent == null) {
        return;
      }

      const bucket = Math.floor(progress.percent / 10);
      if (bucket <= lastDownloadProgressBucket && progress.percent < 100) {
        return;
      }

      lastDownloadProgressBucket = bucket;
      logger.info(`[${promptIndex}] Download ${quality}: ${progress.percent}%`);
    },
  );
  await ensureDir(outputRunDir);

  const ext = contentTypeToExtension(download.contentType);
  const base = sanitizeFilename(prompt);
  const outputPath = path.join(
    outputRunDir,
    `${String(promptIndex).padStart(3, "0")}_${base}_${quality.toLowerCase()}.${ext}`,
  );

  const metadataResult = await writeImageWithMetadata({
    outputPath,
    bytes: download.bytes,
    prompt,
    enabled: config.enableImageMetadata,
    exiftoolBin: config.exiftoolBin,
    maxKeywords: config.metadataMaxKeywords,
  });

  if (metadataResult.metadataApplied) {
    logger.info(
      `[${promptIndex}] Metadata applied (${metadataResult.metadata.keywords.length} keywords)`,
    );
  } else if (metadataResult.reason !== "metadata disabled") {
    logger.warn(
      `[${promptIndex}] Metadata skipped: ${metadataResult.reason ?? "unknown reason"}`,
    );
  }

  const seconds = Math.max(
    1,
    Math.round((Date.now() - downloadStartedAt) / 1000),
  );
  logger.success(`[${promptIndex}] Download complete (${seconds}s)`);
  logger.info(`[${promptIndex}] Saved: ${path.basename(outputPath)}`);

  return {
    promptIndex,
    prompt,
    initialRequestId,
    initialResponseId: initialResponse.response_id,
    superResRequestId,
    superResResponseId: superResResponse.response_id,
    outputPath,
  };
}
