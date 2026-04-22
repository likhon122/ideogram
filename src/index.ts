import { promises as fs } from "node:fs";
import path from "node:path";
import pLimit from "p-limit";
import { config } from "./config.js";
import { IdeogramClient } from "./client/ideogramClient.js";
import { runPromptPipeline, type QualityMode } from "./core/workflow.js";
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
  concurrency: number;
  quality: QualityMode;
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

function normalizeQuality(value: string | undefined): QualityMode | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase().replace(/\s+/g, "");
  if (normalized === "4k") return "4K";
  if (normalized === "8k") return "8K";

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
  const promptCollection = await collectPrompts(args);
  const prompts = promptCollection.prompts;
  const runDir = path.resolve(config.outputDir, args.quality.toLowerCase());
  const reportPath = path.join(runDir, "run-report.json");

  if (prompts.length === 0) {
    throw new Error("No prompts found. Use --prompt or --prompts-file.");
  }

  logger.section("Ideogram Image Runner");
  logger.info(`Images queued: ${prompts.length}`);
  logger.info(`Concurrency: ${args.concurrency}`);
  logger.info(`Quality mode: ${args.quality}`);
  logger.info(`Output folder: ${runDir}`);
  if (promptCollection.promptFilePath) {
    logger.info(`Prompt file: ${promptCollection.promptFilePath}`);
  }
  logger.line();

  const client = new IdeogramClient(config);

  if (config.enableQuotaPreflight) {
    logger.info("Running quota preflight check...");
    await client.checkQuotaStats();
    logger.info("Quota preflight passed.");
  }

  await ensureDir(runDir);

  const promptFileUpdater =
    promptCollection.promptFilePath && promptCollection.sourceLines
      ? createPromptFileUpdater(
          promptCollection.promptFilePath,
          promptCollection.sourceLines,
        )
      : undefined;

  let done = 0;
  let successCount = 0;
  let failCount = 0;

  const limit = pLimit(args.concurrency);
  const jobs = prompts.map((item, index) =>
    limit(async () => {
      const ordinal = index + 1;
      logger.info(
        `[${ordinal}/${prompts.length}] Prompt: ${previewPrompt(item.prompt)}`,
      );

      try {
        const result = await runPromptPipeline(
          client,
          item.prompt,
          ordinal,
          runDir,
          args.quality,
        );
        successCount += 1;

        if (promptFileUpdater) {
          await promptFileUpdater.markCompleted(item.sourceLineIndex);
          logger.info(
            `[${ordinal}/${prompts.length}] Prompt removed from file. Remaining: ${promptFileUpdater.remainingPromptCount()}`,
          );
        }

        logger.success(`[${ordinal}/${prompts.length}] Image created`);
        return result;
      } catch (error) {
        failCount += 1;
        throw error;
      } finally {
        done += 1;
        logger.info(
          `Progress: ${done}/${prompts.length} | Success: ${successCount} | Failed: ${failCount}`,
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
      prompt: prompts[entry.index].prompt,
      error:
        entry.result.reason instanceof Error
          ? entry.result.reason.message
          : String(entry.result.reason),
    }));

  await writeJson(reportPath, {
    createdAt: new Date().toISOString(),
    runDir,
    total: prompts.length,
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
