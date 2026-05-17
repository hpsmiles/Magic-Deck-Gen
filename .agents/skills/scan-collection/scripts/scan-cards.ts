import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, extname, basename } from "node:path";
import OpenAI from "openai";
import sharp from "sharp";

// ── Types ──────────────────────────────────────────────────────────────────

interface DetectedCard {
  name: string;
  quantity: number;
  confidence: "high" | "medium" | "low";
  sourcePhoto: string;
  gridPosition: string;
  setName?: string;
  collectorNumber?: string;
  validatedName?: string;
  validationStatus?: "confirmed" | "corrected" | "flagged";
}

interface RawCardsOutput {
  metadata: {
    source: string;
    scanDate: string;
    photoDirectory: string;
    croppedDirectory: string;
    cardsScanned: number;
    highConfidenceCards: number;
    uncertainCards: number;
    validatedCards: number;
    correctedCards: number;
    flaggedCards: number;
  };
  cards: DetectedCard[];
  warnings: (DetectedCard | string)[];
}

// ── Constants ──────────────────────────────────────────────────────────────

const SUPPORTED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

const LM_STUDIO_BASE_URL = "http://localhost:1234/v1";
const LM_STUDIO_MODEL = "gemma-4-26b-a4b";

const SCAN_PROMPT = `Identify this MTG card. Output ONLY raw JSON:
{"name":"Card Name","setName":"Set Name","collectorNumber":"123","confidence":"high"}

No markdown. No code fences. No extra text. If you can't read the set name or collector number, omit those fields.`;

const SCAN_RETRY_PROMPT = `Your last response was not valid JSON. Try again.

Identify this MTG card. Output ONLY raw JSON like:
{"name":"Card Name","confidence":"high"}

No markdown. No code fences. No extra text.`;

const VALIDATION_PROMPT = (cardName: string) =>
`Is this card named "${cardName}"? Confirm or correct the name. Output ONLY raw JSON:
{"originalName":"${cardName}","correctName":"Correct Name","confidence":"high"}

No markdown. No code fences. No extra text.`;

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isImageFile(filename: string): boolean {
  const ext = extname(filename).toLowerCase();
  return SUPPORTED_EXTENSIONS.includes(ext);
}

function extractJSON(text: string): any | null {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed;
  } catch { /* continue */ }

  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1]);
      if (parsed && typeof parsed === "object") return parsed;
    } catch { /* continue */ }
  }

  const braceStart = text.indexOf("{");
  if (braceStart !== -1) {
    let depth = 0;
    let braceEnd = -1;
    for (let i = braceStart; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) { braceEnd = i; break; }
      }
    }
    if (braceEnd !== -1) {
      try {
        const candidate = text.substring(braceStart, braceEnd + 1);
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === "object") return parsed;
      } catch { /* continue */ }
    }
  }

  return null;
}

function isValidConfidence(c: string): c is "high" | "medium" | "low" {
  return ["high", "medium", "low"].includes(c);
}

function sanitizeCardName(name: string): string {
  let cleaned = name.replace(/\$\\?text\{([^}]*)\}\$/g, "$1");
  cleaned = cleaned.replace(/\$/g, "");
  cleaned = cleaned.replace(/\\[a-zA-Z]+\{([^}]*)\}/g, "$1");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return cleaned;
}

function parseSourceFromFilename(filename: string): { sourcePhoto: string; gridPosition: string } {
  const base = basename(filename, extname(filename));
  const match = base.match(/^(.+)_R(\d+)C(\d+)(?:_uncertain)?$/);
  if (match) {
    return {
      sourcePhoto: `${match[1]}.jpg`,
      gridPosition: `R${match[2]}C${match[3]}`,
    };
  }
  return { sourcePhoto: filename, gridPosition: "unknown" };
}

