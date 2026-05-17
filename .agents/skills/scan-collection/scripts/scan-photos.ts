import { readFileSync, writeFileSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { resolve, extname, basename } from "node:path";
import OpenAI from "openai";
import sharp from "sharp";

// ── Types ──────────────────────────────────────────────────────────────────

interface DetectedCard {
  name: string;
  quantity: number;
  confidence: "high" | "medium" | "low";
  sourcePhoto: string;
}

interface VisionResponse {
  cards: { name: string; quantity: number; confidence: string }[];
}

interface RawCardsOutput {
  metadata: {
    source: string;
    scanDate: string;
    photoDirectory: string;
    photosProcessed: number;
    photosSkipped: number;
    totalCardsDetected: number;
    highConfidenceCards: number;
    uncertainCards: number;
  };
  cards: DetectedCard[];
  warnings: (DetectedCard | string)[];
}

// ── Constants ──────────────────────────────────────────────────────────────

const SUPPORTED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

const VISION_PROMPT = `You are identifying Magic: The Gathering cards visible in this photo.

Rules:
- List every card you can see, even if partially visible
- If multiple copies of the same card are visible, count them
- Only include cards you are confident about — do not guess
- For each card, provide: the exact card name, the quantity visible, and your confidence (high/medium/low)

Respond in JSON format:
{
  "cards": [
    {"name": "Lightning Bolt", "quantity": 2, "confidence": "high"},
    {"name": "Ragavan, Nimble Pilferer", "quantity": 1, "confidence": "medium"}
  ]
}`;

const VISION_RETRY_PROMPT = `You previously analyzed this photo but your response was not valid JSON. Please try again.

Identify all Magic: The Gathering cards visible in this photo. For each card provide: exact card name, quantity visible, and confidence (high/medium/low).

You MUST respond with ONLY valid JSON in this exact format, no other text:
{"cards":[{"name":"Card Name","quantity":1,"confidence":"high"}]}`;

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isImageFile(filename: string): boolean {
  const ext = extname(filename).toLowerCase();
  return SUPPORTED_EXTENSIONS.includes(ext);
}

async function resizeIfNeeded(filePath: string): Promise<Buffer> {
  const stat = statSync(filePath);
  if (stat.size <= MAX_IMAGE_BYTES) {
    return readFileSync(filePath);
  }
  console.error(`  Resizing ${basename(filePath)} (${(stat.size / 1024 / 1024).toFixed(1)}MB)...`);
  return await sharp(filePath)
    .resize({ width: 2048, withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}

function imageToDataUri(buffer: Buffer, filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
  };
  const mime = mimeMap[ext] || "image/jpeg";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

function parseVisionResponse(text: string): VisionResponse | null {
  // Try direct JSON parse
  try {
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.cards)) return parsed as VisionResponse;
  } catch {
    // Try extracting JSON from markdown code block
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        if (parsed && Array.isArray(parsed.cards)) return parsed as VisionResponse;
      } catch {
        // fall through
      }
    }
  }
  return null;
}

function isValidConfidence(c: string): c is "high" | "medium" | "low" {
  return ["high", "medium", "low"].includes(c);
}

// ── Vision Scan ────────────────────────────────────────────────────────────

