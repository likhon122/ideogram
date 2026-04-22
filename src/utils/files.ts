import { promises as fs } from "node:fs";
import path from "node:path";

export type PromptEntry = {
  prompt: string;
  sourceLineIndex: number;
};

export function formatRunStamp(date = new Date()): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p2(date.getMonth() + 1)}${p2(date.getDate())}_${p2(date.getHours())}${p2(date.getMinutes())}${p2(date.getSeconds())}`;
}

export function sanitizeFilename(input: string, maxLen = 70): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) {
    return "image";
  }

  return normalized.length > maxLen ? normalized.slice(0, maxLen) : normalized;
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function readPromptsFile(filePath: string): Promise<string[]> {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

export async function readPromptEntries(
  filePath: string,
): Promise<{ sourceLines: string[]; entries: PromptEntry[] }> {
  const raw = await fs.readFile(filePath, "utf8");
  const sourceLines = raw.split(/\r?\n/);
  const entries: PromptEntry[] = [];

  sourceLines.forEach((line, index) => {
    const prompt = line.trim();
    if (prompt.length === 0 || prompt.startsWith("#")) {
      return;
    }

    entries.push({
      prompt,
      sourceLineIndex: index,
    });
  });

  return { sourceLines, entries };
}

export async function detectPromptFile(
  promptsDir = path.join("prompts"),
): Promise<string> {
  const files = await fs.readdir(promptsDir, { withFileTypes: true });
  const txtFiles = files
    .filter(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".txt"),
    )
    .map((entry) => path.join(promptsDir, entry.name));

  if (txtFiles.length === 0) {
    throw new Error(`No .txt prompt file found in ${promptsDir}.`);
  }

  if (txtFiles.length === 1) {
    return txtFiles[0];
  }

  const withStats = await Promise.all(
    txtFiles.map(async (filePath) => {
      const stat = await fs.stat(filePath);
      return { filePath, mtimeMs: stat.mtimeMs };
    }),
  );

  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withStats[0].filePath;
}

export async function writeJson(
  filePath: string,
  data: unknown,
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

export function contentTypeToExtension(contentType: string): string {
  const cleaned = contentType.toLowerCase();

  if (cleaned.includes("png")) return "png";
  if (cleaned.includes("jpeg") || cleaned.includes("jpg")) return "jpg";
  if (cleaned.includes("webp")) return "webp";
  if (cleaned.includes("avif")) return "avif";
  return "bin";
}