async function resizeIfNeeded(filePath: string): Promise<{ buffer: Buffer; wasResized: boolean }> {
  const stat = statSync(filePath);
  if (stat.size <= MAX_IMAGE_BYTES) {
    return { buffer: readFileSync(filePath), wasResized: false };
  }
  console.error(`  Resizing ${basename(filePath)} (${(stat.size / 1024 / 1024).toFixed(1)}MB)...`);
  const buffer = await sharp(filePath)
    .resize({ width: 2048, withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { buffer, wasResized: true };
}

function imageToDataUri(buffer: Buffer, wasResized: boolean, filePath: string): string {
  const ext = wasResized ? ".jpg" : extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
  };
  const mime = mimeMap[ext] || "image/jpeg";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

// ── Scan Single Card ───────────────────────────────────────────────────────

async function scanCard(
  client: OpenAI,
  filePath: string,
  jsonRetry = false,
  apiRetries = 0
): Promise<{ card: DetectedCard | null; warnings: (DetectedCard | string)[] }> {
  const fileName = basename(filePath);
  const { sourcePhoto, gridPosition } = parseSourceFromFilename(fileName);
  const warnings: (DetectedCard | string)[] = [];

  try {
    const { buffer: imageBuffer, wasResized } = await resizeIfNeeded(filePath);
    const dataUri = imageToDataUri(imageBuffer, wasResized, filePath);

    const prompt = jsonRetry ? SCAN_RETRY_PROMPT : SCAN_PROMPT;

    const response = await client.chat.completions.create({
      model: LM_STUDIO_MODEL,
      messages: [
        {
          role: "system",
          content: "You are a precise MTG card identifier. Always respond with raw JSON only. Never use markdown or code fences.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUri } },
          ],
        },
      ],
      max_tokens: 1024,
      temperature: 0.1,
    });

    const content = response.choices[0]?.message?.content?.trim() ?? "";
    const parsed = extractJSON(content);

    if (!parsed || !parsed.name) {
      if (!jsonRetry) {
        console.error(`  Invalid JSON for ${fileName}, retrying...`);
        return scanCard(client, filePath, true, 0);
      }
      warnings.push(`card ${fileName}: model returned invalid JSON after retry`);
      return { card: null, warnings };
    }

    const confidence = isValidConfidence(parsed.confidence) ? parsed.confidence : "low";
    const card: DetectedCard = {
      name: sanitizeCardName(parsed.name?.trim() || "Unknown"),
      quantity: 1,
      confidence,
      sourcePhoto,
      gridPosition,
      setName: parsed.setName?.trim(),
      collectorNumber: parsed.collectorNumber?.trim(),
    };

    if (confidence === "low") {
      warnings.push(card);
      return { card: null, warnings };
    }

    return { card, warnings };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = (err as any)?.status ?? (err as any)?.statusCode ?? 0;
    const isRetryable = status === 429 || (status >= 500 && status < 600);

    if (isRetryable && apiRetries < MAX_RETRIES) {
      const delay = RETRY_BASE_MS * Math.pow(2, apiRetries);
      console.error(`  API error ${status} for ${fileName}. Retrying in ${delay}ms...`);
      await sleep(delay);
      return scanCard(client, filePath, jsonRetry, apiRetries + 1);
    }

    warnings.push(`card ${fileName}: API error (status ${status}): ${msg}`);
    return { card: null, warnings };
  }
}

// ── Validate Card ──────────────────────────────────────────────────────────

async function validateCard(
  client: OpenAI,
  filePath: string,
  detectedCard: DetectedCard,
  apiRetries = 0
): Promise<{ card: DetectedCard; correction?: string; flag?: string }> {
  try {
    const { buffer: imageBuffer, wasResized } = await resizeIfNeeded(filePath);
    const dataUri = imageToDataUri(imageBuffer, wasResized, filePath);

    const prompt = VALIDATION_PROMPT(detectedCard.name);

    const response = await client.chat.completions.create({
      model: LM_STUDIO_MODEL,
      messages: [
        {
          role: "system",
          content: "You are a precise MTG card validator. Always respond with raw JSON only. Never use markdown or code fences.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUri } },
          ],
        },
      ],
      max_tokens: 512,
      temperature: 0.1,
    });

    const content = response.choices[0]?.message?.content?.trim() ?? "";
    const parsed = extractJSON(content);

    if (!parsed || !parsed.correctName) {
      return {
        card: { ...detectedCard, validationStatus: "flagged" },
        flag: `${detectedCard.name} (${detectedCard.gridPosition}) — validation parse failed`,
      };
    }

    const correctedName = sanitizeCardName(parsed.correctName?.trim() || detectedCard.name);
    const valConfidence = parsed.confidence?.toLowerCase() || "low";

    if (correctedName.toLowerCase() === detectedCard.name.toLowerCase()) {
      return { card: { ...detectedCard, validatedName: detectedCard.name, validationStatus: "confirmed" } };
    } else if (valConfidence === "high" || valConfidence === "medium") {
      return {
        card: {
          ...detectedCard,
          name: correctedName,
          validatedName: correctedName,
          validationStatus: "corrected",
        },
        correction: `${detectedCard.name} → ${correctedName} (${detectedCard.gridPosition}) [${valConfidence}]`,
      };
    } else {
      return {
        card: { ...detectedCard, validatedName: correctedName, validationStatus: "flagged" },
        flag: `${detectedCard.name} → ${correctedName}? (${detectedCard.gridPosition}) [low confidence]`,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = (err as any)?.status ?? (err as any)?.statusCode ?? 0;
    const isRetryable = status === 429 || (status >= 500 && status < 600);

    if (isRetryable && apiRetries < MAX_RETRIES) {
      const delay = RETRY_BASE_MS * Math.pow(2, apiRetries);
      console.error(`  Validation API error ${status}. Retrying in ${delay}ms...`);
      await sleep(delay);
      return validateCard(client, filePath, detectedCard, apiRetries + 1);
    }

    return {
      card: { ...detectedCard, validationStatus: "flagged" },
      flag: `${detectedCard.name} (${detectedCard.gridPosition}) — validation API error`,
    };
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: npx tsx scan-cards.ts <photo-dir> [raw-cards-path]");
    process.exit(1);
  }

  const photoDir = resolve(args[0]);
  const outputPath = resolve(args[1] || "raw-cards.json");

  const croppedDir = resolve(photoDir, "cropped");
  if (!existsSync(croppedDir)) {
    console.error(`Error: Cropped directory not found: ${croppedDir}`);
    console.error("Run crop-cards.ts first to generate cropped card images.");
    process.exit(1);
  }

  const imageFiles = readdirSync(croppedDir)
    .filter(isImageFile)
    .sort()
    .map((f) => resolve(croppedDir, f));

  if (imageFiles.length === 0) {
    console.error(`Error: No image files found in ${croppedDir}`);
    process.exit(1);
  }

  console.error(`Found ${imageFiles.length} cropped image(s) in ${croppedDir}`);

  const client = new OpenAI({
    apiKey: "lm-studio",
    baseURL: LM_STUDIO_BASE_URL,
  });

  const allCards: DetectedCard[] = [];
  const allWarnings: (DetectedCard | string)[] = [];
  let totalValidated = 0;
  let totalCorrected = 0;
  let totalFlagged = 0;

  for (let i = 0; i < imageFiles.length; i++) {
    const filePath = imageFiles[i];
    const fileName = basename(filePath);

    console.error(`\nScanning ${i + 1}/${imageFiles.length}: ${fileName}`);

    const scanResult = await scanCard(client, filePath);

    if (scanResult.warnings.length > 0) {
      allWarnings.push(...scanResult.warnings);
    }

    if (!scanResult.card) {
      continue;
    }

    console.error(`  Validating: ${scanResult.card.name}`);
    const valResult = await validateCard(client, filePath, scanResult.card);

    allCards.push(valResult.card);
    totalValidated++;

    if (valResult.correction) {
      console.error(`  Corrected: ${valResult.correction}`);
      totalCorrected++;
    }
    if (valResult.flag) {
      console.error(`  Flagged: ${valResult.flag}`);
      allWarnings.push(valResult.flag);
      totalFlagged++;
    }
  }

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
  const highConfidenceCards = dedupedCards
    .filter((c) => c.confidence === "high" || c.confidence === "medium")
    .reduce((sum, c) => sum + c.quantity, 0);
  const uncertainCards = allWarnings
    .filter((w): w is DetectedCard => typeof w !== "string")
    .reduce((sum, w) => sum + w.quantity, 0);

  if (dedupedCards.length === 0) {
    console.error("Error: No cards confidently identified — check photo quality and LM Studio status");
    process.exit(1);
  }

  const output: RawCardsOutput = {
    metadata: {
      source: "photo-scan-v2",
      scanDate: new Date().toISOString(),
      photoDirectory: photoDir,
      croppedDirectory: croppedDir,
      cardsScanned: imageFiles.length,
      highConfidenceCards,
      uncertainCards,
      validatedCards: totalValidated,
      correctedCards: totalCorrected,
      flaggedCards: totalFlagged,
    },
    cards: dedupedCards,
    warnings: allWarnings,
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf-8");

  console.error(`\nDone! ${dedupedCards.length} unique cards detected (${totalCardsDetected} total).`);
  console.error(`Validation: ${totalValidated} validated, ${totalCorrected} corrected, ${totalFlagged} flagged`);
  if (uncertainCards > 0) {
    console.error(`Uncertain cards (review recommended): ${uncertainCards}`);
  }
  console.error(`\nOutput written to: ${outputPath}`);
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
