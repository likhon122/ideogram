import { promises as fs } from "node:fs";
import path from "node:path";
import pLimit from "p-limit";
import { config } from "./config.js";
import { IdeogramClient } from "./client/ideogramClient.js";
import { runPromptPipeline, runUploadUpscalePipeline, type QualityMode } from "./core/workflow.js";
import { logger } from "./utils/logger.js";
import {
  detectPromptFile,
  ensureDir,
  readPromptEntries,
  writeJson,
} from "./utils/files.js";

type CliArgs = {
  promptsFile?: string;
  prompt?: string[];
  image?: string;
  imagesDir?: string;
  concurrency: number;
  quality: QualityMode;
  mode: "generate" | "upload-download";
};

type PromptItem = {
  prompt: string;
  sourceLineIndex?: number;
};

type PromptCollection = {
  prompts: PromptItem[];
  promptFilePath?: string;
  sourceLines?: string[];
};

const MAX_RETRIES_PER_PROMPT = config.maxRetriesPerPrompt;
const RETRY_DELAY_MS = 2000;

function normalizeQuality(value: string | undefined): QualityMode | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase().replace(/\s+/g, "");
  if (normalized === "4k" || normalized.includes("start:4k") || normalized.includes("upload-download:4k")) return "4K";
  if (normalized === "8k" || normalized.includes("start:8k") || normalized.includes("upload-download:8k")) return "8K";

  // Supports tokens passed as positional extras, e.g. `npm start start:8k`.
  if (normalized.endsWith("4k")) return "4K";
  if (normalized.endsWith("8k")) return "8K";
  return undefined;
}

function inferQualityFromNpmOriginalArgs(): QualityMode | undefined {
  const raw = process.env.npm_config_argv;
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as { original?: string[] };
    const original = parsed.original ?? [];
    for (const token of original) {
      const quality = normalizeQuality(token);
      if (quality) {
        return quality;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    concurrency: 1,
    prompt: [],
    quality: "4K",
    mode: "generate",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const value = argv[i + 1];

    if (token === "--prompts-file" && value) {
      args.promptsFile = value;
      i += 1;
      continue;
    }

    if (token === "--prompt" && value) {
      args.prompt?.push(value);
      i += 1;
      continue;
    }

    if (token === "--image" && value) {
      args.image = value;
      args.mode = "upload-download";
      i += 1;
      continue;
    }

    if (token === "--images-dir" && value) {
      args.imagesDir = value;
      args.mode = "upload-download";
      i += 1;
      continue;
    }

    if (token === "--concurrency" && value) {
      args.concurrency = Number(value);
      i += 1;
      continue;
    }

    if (token === "--quality" && value) {
      const quality = normalizeQuality(value);
      if (!quality) {
        throw new Error("--quality must be 4k or 8k");
      }
      args.quality = quality;
      i += 1;
      continue;
    }

    if (token.includes("upload-download")) {
      args.mode = "upload-download";
    }

    const positionalQuality = normalizeQuality(token);
    if (positionalQuality) {
      args.quality = positionalQuality;
    }
  }

  if (args.quality === "4K") {
    const inferred = inferQualityFromNpmOriginalArgs();
    if (inferred) {
      args.quality = inferred;
    }
  }

  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) {
    throw new Error("--concurrency must be a positive integer.");
  }

  return args;
}

function previewPrompt(input: string, max = 72): string {
  return input.length <= max ? input : `${input.slice(0, max - 3)}...`;
}

function createImageStartPacer(delayMs: number) {
  let lastStartedAt = 0;
  let queue: Promise<void> = Promise.resolve();

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  return {
    waitTurn: async (): Promise<void> => {
      queue = queue.then(async () => {
        const now = Date.now();
        if (lastStartedAt > 0) {
          const elapsed = now - lastStartedAt;
          const remaining = delayMs - elapsed;
          if (remaining > 0) {
            await sleep(remaining);
          }
        }

        lastStartedAt = Date.now();
      });

      await queue;
    },
  };
}

