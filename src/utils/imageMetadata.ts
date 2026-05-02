import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import axios from "axios";
import { exiftoolPath as vendoredExiftoolPath } from "exiftool-vendored";
import tracker from "./tracker.js";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

function parseApiKeys(rawValue: string): string[] {
  return Array.from(
    new Set(
      rawValue
        .split(/[\n,;]+/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

const MISTRAL_API_KEYS = parseApiKeys(
  process.env.MISTRAL_API_KEYS || process.env.MISTRAL_API_KEY || "",
);
const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || "mistral-small-latest";

let currentKeyIndex = 0;
const failedKeys = new Set<number>();
let lastMistralCall = 0;
const MISTRAL_DELAY_MS = 3000;

function getNextApiKey(): string | null {
  if (MISTRAL_API_KEYS.length === 0 || failedKeys.size >= MISTRAL_API_KEYS.length) {
    return null;
  }

  let attempts = 0;
  while (attempts < MISTRAL_API_KEYS.length) {
    if (!failedKeys.has(currentKeyIndex)) {
      return MISTRAL_API_KEYS[currentKeyIndex] ?? null;
    }

    currentKeyIndex = (currentKeyIndex + 1) % MISTRAL_API_KEYS.length;
    attempts++;
  }

  return null;
}

function markCurrentKeyFailed(): void {
  if (MISTRAL_API_KEYS.length === 0) {
    return;
  }

  failedKeys.add(currentKeyIndex);
  currentKeyIndex = (currentKeyIndex + 1) % MISTRAL_API_KEYS.length;
}

// Groq API Key - Get free key from https://console.groq.com
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "gemma-4-26b";

let lastGroqCall = 0;
const GROQ_DELAY_MS = 1000;

function validateGroqApiKey(): boolean {
  if (!GROQ_API_KEY) {
    logger.warn("GROQ_API_KEY environment variable not set. Please set it to use Gemma 4 26B.");
    return false;
  }
  return true;
}

function generateKeywordsFallback(prompt: string, maxKeywords: number): string[] {
  const keywords = new Set<string>();
  const promptLower = prompt.toLowerCase();

  const words = promptLower
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);

  const stopWords = [
    "the", "and", "for", "with", "from", "into", "over", "through", "of", "a",
  ];

  words.forEach((word) => {
    if (!stopWords.includes(word)) {
      keywords.add(word);
      if (word.endsWith("s")) {
        keywords.add(word.slice(0, -1));
      } else {
        keywords.add(word + "s");
      }
    }
  });

  const expansions: Record<string, string[]> = {
    christmas: ["holiday", "xmas", "festive", "winter", "santa", "celebration", "december", "seasonal", "gift"],
    halloween: ["spooky", "scary", "horror", "october", "autumn", "night", "dark", "creepy", "party"],
    nature: ["forest", "plant", "organic", "natural", "botanical", "wood", "leaf", "tree"],
    animal: ["wildlife", "creature", "fauna", "wild", "zoo", "pet", "mammal"],
    people: ["human", "person", "figure", "man", "woman", "body", "portrait"],
    city: ["urban", "skyline", "building", "architecture", "downtown", "metropolis", "street"],
    sea: ["beach", "ocean", "water", "sand", "summer", "vacation", "coast"],
    fashion: ["style", "model", "clothing", "trendy", "apparel", "design", "beauty"],
  };

  Object.entries(expansions).forEach(([key, values]) => {
    if (promptLower.includes(key)) {
      values.forEach((v) => keywords.add(v));
    }
  });

  [
    "ai generated", "digital art", "high resolution", "stock image",
    "illustration", "creative", "design", "modern", "concept"
  ].forEach((k) => keywords.add(k));

  return Array.from(keywords).slice(0, maxKeywords);
}

function createTitleFallback(prompt: string): string {
  return prompt
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ")
    .substring(0, 120);
}

export type ImageMetadata = {
  title: string;
  description: string;
  keywords: string[];
};

export type WriteImageWithMetadataInput = {
  outputPath: string;
  bytes: Buffer;
  prompt: string;
  enabled?: boolean;
  exiftoolBin?: string;
  maxKeywords?: number;
};

export type WriteImageWithMetadataResult = {
  metadataApplied: boolean;
  metadata: ImageMetadata;
  reason?: string;
};

type MetadataFormat = "jpeg" | "png" | "webp" | "tiff" | "eps" | "unknown";

function normalizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim();
}

export async function generateTitleAndKeywords(
  prompt: string,
  maxKeywords: number,
): Promise<{ title: string; keywords: string[] }> {
  const now = Date.now();
  const elapsed = now - lastMistralCall;
  if (elapsed < MISTRAL_DELAY_MS && lastMistralCall > 0) {
    await new Promise((resolve) => setTimeout(resolve, MISTRAL_DELAY_MS - elapsed));
  }
  lastMistralCall = Date.now();

  if (MISTRAL_API_KEYS.length === 0) {
    logger.warn("MISTRAL_API_KEYS or MISTRAL_API_KEY is not set. Falling back to prompt-based metadata.");
    return {
      title: createTitleFallback(prompt),
      keywords: generateKeywordsFallback(prompt, maxKeywords),
    };
  }

  let attempts = 0;
  const maxAttempts = MISTRAL_API_KEYS.length - failedKeys.size;

  while (attempts < maxAttempts) {
    const apiKey = getNextApiKey();
    if (!apiKey) break;

    try {
      const response = await axios.post(
        MISTRAL_URL,
        {
          model: MISTRAL_MODEL,
          messages: [
            {
              role: "system",
              content:
                "You are an Adobe Stock metadata expert. Generate a concise stock title and a comma-separated keyword list.",
            },
            {
              role: "user",
              content: `For this generated image, produce BOTH a title and keywords in a single response.

Prompt: "${prompt}"

Rules:
1. TITLE: A concise, SEO-friendly title under 120 characters. Descriptive and suitable for stock image search.
2. KEYWORDS: Exactly ${maxKeywords} keywords as comma-separated values. Focus on stock image search terms including: main subject, style, related themes/concepts, usage contexts, related objects, and stock image terms.

Output format (strictly follow this - no extra text):
TITLE: <your title here>
KEYWORDS: <keyword1, keyword2, keyword3, ...>`,
            },
          ],
          temperature: 0.4,
          max_tokens: 500,
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 30000,
        },
      );

      const text = response.data.choices?.[0]?.message?.content || "";

      const titleMatch = text.match(/TITLE:\s*(.+)/i);
      const keywordsMatch = text.match(/KEYWORDS:\s*(.+)/is);

      let title = titleMatch ? titleMatch[1].trim().replace(/^["']|["']$/g, "") : "";
      const keywordsRaw = keywordsMatch ? keywordsMatch[1].trim() : "";

      const keywords = keywordsRaw
        .split(",")
        .map((k: string) => k.trim().toLowerCase())
        .filter((k: string) => k.length > 1 && k.length < 50);

      if (title.length > 120) {
        title = title.substring(0, 120).replace(/\s+\S*$/, "");
      }

      if (title.length > 0 && keywords.length >= 10) {
        tracker.trackApiKeyUsage(currentKeyIndex);
        currentKeyIndex = (currentKeyIndex + 1) % MISTRAL_API_KEYS.length;
        logger.info(`Mistral API Success: Title="${title}" | ${keywords.length} keywords`);
        return {
          title,
          keywords: keywords.slice(0, maxKeywords),
        };
      }

      logger.warn(
        `Mistral returned insufficient data (title=${title.length} chars, keywords=${keywords.length}), trying next key...`,
      );
      markCurrentKeyFailed();
      attempts++;
    } catch (error: unknown) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 429) {
          logger.warn(`Key ${currentKeyIndex} quota exhausted (429), trying next key...`);
        } else {
          logger.warn(`Key ${currentKeyIndex} error (${error.response?.status}), trying next key...`);
        }
      } else {
        logger.warn(`Key ${currentKeyIndex} failed with error, trying next key...`);
      }

      markCurrentKeyFailed();
      attempts++;
    }
  }

  logger.warn(`All ${MISTRAL_API_KEYS.length} Mistral API keys exhausted, using fallback`);
  return {
    title: createTitleFallback(prompt),
    keywords: generateKeywordsFallback(prompt, maxKeywords),
  };
}

export async function metadataFromPrompt(
  prompt: string,
  maxKeywords = 40,
): Promise<ImageMetadata> {
  const cleanedPrompt = normalizePrompt(prompt);
  const { title, keywords } = await generateTitleAndKeywords(cleanedPrompt || "Generated image", maxKeywords);

  return {
    title,
    description: cleanedPrompt || "Generated image",
    keywords,
  };
}

function supportsMetadata(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".avif",
    ".tif",
    ".tiff",
    ".eps",
  ].includes(ext);
}

