// ---------------------------------------------------------------------------
// RepurposeAI — server-side fluent machine translation via SambaNova.
//
// This is a TanStack Start server function, so this code runs ONLY on the
// server (never bundled into the client). It reads the SambaNova API key from
// the environment and calls the SambaNova inference endpoint to translate an
// executive summary into fluent Spanish, French and Hindi.
//
// It is the "primary" translation path. When the key is missing or the API call
// fails it returns `null`, and the caller falls back to the deterministic
// in-browser dictionary translation (the offline path) so the app never breaks.
//
// The key must be named exactly `SAMBANOVA_API_KEY` (the owner will set it).
// ---------------------------------------------------------------------------

import { createServerFn } from "@tanstack/react-start";

export interface LLMTranslations {
  spanish: string;
  french: string;
  hindi: string;
}

const SAMBANOVA_ENDPOINT = "https://api.sambanova.ai/v1/chat/completions";
// Stable, widely-available SambaNova model. Override with SAMBANOVA_MODEL if the
// owner prefers a different model ID.
const DEFAULT_MODEL = "Meta-Llama-3.3-70B-Instruct";

const SYSTEM_PROMPT =
  "You are an expert professional translator specializing in marketing and " +
  "business content. You translate faithfully yet fluently, producing text that " +
  "reads as if written by a native speaker of each target language — never a " +
  "word-for-word machine translation. You always preserve names, numbers, " +
  "dates, percentages and units exactly, and you never translate proper nouns, " +
  "brand names, company names or product names. You always answer with only the " +
  "requested JSON and nothing else.";

function buildPrompt(summary: string): string {
  return `Translate the following English executive summary into Spanish, French and Hindi.

Requirements for each translation:
- Faithful to the meaning: preserve every fact, argument and statistic.
- Fluent and natural: use correct native grammar, idiom, and word order for each language; it must read like a human wrote it.
- Keep numbers, dates, percentages, prices and units exactly as given in the source.
- Do NOT translate proper nouns, brand names, company names, or product names — leave them in their original language.
- Each translation is a single fluent paragraph mirroring the source's three sentences.

Return ONLY a single valid JSON object with exactly these three keys and no other text before or after:
{"spanish": "...", "french": "...", "hindi": "..."}

SOURCE (English executive summary):
"""
${summary}
"""`;
}

/** Try to pull the three translations out of the model's raw output. */
function parseTranslations(content: string): LLMTranslations | null {
  const jsonBlock = content.match(/\{[\s\S]*\}/);
  if (!jsonBlock) return null;
  try {
    const obj = JSON.parse(jsonBlock[0]);
    const spanish = obj.spanish ?? obj.Spanish ?? null;
    const french = obj.french ?? obj.French ?? null;
    const hindi = obj.hindi ?? obj.Hindi ?? null;
    if (
      typeof spanish !== "string" ||
      typeof french !== "string" ||
      typeof hindi !== "string" ||
      !spanish.trim() ||
      !french.trim() ||
      !hindi.trim()
    ) {
      return null;
    }
    return { spanish: spanish.trim(), french: french.trim(), hindi: hindi.trim() };
  } catch {
    return null;
  }
}

export const translateSummaryLLM = createServerFn({ method: "POST" })
  .validator((d: unknown): string => (typeof d === "string" ? d : ""))
  .handler(async ({ data }): Promise<LLMTranslations | null> => {
    const apiKey = process.env.SAMBANOVA_API_KEY;
    // No key → offline dictionary path.
    if (!apiKey) return null;

    const text = (data || "").trim();
    if (!text) return null;

    const model = process.env.SAMBANOVA_MODEL || DEFAULT_MODEL;

    try {
      const res = await fetch(SAMBANOVA_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildPrompt(text) },
          ],
          temperature: 0.2,
          max_tokens: 1500,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return null;

      const dataJson: { choices?: { message?: { content?: string } }[] } =
        await res.json();
      const content = dataJson?.choices?.[0]?.message?.content ?? "";
      return parseTranslations(content);
    } catch {
      // Any network / parse failure → offline dictionary path.
      return null;
    }
  });
