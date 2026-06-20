import type { ExtractedProductFields } from "@yara/contracts";
import { AllKeysBusyError, type KeyPool } from "./keyPool.js";
import {
  OpenRouterRateLimitError,
  type OpenRouterClient,
  type VisionContentPart,
  type VisionMessage,
} from "./openrouter.js";
import type { UsageTracker } from "./usage.js";
import type { TokenUsage } from "./types.js";

/**
 * Extracts structured product fields from a seller's photo(s) + caption using a
 * vision-capable model. Reuses the shared KeyPool (rotation) and UsageTracker
 * (budget accounting). Returns validated fields + a confidence score; throws
 * ExtractionError when the model output can't be parsed into a product.
 */

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionError";
  }
}

export interface ExtractInput {
  caption: string;
  imageRefs: string[];
}

export interface ExtractResult {
  fields: ExtractedProductFields;
  confidence: number;
}

export interface ExtractionDeps {
  openrouter: OpenRouterClient;
  keyPool: KeyPool;
  usage: UsageTracker;
  model: string;
}

const SYSTEM_PROMPT = [
  "You extract structured product data for an online shop from a product photo and its caption.",
  "The caption is usually Persian (Farsi). Respond with a SINGLE JSON object and nothing else.",
  "",
  "Schema (all keys required):",
  '{ "name": string, "price": integer, "currency": string,',
  '  "description": string, "sizes": string[], "colors": string[], "confidence": number }',
  "",
  "Rules:",
  "- name: a concise product title in the caption's language (Persian if the caption is Persian).",
  "- price: an INTEGER in the smallest sensible whole unit. Convert Persian/Arabic digits to Western",
  "  digits (۴۵۰ -> 450). Remove thousands separators. If the caption says تومان/toman keep the toman",
  "  amount; if it says ریال/rial keep the rial amount. If no price is present, use 0.",
  "- currency: 'IRT' for toman, 'IRR' for rial; default 'IRT' when a price exists but unit is unclear,",
  "  '' when there is no price.",
  "- description: any extra detail from the caption (material, fit, notes). Empty string if none.",
  "- sizes / colors: arrays of strings mentioned in the caption; empty arrays if none.",
  "- confidence: number 0..1 — your confidence the extraction is correct. Lower it when the caption is",
  "  vague, the price is guessed, or the photo and caption seem unrelated.",
  "Never invent a price or details not supported by the photo or caption.",
].join("\n");

/** Convert Persian (۰-۹) and Arabic-Indic (٠-٩) digits to ASCII. */
function normalizeDigits(input: string): string {
  return input.replace(/[۰-۹٠-٩]/g, (ch) => {
    const code = ch.charCodeAt(0);
    if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0);
    return String(code - 0x0660);
  });
}

/** Defensively coerce a model-provided price into a non-negative integer. */
function coercePrice(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(0, Math.round(raw));
  }
  if (typeof raw === "string") {
    const digits = normalizeDigits(raw).replace(/[^\d]/g, "");
    if (digits) return Math.max(0, parseInt(digits, 10));
  }
  return 0;
}

function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => String(v).trim()).filter((v) => v.length > 0);
}

function clampConfidence(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

export class ExtractionService {
  constructor(private readonly deps: ExtractionDeps) {}

  async extract(input: ExtractInput): Promise<ExtractResult> {
    const parts: VisionContentPart[] = [];
    const caption = input.caption.trim();
    parts.push({
      type: "text",
      text: caption.length > 0 ? `Caption:\n${caption}` : "Caption: (none provided)",
    });
    for (const url of input.imageRefs) {
      parts.push({ type: "image_url", image_url: { url } });
    }

    const messages: VisionMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: parts },
    ];

    const { text, usage } = await this.completeWithRotation(messages);

    if (usage && usage.totalTokens > 0) {
      // Account extraction usage under a synthetic, per-process bucket so it
      // shows up in budget reporting without colliding with chat users.
      await this.deps.usage.add("extract:product", usage).catch(() => undefined);
    }

    return this.parse(text);
  }

  /** Acquire a key and call the vision model; rotate on 429 before any output. */
  private async completeWithRotation(
    messages: VisionMessage[]
  ): Promise<{ text: string; usage?: TokenUsage }> {
    const available = this.deps.keyPool.availableCount();
    const maxAttempts = Math.max(1, available);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const lease = this.deps.keyPool.acquire();
      try {
        return await this.deps.openrouter.completeVision(lease.key, this.deps.model, messages);
      } catch (err) {
        if (err instanceof OpenRouterRateLimitError) {
          this.deps.keyPool.cooldown(lease.key, err.retryAfterMs);
          continue; // try the next key
        }
        throw err;
      } finally {
        lease.release();
      }
    }

    throw new AllKeysBusyError(Date.now() + 30_000);
  }

  private parse(raw: string): ExtractResult {
    let json: any;
    try {
      // Be tolerant of code fences or stray prose around the JSON object.
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      const slice = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
      json = JSON.parse(slice);
    } catch {
      throw new ExtractionError("model did not return valid JSON");
    }

    const name = typeof json.name === "string" ? json.name.trim() : "";
    if (!name) throw new ExtractionError("no product name extracted");

    const fields: ExtractedProductFields = {
      name,
      price: coercePrice(json.price),
      currency: typeof json.currency === "string" ? json.currency.trim() : "",
      description: typeof json.description === "string" ? json.description.trim() : "",
      sizes: asStringArray(json.sizes),
      colors: asStringArray(json.colors),
    };

    return { fields, confidence: clampConfidence(json.confidence) };
  }
}