function detectMetadataFormat(filePath: string): MetadataFormat {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "jpeg";
  if (ext === ".png") return "png";
  if (ext === ".webp") return "webp";
  if (ext === ".avif") return "webp";
  if (ext === ".tif" || ext === ".tiff") return "tiff";
  if (ext === ".eps") return "eps";
  return "unknown";
}

function exiftoolArgs(
  metadata: ImageMetadata,
  filePath: string,
  format: MetadataFormat,
): string[] {
  const joinedKeywords = metadata.keywords.join("; ");
  const args: string[] = [
    "-overwrite_original_in_place",
    "-charset",
    "utf8",
    "-XMP-dc:Subject=",
    "-IPTC:Keywords=",
    `-XMP-dc:Title=${metadata.title}`,
    `-XMP-dc:Description=${metadata.description}`,
    "-XMP-xmp:CreatorTool=Ideogram TypeScript Batch Generator",
  ];

  if (format === "png") {
    args.push(`-PNG:Title=${metadata.title}`);
    args.push(`-PNG:Description=${metadata.description}`);
  }

  if (format === "jpeg" || format === "tiff" || format === "eps") {
    args.push(`-IPTC:ObjectName=${metadata.title}`);
    args.push(`-IPTC:Caption-Abstract=${metadata.description}`);
    args.push(`-EXIF:XPTitle=${metadata.title}`);
    args.push(`-EXIF:XPSubject=${metadata.title}`);
    args.push(`-EXIF:XPComment=${metadata.description}`);
    args.push(`-EXIF:XPKeywords=${joinedKeywords}`);
  }

  for (const keyword of metadata.keywords) {
    args.push(`-XMP-dc:Subject+=${keyword}`);
    if (format === "jpeg" || format === "tiff" || format === "eps") {
      args.push(`-IPTC:Keywords+=${keyword}`);
    }
  }

  args.push(filePath);
  return args;
}