async function scanPhoto(
  client: OpenAI,
  filePath: string,
  retryCount = 0
): Promise<{ cards: DetectedCard[]; warnings: (DetectedCard | string)[]; skipped: boolean }> {
  const fileName = basename(filePath);
  const cards: DetectedCard[] = [];
  const warnings: (DetectedCard | string)[] = [];

  try {
    const imageBuffer = await resizeIfNeeded(filePath);
    const dataUri = imageToDataUri(imageBuffer, filePath);

    const prompt = retryCount > 0 ? VISION_RETRY_PROMPT : VISION_PROMPT;

    const response = await client.chat.completions.create({
      model: "kimi-k2.5-fast",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUri } },
          ],
        },
      ],
      max_tokens: 2048,
      temperature: 0.1,
    });

    const content = response.choices[0]?.message?.content?.trim() ?? "";

    const parsed = parseVisionResponse(content);
    if (!parsed) {
      if (retryCount === 0) {
        console.error(`  Invalid JSON from model for ${fileName}, retrying...`);
        return scanPhoto(client, filePath, 1);
      }
      warnings.push(`photo ${fileName}: model returned invalid JSON after retry`);
      return { cards, warnings, skipped: true };
    }

    for (const card of parsed.cards) {
      const confidence = isValidConfidence(card.confidence) ? card.confidence : "low";
      const detected: DetectedCard = {
        name: card.name?.trim() || "Unknown",
        quantity: Math.max(1, Math.round(card.quantity || 1)),
        confidence,
        sourcePhoto: fileName,
      };

      if (confidence === "high") {
        cards.push(detected);
      } else {
        warnings.push(detected);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (retryCount < MAX_RETRIES) {
      const delay = RETRY_BASE_MS * Math.pow(2, retryCount);
      console.error(`  API error for ${fileName}: ${msg}. Retrying in ${delay}ms...`);
      await sleep(delay);
      return scanPhoto(client, filePath, retryCount + 1);
    }
    warnings.push(`photo ${fileName}: API error after ${MAX_RETRIES} retries: ${msg}`);
    return { cards, warnings, skipped: true };
  }

  return { cards, warnings, skipped: false };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: npx tsx scan-photos.ts <photo-directory> [output-path]");
    process.exit(1);
  }

  const apiKey = process.env.NEURALWATT_API_KEY;
  if (!apiKey) {
    console.error("Error: Set NEURALWATT_API_KEY environment variable");
    process.exit(1);
  }

  const photoDir = resolve(args[0]);
  const outputPath = resolve(args[1] || "raw-cards.json");

  // Validate directory
  try {
    const stat = statSync(photoDir);
    if (!stat.isDirectory()) {
      throw new Error("Not a directory");
    }
  } catch {
    console.error(`Error: Directory not found: ${photoDir}`);
    process.exit(1);
  }

  // Find image files
  const imageFiles = readdirSync(photoDir)
    .filter(isImageFile)
    .sort()
    .map((f) => resolve(photoDir, f));

  if (imageFiles.length === 0) {
    console.error(`Error: No .jpg/.jpeg/.png/.webp files found in ${photoDir}`);
    process.exit(1);
  }

  console.error(`Found ${imageFiles.length} image(s) in ${photoDir}`);

  // Initialize OpenAI client for Kimi
  const client = new OpenAI({
    apiKey,
    baseURL: "https://api.neuralwatt.com/v1",
  });

  // Process each photo
  const allCards: DetectedCard[] = [];
  const allWarnings: (DetectedCard | string)[] = [];
  let photosProcessed = 0;
  let photosSkipped = 0;

  for (let i = 0; i < imageFiles.length; i++) {
    const filePath = imageFiles[i];
    const fileName = basename(filePath);
    console.error(`Scanning ${i + 1}/${imageFiles.length}: ${fileName}`);

    const result = await scanPhoto(client, filePath);

    allCards.push(...result.cards);
    allWarnings.push(...result.warnings);

    if (result.skipped) {
      photosSkipped++;
    } else {
      photosProcessed++;
    }
  }

  // Deduplicate cards by name, summing quantities
  const cardMap = new Map<string, DetectedCard>();
  for (const card of allCards) {
    const key = card.name.toLowerCase();
    const existing = cardMap.get(key);
    if (existing) {
      existing.quantity += card.quantity;
    } else {
      cardMap.set(key, { ...card });
    }
  }
  const dedupedCards = Array.from(cardMap.values());

  const totalCardsDetected = dedupedCards.reduce((sum, c) => sum + c.quantity, 0);
  const highConfidenceCards = dedupedCards.length;
  const uncertainCards = allWarnings.filter(
    (w) => typeof w !== "string"
  ).length;

  if (dedupedCards.length === 0) {
    console.error("Error: No cards confidently identified — check photo quality");
    process.exit(1);
  }

  // Build output
  const output: RawCardsOutput = {
    metadata: {
      source: "photo-scan",
      scanDate: new Date().toISOString(),
      photoDirectory: photoDir,
      photosProcessed,
      photosSkipped,
      totalCardsDetected,
      highConfidenceCards,
      uncertainCards,
    },
    cards: dedupedCards,
    warnings: allWarnings,
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf-8");

  console.error(`\nDone! ${highConfidenceCards} unique cards detected (${totalCardsDetected} total).`);
  console.error(`Photos processed: ${photosProcessed}, skipped: ${photosSkipped}`);
  if (uncertainCards > 0) {
    console.error(`Uncertain cards (review recommended): ${uncertainCards}`);
  }
  console.error(`\nOutput written to: ${outputPath}`);
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
