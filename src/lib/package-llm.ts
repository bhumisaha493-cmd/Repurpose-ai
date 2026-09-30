// ---------------------------------------------------------------------------
// RepurposeAI — server-side final edit of the marketing package via SambaNova.
//
// This is a TanStack Start server function, so this code runs ONLY on the
// server (never bundled into the client). It reads the SambaNova API key from
// environment (`SAMBANOVA_API_KEY`) and asks the model to act as the FINAL
// EDITOR of the deterministic package: review the draft, remove every
// repetition/duplication across sections, rewrite the social kit so each
// platform has unique hooks/examples/formatting, keep at most one mention per
// concept, and return the same shape as MarketingResult.
//
// It is an optional "polish" path. When the key is missing or the API call or
// the response fails, it returns `null` and the caller keeps the deterministic
// in-browser package (which already satisfies the anti-repetition rules) so the
// app never breaks.
//
// The key must be named exactly `SAMBANOVA_API_KEY` (the owner sets it); the
// model can be overridden with SAMBANOVA_MODEL, matching llm-translate.ts.
// ---------------------------------------------------------------------------

import { createServerFn } from "@tanstack/react-start";

export interface LLMPackage {
  summary: string[];
  takeaways: string[];
  social: {
    x: { text: string; hashtags: string };
    linkedin: string;
    instagram: { visual: string; caption: string; hashtags: string };
  };
}

/** The draft the browser sends up: same shape as the engine's SocialKit. */
export interface PackageDraftInput {
  summary: string[];
  takeaways: string[];
  keywords?: string[];
  social: {
    x: { text: string; hashtags: string };
    linkedin: string;
    instagram: { visual: string; caption: string; hashtags: string };
  };
}

export interface RefinePackageInput {
  text: string;
  draft: PackageDraftInput;
}

const SAMBANOVA_ENDPOINT = "https://api.sambanova.ai/v1/chat/completions";
// Kept identical to llm-translate.ts so one env var covers both paths.
const DEFAULT_MODEL = "Meta-Llama-3.3-70B-Instruct";

export const REFINE_SYSTEM_PROMPT =
  "You are the FINAL EDITOR of a marketing package (executive summary, key " +
  "takeaways, and a social media kit for X, LinkedIn and Instagram). Your job " +
  "is to review the draft you are given and return a cleaned, strictly " +
  "non-repetitive version of it, faithfully preserving its meaning, facts, " +
  "names, numbers and percentages. You never invent facts that are not in the " +
  "source text or the draft.\n" +
  "\n" +
  "NON-REPETITION RULES (apply to every response, without exception):\n" +
  "1. Remove ALL repetition and duplication across sections. Before you return " +
  "the package, review it and delete any sentence or paragraph that repeats the " +
  "same core technologies, examples, names, statistics, quotes or phrases " +
  "already used above. Never repeat a technology or stack block such as \"Java, " +
  "Spring Boot, Kafka\" anywhere in the package — mention it once, then refer to " +
  "it only in different words, or not at all.\n" +
  "2. Rewrite the social kit so each platform has completely different hooks, " +
  "examples, formatting and opening lines: the X post is a sharp short hook " +
  "with hashtags, the LinkedIn post is a professional narrative with bullets in " +
  "business voice, and the Instagram caption is a visual-first, curious or " +
  "benefit-driven angle. Never recycle identical (or lightly edited) text " +
  "between platforms, and never paste a summary or takeaway sentence verbatim " +
  "into a platform post.\n" +
  "3. Keep every list and bullet set to a MAXIMUM of one distinct mention per " +
  "concept. If an example, name, metric, quote or technology block was already " +
  "used above, do not restate it under a new heading, bullet or platform, and " +
  "do not pad lists with paraphrases of items already listed. Different " +
  "platforms must naturally use different subsets of the source material.\n" +
  "\n" +
  "Always answer with a single valid JSON object and nothing else.";

function buildRefinePrompt(text: string, draft: PackageDraftInput): string {
  const source = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
  return `Edit the following marketing package so that it contains NO repetition.

SOURCE DOCUMENT (for fact-checking only — do not copy sentences from it):
"""
${source}
"""

DRAFT PACKAGE (JSON):
${JSON.stringify(draft, null, 2)}

Editing instructions:
- Keep the executive summary at up to 3 sentences, the takeaways at up to 5 bullets, and keep the same three social platforms.
- Remove duplicated facts: if two lines share the same example, metric, name or technology block, keep the better one and delete or genuinely rephrase the other with different information or a different angle.
- Each platform must use its own hook, its own examples and its own formatting. No sentence may appear on two platforms, and no platform line may be a copy of a summary or takeaway sentence.
- Hashtags may stay the same across platforms (hashtags are labels, not prose).
- Preserve the draft's meaning, tone and every number it contains; do not add new claims.

Return ONLY a single valid JSON object with exactly these keys and no other text before or after:
{"summary": ["..."], "takeaways": ["..."], "social": {"x": {"text": "...", "hashtags": "..."}, "linkedin": "...", "instagram": {"visual": "...", "caption": "...", "hashtags": "..."}}}`;
}

function asStringArray(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim())
    .slice(0, max);
  return out.length ? out : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Pull a refined package out of the model's raw output, or null if unusable. */
export function parsePackage(content: string): LLMPackage | null {
  const jsonBlock = content.match(/\{[\s\S]*\}/);
  if (!jsonBlock) return null;
  try {
    const obj = JSON.parse(jsonBlock[0]) as Record<string, unknown>;
    const summary = asStringArray(obj.summary, 3);
    const takeaways = asStringArray(obj.takeaways, 5);
    const social = (obj.social ?? {}) as Record<string, unknown>;
    const x = (social.x ?? {}) as Record<string, unknown>;
    const instagram = (social.instagram ?? {}) as Record<string, unknown>;
    const xText = asString(x.text);
    const linkedin = asString(social.linkedin);
    const visual = asString(instagram.visual);
    const caption = asString(instagram.caption);
    if (!summary || !takeaways || !xText || !linkedin || !visual || !caption) return null;
    return {
      summary,
      takeaways,
      social: {
        x: { text: xText, hashtags: asString(x.hashtags) ?? "" },
        linkedin,
        instagram: {
          visual,
          caption,
          hashtags: asString(instagram.hashtags) ?? "",
        },
      },
    };
  } catch {
    return null;
  }
}

export const refinePackageLLM = createServerFn({ method: "POST" })
  .validator((d: unknown): RefinePackageInput => {
    if (!d || typeof d !== "object") return { text: "", draft: null as never };
    const input = d as { text?: unknown; draft?: unknown };
    return {
      text: typeof input.text === "string" ? input.text : "",
      draft: (input.draft ?? null) as PackageDraftInput,
    };
  })
  .handler(async ({ data }): Promise<LLMPackage | null> => {
    const apiKey = process.env.SAMBANOVA_API_KEY;
    // No key → the deterministic in-browser package is already the answer.
    if (!apiKey) return null;

    const draft = data?.draft;
    const text = (data?.text ?? "").trim();
    if (!draft || typeof draft !== "object" || !Array.isArray(draft.summary)) return null;

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
            { role: "system", content: REFINE_SYSTEM_PROMPT },
            { role: "user", content: buildRefinePrompt(text, draft) },
          ],
          temperature: 0.2,
          max_tokens: 2000,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return null;

      const dataJson: { choices?: { message?: { content?: string } }[] } = await res.json();
      const content = dataJson?.choices?.[0]?.message?.content ?? "";
      return parsePackage(content);
    } catch {
      // Any network / parse failure → keep the deterministic package.
      return null;
    }
  });
