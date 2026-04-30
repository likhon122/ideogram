import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import axios from "axios";
import tracker from "./tracker.js";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

// Gemini API Keys
const GEMINI_API_KEYS = [
  "AIzaSyAvwomqeQwWEtrDQyx1folbAosELxN41ps",
  "AIzaSyD4UdC9Q4m9isfqY1B4yPcAksBNk6zj0XI",
  "AIzaSyB7duRGM8HBi2JmKpVJU2uqv_85ZabWNi8",
  "AIzaSyAUOtIQTBgNBl6-Rn5gGoNaL1fDE9AjcsU",
  "AIzaSyC_4j-AdLJd2VXq1ry_J5FqxPi3l2iGztk",
  "AIzaSyDNebkrmr4K4ACFGFQ0XS1f27qpNMyIKO4",
  "AIzaSyDjps-IueZJEXcffUWVtliJmcou0kRFqYk",
  "AIzaSyB3aeNu-K0m7NoD1M57HgleTc49omkQX4E",
  "AIzaSyDDvst-hGsqxCv4JC2WMiEsUMpGFNiBLrY",
  "AIzaSyB1tjQBTBiV5eD16zyazCdZnNE_8tI7zPs",
  "AIzaSyDGu3Yjxi9BTOwcgJO0CSLlLFfQhthpX1M",
  "AIzaSyD2kcgLGSglJUtoipzQT3k18ZVXhiRRWzo",
  "AIzaSyAitEW4Bh62yGqtpADPJeMjvz4_zMB92Ko",
  "AIzaSyDdpjL5lsrGSsBDR-b_gJJFUVh4iAhQ4P4",
  "AIzaSyD0clkx2LsDY3dZK9d92xQiYRxmvvVAnk4",
  "AIzaSyDsQzGDr7laYQQkayLtSXE0u_9q6sVmO0g",
  "AIzaSyDTsyUKEiLfb28PvvAYHK6Ygrdk_8ZtcIw",
  "AIzaSyChK4eC2MjhamJfuSQNbhQ252BPixpsBhg",
  "AIzaSyAqWwpkCz5ffsgeAB1qEOnISD0Gcf0DgTU",
  "AIzaSyDp9rSbwMlJX1Ac6Sh2cSNsaOm-1_q2ruo",
  "AIzaSyASz4jd4hMmitWlM3iWaSlpgjBAIV-e4J0",
  "AIzaSyA2y8iFCnPJxjbTltsG0-pKBD9YT8N8wUM",
  "AIzaSyAZGZrfSKpwojQS2UaqizHw9v6hMAkHoxY",
  "AIzaSyA0UsuchK4WB8P2cxczx4QJNrIaQaB2wuk",
  "AIzaSyDce7md6Io354kuNrK_xS5KjCfvk1vfdG4",
  "AIzaSyAHwkkhEZ-9A0ItI_VtEnksmyap1xx7d0c",
  "AIzaSyCfEPBNEawAIkqpjv22dPzGFh2BCWOwJV8",
  "AIzaSyBTu1qZBmGGlDUAUK0m8Ui-kfq5qEcMvMg",
  "AIzaSyDeaGmHb1PVUtSpaahRe7sMxwXvDpYVkQE",
  "AIzaSyAo9DsgKplE-BK6HEfg4I4z6m6351fnws4",
  "AIzaSyCRk0Wm-jUu7i-ZOEqxs4LfFbjXmOkP4o0",
  "AIzaSyDvfQ6ItYTqJkTbcdmGyh41nChmGq29cOw",
  "AIzaSyC_5oB5fLCgT9jP67DAZ2fFFIut-7llJ_Q",
  "AIzaSyDLHC5t_NsTJ0_a5Lsuy_A2oo3nMlXBb2c",
  "AIzaSyBDnR-cfDm8WImrN1HoAvsHLy3EMlFc218",
  "AIzaSyB0sxt0LVjJCYo7PqaQCW92XCGAdUKvoQs",
  "AIzaSyByCa6xAD8NBvF3lSe7Kh4Uddy6qR23jNI",
  "AIzaSyCFLuqItVK1Ppkfh8skwv5WBoltJ4R2Jqo",
  "AIzaSyD2WyRolNY9rXNeYGc7RMC_gTF82_gTEUs",
  "AIzaSyAQw_ZCENkAQA6xTWjR2bUufVYS93-YzCA",
  "AIzaSyB4pWBowTswp_rCtQJtUT8BVr-n2am0Ztk",
  "AIzaSyARpRZvfdZzjsvxsZJlFYHJ7SQIbLXQDz0",
  "AIzaSyB1OPw8h9PzBRzfo-XgYMtASIcKRARvGT0",
  "AIzaSyDddo9cTyH1Lg7_NmCagf5h57FFB2GA3As",
  "AIzaSyBx2KkSZkGWGZ_78ezK0S0FImm0VKOeSDs",
  "AIzaSyBtkgOw437Jroq8p9WpgFnLvf9JzFy6d1s",
  "AIzaSyAEWpAtILvOOvBxy8BulCZLiAzD11bPNoA",
  "AIzaSyBrzACBni7U63aI-ep9l_zSkGyZbdYS8WU",
  "AIzaSyCgcw9c346KOo8FyD40yLqQH7dD1pyv12k"
];

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash-lite:generateContent";

