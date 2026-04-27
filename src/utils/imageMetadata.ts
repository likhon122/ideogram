import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const STOCK_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

const BASE_KEYWORDS = [
  "ai generated",
  "digital art",
  "high resolution",
  "stock image",
  "illustration",
  "creative",
  "design",
];

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

function toTitle(prompt: string): string {
  const normalized = normalizePrompt(prompt);
  if (!normalized) {
    return "Generated Image";
  }

  const words = normalized.split(" ");
  const capped = words.slice(0, 18);
  const titleCased = capped
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");

  if (titleCased.length <= 120) {
    return titleCased;
  }

  return `${titleCased.slice(0, 117).trimEnd()}...`;
}

function toKeywords(prompt: string, maxKeywords: number): string[] {
  const normalized = normalizePrompt(prompt).toLowerCase();
  const words = normalized
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3)
    .filter((word) => !STOCK_STOP_WORDS.has(word));

  const unique = new Set<string>();
  for (const word of words) {
    unique.add(word);
    if (word.endsWith("s") && word.length > 3) {
      unique.add(word.slice(0, -1));
    }
  }

  for (const keyword of BASE_KEYWORDS) {
    unique.add(keyword);
  }

  return Array.from(unique).slice(0, Math.max(1, maxKeywords));
}

export function metadataFromPrompt(
  prompt: string,
  maxKeywords = 40,
): ImageMetadata {
  const cleanedPrompt = normalizePrompt(prompt);

  return {
    title: toTitle(cleanedPrompt),
    description: cleanedPrompt || "Generated image",
    keywords: toKeywords(cleanedPrompt, maxKeywords),
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

  const metadata = metadataFromPrompt(prompt, maxKeywords);
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