function createPromptFileUpdater(filePath: string, sourceLines: string[]) {
  const removedIndexes = new Set<number>();
  let writeQueue: Promise<void> = Promise.resolve();

  const writeCurrent = async (): Promise<void> => {
    const nextLines = sourceLines.filter(
      (_, index) => !removedIndexes.has(index),
    );
    await fs.writeFile(filePath, nextLines.join("\n"), "utf8");
  };

  return {
    markCompleted: async (lineIndex: number | undefined): Promise<void> => {
      if (lineIndex == null || removedIndexes.has(lineIndex)) {
        return;
      }

      removedIndexes.add(lineIndex);
      writeQueue = writeQueue.then(() => writeCurrent());
      await writeQueue;
    },
    flush: async (): Promise<void> => {
      await writeQueue;
    },
    remainingPromptCount: (): number => {
      return sourceLines.filter((line, index) => {
        if (removedIndexes.has(index)) {
          return false;
        }

        const trimmed = line.trim();
        return trimmed.length > 0 && !trimmed.startsWith("#");
      }).length;
    },
  };
}

async function collectPrompts(args: CliArgs): Promise<PromptCollection> {
  const inline =
    args.prompt?.map((p) => p.trim()).filter((p) => p.length > 0) ?? [];
  if (inline.length > 0) {
    return {
      prompts: inline.map((prompt) => ({ prompt })),
    };
  }

  const promptsFile =
    args.promptsFile ?? (await detectPromptFile(path.join("prompts")));
  const { sourceLines, entries } = await readPromptEntries(promptsFile);

  return {
    prompts: entries.map((entry) => ({
      prompt: entry.prompt,
      sourceLineIndex: entry.sourceLineIndex,
    })),
    promptFilePath: promptsFile,
    sourceLines,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  
  // Logic for generating images or uploading/upscaling images
  let itemsToProcess: PromptItem[] = [];
  let promptFileUpdater: ReturnType<typeof createPromptFileUpdater> | undefined = undefined;
  
  if (args.mode === "upload-download") {
    if (args.image) {
      itemsToProcess.push({ prompt: args.image }); // Here prompt field stores image path
    } else if (args.imagesDir) {
      const files = await fs.readdir(args.imagesDir);
      for (const file of files) {
        if (file.match(/\.(png|jpg|jpeg|webp)$/i)) {
          itemsToProcess.push({ prompt: path.join(args.imagesDir, file) });
        }
      }
    }
    if (itemsToProcess.length === 0) {
      throw new Error("No images found for upload. Use --image or --images-dir.");
    }
  } else {
    const promptCollection = await collectPrompts(args);
    itemsToProcess = promptCollection.prompts;
    
    promptFileUpdater = promptCollection.promptFilePath && promptCollection.sourceLines
      ? createPromptFileUpdater(
          promptCollection.promptFilePath,
          promptCollection.sourceLines,
        )
      : undefined;

    if (itemsToProcess.length === 0) {
      throw new Error("No prompts found. Use --prompt or --prompts-file.");
    }
    if (promptCollection.promptFilePath) {
      logger.info(`Prompt file: ${promptCollection.promptFilePath}`);
    }
  }

  const runDir = path.resolve(config.outputDir, args.quality.toLowerCase());
  const reportPath = path.join(runDir, "run-report.json");

  logger.section(`Ideogram ${args.mode === "upload-download" ? "Upload & Upscale" : "Image Generation"} Runner`);
  logger.info(`Items queued: ${itemsToProcess.length}`);
  logger.info(`Concurrency: ${args.concurrency}`);
  logger.info(`Quality mode: ${args.quality}`);
  logger.info(`Output folder: ${runDir}`);
  logger.line();

  const client = new IdeogramClient(config);

  if (config.enableQuotaPreflight) {
    logger.info("Running quota preflight check...");
    await client.checkQuotaStats();
    logger.info("Quota preflight passed.");
  }

  await ensureDir(runDir);

  let done = 0;
  let successCount = 0;
  let failCount = 0;
  const imageStartPacer = createImageStartPacer(5000);
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  const limit = pLimit(args.concurrency);
  const jobs = itemsToProcess.map((item, index) =>
    limit(async () => {
      await imageStartPacer.waitTurn();
      const ordinal = index + 1;
      const displayStr = args.mode === "upload-download" ? path.basename(item.prompt) : previewPrompt(item.prompt);
      logger.info(
        `[${ordinal}/${itemsToProcess.length}] Processing: ${displayStr}`,
      );

      try {
        let lastError: unknown;
        let result: Awaited<ReturnType<typeof runPromptPipeline>> | undefined;

        for (let attempt = 1; attempt <= MAX_RETRIES_PER_PROMPT; attempt += 1) {
          logger.info(
            `[${ordinal}/${itemsToProcess.length}] Attempt ${attempt}/${MAX_RETRIES_PER_PROMPT}`,
          );

          try {
            if (args.mode === "upload-download") {
              result = await runUploadUpscalePipeline(
                client,
                item.prompt,
                ordinal,
                runDir,
                args.quality,
              );
            } else {
              result = await runPromptPipeline(
                client,
                item.prompt,
                ordinal,
                runDir,
                args.quality,
              );
            }
            break;
          } catch (error) {
            lastError = error;
            const reason =
              error instanceof Error ? error.message : String(error);

            if (attempt < MAX_RETRIES_PER_PROMPT) {
              logger.warn(
                `[${ordinal}/${itemsToProcess.length}] Attempt ${attempt} failed: ${reason}. Retrying...`,
              );
              await sleep(RETRY_DELAY_MS);
              continue;
            }

            throw lastError;
          }
        }

        if (!result) {
          throw new Error(
            `Failed to generate image for prompt ${ordinal} after ${MAX_RETRIES_PER_PROMPT} attempts.`,
          );
        }

        successCount += 1;

        if (promptFileUpdater) {
          await promptFileUpdater.markCompleted(item.sourceLineIndex);
          logger.info(
            `[${ordinal}/${itemsToProcess.length}] Prompt removed from file. Remaining: ${promptFileUpdater.remainingPromptCount()}`,
          );
        }

        logger.success(`[${ordinal}/${itemsToProcess.length}] Item completed successfully`);
        return result;
      } catch (error) {
        failCount += 1;
        const reason =
          error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to generate image for prompt ${ordinal}: ${reason}`,
        );
      } finally {
        done += 1;
        logger.info(
          `Progress: ${done}/${itemsToProcess.length} | Success: ${successCount} | Failed: ${failCount}`,
        );
      }
    }),
  );

  const settled = await Promise.allSettled(jobs);

  if (promptFileUpdater) {
    await promptFileUpdater.flush();
  }

  const successes = settled
    .filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof runPromptPipeline>>
      > => result.status === "fulfilled",
    )
    .map((result) => result.value);

  const failures = settled
    .map((result, index) => ({ result, index }))
    .filter(
      (entry): entry is { result: PromiseRejectedResult; index: number } =>
        entry.result.status === "rejected",
    )
    .map((entry) => ({
      promptIndex: entry.index + 1,
      item: itemsToProcess[entry.index].prompt,
      error:
        entry.result.reason instanceof Error
          ? entry.result.reason.message
          : String(entry.result.reason),
    }));

  await writeJson(reportPath, {
    createdAt: new Date().toISOString(),
    runDir,
    total: itemsToProcess.length,
    successCount: successes.length,
    failureCount: failures.length,
    successes,
    failures,
  });

  logger.line();
  logger.info(
    `Run finished. Success: ${successes.length}, Failed: ${failures.length}`,
  );
  logger.info(`Report: ${reportPath}`);

  if (failures.length > 0) {
    for (const failure of failures) {
      logger.error(`[${failure.promptIndex}] ${failure.error}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
