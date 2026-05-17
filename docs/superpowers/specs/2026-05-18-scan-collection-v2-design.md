# Scan Collection v2 — OpenCV Card Cropping + Single-Card Vision Scan

## Overview

Redesign the scan-collection skill to use OpenCV for card detection and cropping before vision scanning. Instead of sending full photos with 20+ cards to the vision model, crop each card into its own image first, then identify each card individually. This dramatically simplifies the vision model's task and improves accuracy.

## Architecture

Three-script pipeline, each independent, reading from and writing to disk:

```
crop-cards.ts    Photo dir → cropped/*.jpg
scan-cards.ts    cropped/*.jpg → raw-cards.json
enrich-cards.ts  raw-cards.json → photo-collection.json
```

### Data Flow

```
C:\Users\harry\Downloads\cards\
  ├── PXL_20260517_035519830.jpg
  ├── PXL_20260517_035627288.jpg
  └── cropped/                          ← created by crop-cards.ts
      ├── PXL_20260517_035519830_R1C1.jpg
      ├── PXL_20260517_035519830_R1C2.jpg
      ├── PXL_20260517_035519830_R1C3_uncertain.jpg
      └── ...

raw-cards.json                          ← created by scan-cards.ts
photo-collection.json                   ← created by enrich-cards.ts
```

## Script 1: crop-cards.ts

**Input:** Photo directory path
**Output:** `cropped/` subfolder with individual card images

### Algorithm

1. Load image via sharp → raw pixels → OpenCV Mat
2. Preprocess: grayscale → Gaussian blur → adaptive threshold
3. Find contours (external only — cards are distinct regions on the playmat)
4. For each contour:
   - Filter by area (must be >1% of image, <80% of image)
   - Approximate polygon with `approxPolyDP`
   - If 4 vertices → rectangle candidate
   - If not 4 vertices but large enough → save with `_uncertain` suffix
5. Sort detected rectangles top-to-bottom, left-to-right → assign R<row>C<col> positions
6. For each rectangle:
   - Apply perspective transform to straighten (standard MTG card aspect ratio 2.5:3.5)
   - Save as `<photo-name>_R<row>C<col>.jpg`
   - Uncertain crops get `_uncertain` suffix

### CLI Interface

```
npx tsx crop-cards.ts <photo-dir> [--min-area-pct 1] [--max-area-pct 80] [--card-ratio 0.714] [--ratio-tolerance 0.15]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--min-area-pct` | 1 | Minimum contour area as % of total image area |
| `--max-area-pct` | 80 | Maximum contour area as % of total image area |
| `--card-ratio` | 0.714 | Expected width:height ratio for MTG cards (2.5/3.5) |
| `--ratio-tolerance` | 0.15 | How much the detected ratio can deviate from card-ratio |

### Error Handling

- No contours found → error with suggestion to check photo quality/lighting
- Photo can't be read → skip + warn, continue with others
- OpenCV fails on an image → skip + warn, continue with others
- `cropped/` already exists → skip already-cropped images (resume support)

### Output

- Creates `<photo-dir>/cropped/` directory
- Each card image named `<photo-basename>_R<row>C<col>.jpg`
- Uncertain crops named `<photo-basename>_R<row>C<col>_uncertain.jpg`
- Prints summary: photos processed, cards cropped, uncertain crops, errors

## Script 2: scan-cards.ts

**Input:** Photo directory path (script auto-detects `<photo-dir>/cropped/` subfolder; falls back to scanning the directory itself if no `cropped/` subfolder exists)
**Output:** `raw-cards.json`

### CLI Interface