async function verifyMetadataWritten(
  exiftoolBin: string,
  filePath: string,
): Promise<boolean> {
  const { stdout } = await execFileAsync(
    exiftoolBin,
    ["-s", "-s", "-s", "-XMP-dc:Title", filePath],
    {
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    },
  );

  return stdout.trim().length > 0;
}

async function candidateExiftoolBins(preferred: string): Promise<string[]> {
  const seen = new Set<string>();
  const add = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
  };

  add(preferred);
  add("exiftool");
  add("exiftool.exe");
  add("ExifTool.exe");
  add("exiftool(-k).exe");
  try {
    add(await vendoredExiftoolPath());
  } catch {
    // Ignore vendored path lookup errors and keep trying other candidates.
  }
  return Array.from(seen);
}

export async function writeImageWithMetadata(
  input: WriteImageWithMetadataInput,
): Promise<WriteImageWithMetadataResult> {
  const {
    outputPath,
    bytes,
    prompt,
    enabled = true,
    exiftoolBin = "exiftool",
    maxKeywords = 40,
  } = input;

  const metadata = await metadataFromPrompt(prompt, maxKeywords);
  const format = detectMetadataFormat(outputPath);
  await fs.writeFile(outputPath, bytes);

  if (format === "png") {
    logger.warn(
      "PNG metadata support in Windows Properties is limited; Title/Tags visibility depends on Explorer support.",
    );
  }

  if (!enabled) {
    return {
      metadataApplied: false,
      metadata,
      reason: "metadata disabled",
    };
  }

  if (!supportsMetadata(outputPath)) {
    return {
      metadataApplied: false,
      metadata,
      reason: "file format unsupported for metadata",
    };
  }

  let lastError = "unknown metadata write error";

  const bins = await candidateExiftoolBins(exiftoolBin);
  for (const bin of bins) {
    try {
      await execFileAsync(bin, exiftoolArgs(metadata, outputPath, format), {
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      });

      const verified = await verifyMetadataWritten(bin, outputPath);
      if (!verified) {
        lastError = "metadata verification failed after write";
        continue;
      }

      return {
        metadataApplied: true,
        metadata,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = message.split(/\r?\n/, 1)[0];
    }
  }

  return {
    metadataApplied: false,
    metadata,
    reason: lastError,
  };
}