let currentKeyIndex = 0;
const failedKeys = new Set<number>();
let lastGeminiCall = 0;
const GEMINI_DELAY_MS = 3000;

function getNextApiKey(): string | null {
  if (failedKeys.size >= GEMINI_API_KEYS.length) {
    return null;
  }

  let attempts = 0;
  while (attempts < GEMINI_API_KEYS.length) {
    if (!failedKeys.has(currentKeyIndex)) {
      return GEMINI_API_KEYS[currentKeyIndex] ?? null;
    }
    currentKeyIndex = (currentKeyIndex + 1) % GEMINI_API_KEYS.length;
    attempts++;
  }

  return null;
}

function markCurrentKeyFailed() {
  failedKeys.add(currentKeyIndex);
  currentKeyIndex = (currentKeyIndex + 1) % GEMINI_API_KEYS.length;
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
  maxKeywords: number
): Promise<{ title: string; keywords: string[] }> {
  const now = Date.now();
  const elapsed = now - lastGeminiCall;
  if (elapsed < GEMINI_DELAY_MS && lastGeminiCall > 0) {
    await new Promise((resolve) => setTimeout(resolve, GEMINI_DELAY_MS - elapsed));
  }
  lastGeminiCall = Date.now();

  let attempts = 0;
  const maxAttempts = GEMINI_API_KEYS.length - failedKeys.size;

  while (attempts < maxAttempts) {
    const apiKey = getNextApiKey();
    if (!apiKey) break;

    try {
      const response = await axios.post(
        `${GEMINI_URL}?key=${apiKey}`,
        {
          contents: [
            {
              parts: [
                {
                  text: `You are an Adobe Stock metadata expert. For the given generated image, generate BOTH a title and keywords in a single response.

Illustration: "${prompt}"

Rules:
1. TITLE: A concise, SEO-friendly title under 120 characters. Descriptive and suitable for stock image search.
2. KEYWORDS: Exactly ${maxKeywords} keywords as comma-separated values. Focus on stock image search terms including: main subject, style, related themes/concepts, usage contexts, related objects, and stock image terms.

Output format (strictly follow this - no extra text):
TITLE: <your title here>
KEYWORDS: <keyword1, keyword2, keyword3, ...>`,
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 500,
          },
        },
        {
          headers: { "Content-Type": "application/json" },
          timeout: 30000,
        }
      );

      const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text || "";

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
        tracker.trackGeminiKeyUsage(currentKeyIndex);
        currentKeyIndex = (currentKeyIndex + 1) % GEMINI_API_KEYS.length;
        logger.info(`Gemini API Success: Title="${title}" | ${keywords.length} keywords`);
        return {
          title,
          keywords: keywords.slice(0, maxKeywords),
        };
      } else {
        logger.warn(`Gemini returned insufficient data (title=${title.length} chars, keywords=${keywords.length}), trying next key...`);
        markCurrentKeyFailed();
        attempts++;
        continue;
      }
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
      continue;
    }
  }

  logger.warn(`All ${GEMINI_API_KEYS.length} Gemini API keys exhausted, using fallback`);
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
  const args: string[] = [
    "-overwrite_original_in_place",
    "-charset",
    "utf8",
    // Clear previous list values before appending to avoid stale keywords.
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

function candidateExiftoolBins(preferred: string): string[] {
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

  for (const bin of candidateExiftoolBins(exiftoolBin)) {
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