```
npx tsx scan-cards.ts <photo-dir> [raw-cards-path]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `<photo-dir>` | Yes | Path to photo directory (must contain `cropped/` subfolder from crop-cards.ts) |
| `[raw-cards-path]` | No | Where to write `raw-cards.json` (default: `raw-cards.json` in current directory) |

### Vision Model

Gemma 4 26B via LM Studio (local):
- Base URL: `http://localhost:1234/v1`
- Model: `gemma-4-26b-a4b`
- API key: `lm-studio` (placeholder, LM Studio doesn't require auth)

### Scan Prompt

```
Identify this MTG card. Output ONLY raw JSON:
{"name":"Card Name","setName":"Set Name","collectorNumber":"123","confidence":"high"}

No markdown. No code fences. No extra text.
```

System message: "You are a precise MTG card identifier. Always respond with raw JSON only. Never use markdown or code fences."

### Validation Prompt

```
Is this card named "X"? Confirm or correct the name. Output ONLY raw JSON:
{"originalName":"X","correctName":"Y","confidence":"high"}

No markdown. No code fences. No extra text.
```

System message: "You are a precise MTG card validator. Always respond with raw JSON only. Never use markdown or code fences."

### Algorithm

1. Read all `.jpg/.jpeg/.png/.webp` from the cropped directory
2. For each image, send to Gemma 4 with scan prompt
3. Parse response using robust JSON extraction (direct parse → markdown code block → brace-matching)
4. If JSON parse fails → retry once with stricter prompt
5. Run validation pass: send same image + detected name to Gemma 4 for confirmation/correction
6. Extract source photo and grid position from filename (e.g. `PXL_..._R1C2.jpg` → source=`PXL_...jpg`, position=`R1C2`)
7. Deduplicate by card name (case-insensitive), sum quantities
8. Output `raw-cards.json`

### Confidence Handling

- High + medium confidence → included in card list
- Low confidence → goes to warnings for user review

### JSON Extraction

Three-tier extraction strategy:
1. Direct `JSON.parse()` on the full response
2. Extract from markdown code blocks (````json ... ````)
3. Brace-matching: find first `{`, find matching `}`, parse the substring

This handles Gemma 4's tendency to wrap JSON in markdown or add preamble text.

### Sanitization

Strip LaTeX artifacts from card names (e.g. `$\text{V}$` → `V`), backslash commands, extra spaces.

### raw-cards.json Schema

```typescript
interface DetectedCard {
  name: string;
  quantity: number;
  confidence: "high" | "medium" | "low";
  sourcePhoto: string;        // original photo filename
  gridPosition: string;       // R<row>C<col> from cropped filename
  setName?: string;           // from vision model
  collectorNumber?: string;   // from vision model
  validatedName?: string;     // corrected name from validation step
  validationStatus?: "confirmed" | "corrected" | "flagged";
}

interface RawCardsOutput {
  metadata: {
    source: string;           // "photo-scan-v2"
    scanDate: string;         // ISO 8601
    photoDirectory: string;
    croppedDirectory: string;
    photosProcessed: number;
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
```

### Error Handling

- Invalid JSON after retry → skip card, add to warnings
- API error (429/5xx) → exponential backoff, 3 retries
- No cropped images found → error with suggestion to run crop-cards.ts first
- LM Studio not running → clear error message

## Script 3: enrich-cards.ts

**Unchanged from current implementation.** Reads `raw-cards.json`, enriches via Scryfall batch API (75 cards per batch, 550ms rate limit), fuzzy fallback for not-found cards, optional `--merge` flag to merge into existing `collection.json`.

The only difference is `raw-cards.json` now includes `setName` and `collectorNumber` fields which can improve Scryfall matching accuracy.

## SKILL.md — Updated Workflow

```
1. Ask user for photo directory path
2. Ask user whether to merge with existing collection.json (if one exists)
3. Run crop-cards.ts:
   cd .agents/skills/scan-collection/scripts && npx tsx crop-cards.ts <photo-dir>
4. User reviews cropped images (optional but recommended)
5. Run scan-cards.ts:
   cd .agents/skills/scan-collection/scripts && npx tsx scan-cards.ts <photo-dir>
6. Review raw-cards.json for warnings/uncertain cards
7. Run enrich-cards.ts:
   cd .agents/skills/scan-collection/scripts && npx tsx enrich-cards.ts <raw-cards-path> <output-path> [--merge]
8. Inform user of results
```

## Dependencies

| Package | Version | Purpose | Status |
|---------|---------|---------|--------|
| `@techstark/opencv-js` | ^4.11.0 | OpenCV WASM (contour detection, perspective transform) | **New** |
| `sharp` | ^0.33 | Image I/O (read/write, resize) | Already installed |
| `openai` | ^4 | OpenAI SDK for LM Studio API | Already installed |

### Installation

```bash
cd .agents/skills/scan-collection/scripts && npm install @techstark/opencv-js
```

No native build tools required — `@techstark/opencv-js` is pure WASM.

### OpenCV.js + sharp Bridge

OpenCV.js's `cv.imread()` doesn't work in Node.js (expects DOM). Use sharp for image I/O:

```typescript
// Read: sharp → raw pixels → OpenCV Mat
const { data, info } = await sharp(filePath).ensureAlpha().raw()
  .toBuffer({ resolveWithObject: true });
const mat = cv.matFromImageData({
  data: new Uint8ClampedArray(data),
  width: info.width,
  height: info.height,
});

// Write: OpenCV Mat → raw pixels → sharp → JPEG
const outBuf = await sharp(Buffer.from(mat.data), {
  raw: { width: mat.cols, height: mat.rows, channels: 4 },
}).jpeg({ quality: 90 }).toFile(outputPath);
```

### Memory Management

OpenCV.js Mats are not garbage-collected. Every Mat must have `.delete()` called when no longer needed. The script must use try/finally blocks to ensure cleanup even on errors.

## Files Changed

| File | Action | Description |
|------|--------|-------------|
| `scripts/crop-cards.ts` | **Create** | OpenCV card detection + cropping |
| `scripts/scan-cards.ts` | **Create** | Single-card vision scan + validation |
| `scripts/scan-photos.ts` | **Delete** | Replaced by crop-cards.ts + scan-cards.ts |
| `scripts/enrich-cards.ts` | **Modify** | Add setName/collectorNumber to Scryfall lookup |
| `scripts/package.json` | **Modify** | Add @techstark/opencv-js dependency |
| `SKILL.md` | **Modify** | Update workflow to 3-step pipeline |

## Troubleshooting

- **"No contours found"**: Photos may have poor contrast between cards and playmat. Try better-lit photos with a contrasting background.
- **"LM Studio not running"**: Start LM Studio and load the Gemma 4 model before scanning.
- **"Invalid JSON from model"**: Gemma 4 sometimes wraps JSON in markdown. The script handles this automatically with retry + brace-matching.
- **"npm install fails on sharp"**: Sharp requires native build tools on Windows. Install Visual Studio Build Tools or try `npm install --ignore-scripts` then `npm install sharp` separately.
- **Too many/few cards detected**: Adjust `--min-area-pct` and `--max-area-pct` flags on crop-cards.ts.
- **Cards not found on Scryfall**: The vision model may have misread a card name. Check `raw-cards.json` for typos.
