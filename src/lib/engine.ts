// ---------------------------------------------------------------------------
// RepurposeAI — self-contained in-browser content engine.
//
// This module turns a long-form document (article / transcript / notes) into a
// complete marketing package. It is 100% deterministic and runs entirely in the
// browser: no network calls, no API keys, no credentials.
//
// ARCHITECTURE NOTE: everything the UI needs flows through ONE entry function:
//
//     generateMarketingPackage(text) => MarketingResult
//
// A real LLM integration can be dropped in later by re-implementing just that
// function (or one of the helpers below) — the UI depends only on the shape of
// MarketingResult and never touches the internals. Keep this contract stable.
// ---------------------------------------------------------------------------

export interface SocialKit {
  x: { text: string; hashtags: string };
  linkedin: string;
  instagram: { visual: string; caption: string; hashtags: string };
}

export interface MarketingResult {
  /** 3-sentence executive summary. */
  summary: string[];
  /** 5 punchy key takeaways, one per bullet. */
  takeaways: string[];
  /** Ready-to-copy social posts. */
  social: SocialKit;
  /** Multilingual translations of the executive summary. */
  translations: {
    spanish: string;
    french: string;
    hindi: string;
  };
  /** Top discovered keywords / key-phrases (used for hashtags etc.). */
  keywords: string[];
}

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  (
    "a about above after again against all also am an and any are as at be because been before being below between " +
    "both but by can could did do does doing down during each few for from further had has have having he her here " +
    "hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of " +
    "off on once only or other our ours ourselves out over own same she should so some such than that the their " +
    "theirs them themselves then there these they this those through to too under until up very was we were what " +
    "when where which while who whom why will with would you your yours yourself yourselves " +
    "about into onto upon across along around behind beyond down past through throughout toward towards under " +
    "us via within without"
  )
    .trim()
    .split(/\s+/),
);

/** Split text into sentences on terminal punctuation (keeps the period). */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

/** Lowercased alphabetic/numeric word tokens (ignores punctuation). */
function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+(?:['’-][a-z0-9]+)*/g) ?? []).filter(
    (w) => w.length > 1,
  );
}

/** Count content-word frequency, excluding stopwords and our own topic words. */
function freqMap(text: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens(text)) {
    if (STOPWORDS.has(t)) continue;
    m.set(t, (m.get(t) ?? 0) + 1);
  }
  return m;
}

/** Score a sentence by how many of the document's keywords it contains. */
function scoreSentence(sentence: string, weights: Map<string, number>): number {
  let score = 0;
  for (const t of tokens(sentence)) {
    const w = weights.get(t);
    if (w !== undefined) score += w;
  }
  return score + sentence.length / 2000; // tiny tiebreak for descriptive sentences
}

// (sentence selection is now performed by the builders, each of which filters
// its candidates through the shared DedupLedger — see buildSummary below.)

/** Trim a sentence to a reasonable length for use in a summary/takeaway. */
function trimSentence(s: string, max = 220): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const last = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf(","), cut.lastIndexOf(";"));
  if (last > max * 0.5) return cut.slice(0, last).replace(/[,;:]+$/, "") + "…";
  return cut.replace(/[,;:\s]+$/, "") + "…";
}

function capitalize(s: string): string {
  s = s.trim();
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1);
}

function ensureEnd(s: string): string {
  return /[.!?…]$/.test(s.trim()) ? s.trim() : s.trim() + ".";
}

function stripTrailingPunct(s: string): string {
  return s.trim().replace(/[.!?…]+$/, "");
}

/** Title-case a phrase (best effort). */
function keyphraseCase(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// De-duplication ledger — the anti-repetition rules, enforced in code
// ---------------------------------------------------------------------------
//
// HARD INVARIANTS of generateMarketingPackage() (Requirement A):
//
//   1. NO REPEATS. No sentence or paragraph may appear twice anywhere in the
//      package (summary + takeaways + social kit). Builders *propose* text and
//      the ledger accepts or rejects it; buildTakeaways can therefore never
//      return a sentence already used by buildSummary, and the summary itself
//      can never contain a duplicate line.
//   2. PLATFORM VARIETY. X, LinkedIn and Instagram never share verbatim (or
//      near-verbatim) sentences — each platform pulls different source
//      sentences and writes them in its own voice/frame.
//   3. ONE MENTION PER CONCEPT. A multi-term block such as
//      "Java, Spring Boot, Kafka" is emitted exactly once, and a discovered
//      keyword is referenced in builder-authored prose by at most one
//      platform (each platform naturally uses a different subset).
//
// Hashtag lines are deliberately exempt: hashtags are labels, not prose, so the
// same hashtag line may appear on more than one platform.

/** Function words ignored when comparing two sentences for identity. */
const FILLER_WORDS = new Set(
  (
    "a an the and or but of to in on at by for with is are was were be been " +
    "being it its this that these those as from then than there here also very " +
    "just only even so such"
  )
    .trim()
    .split(/\s+/),
);

/**
 * Normalised identity key for a sentence: lowercase, punctuation stripped,
 * filler words removed. Two sentences with the same key are the same sentence.
 */
export function dedupKey(text: string): string {
  return tokens(text)
    .filter((w) => !FILLER_WORDS.has(w))
    .join(" ");
}

/** Content words of a piece of text (stopwords + filler removed). */
function contentTerms(text: string, ignore?: Set<string>): Set<string> {
  const set = new Set<string>();
  for (const w of tokens(text)) {
    if (STOPWORDS.has(w) || FILLER_WORDS.has(w)) continue;
    if (ignore?.has(w)) continue;
    set.add(w);
  }
  return set;
}

/**
 * Multi-term lists inside a sentence — "Java, Spring Boot, Kafka" and friends.
 * Returned as term sets so a recycled stack/example block is detectable even
 * when the terms are reordered or split across sections and platforms.
 */
function termLists(text: string): Set<string>[] {
  const out: Set<string>[] = [];
  const word = "[A-Za-z][A-Za-z0-9.+#-]{2,}(?:\\s+[A-Za-z][A-Za-z0-9.+#-]{2,})?";
  const re = new RegExp(`${word}(?:\\s*(?:,|&|\\/|\\band\\b)\\s*${word})+`, "g");
  for (const run of text.match(re) ?? []) {
    const terms = run
      .split(/\s*(?:,|&|\/|\band\b)\s*/i)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    if (terms.length < 2) continue;
    const set = new Set<string>();
    for (const t of terms) for (const w of tokens(t)) if (!STOPWORDS.has(w)) set.add(w);
    if (set.size >= 2) out.push(set);
  }
  return out;
}

/** True when every token of the keyword phrase occurs in the text. */
function mentionsKeyword(keyword: string, text: string): boolean {
  const words = tokens(text);
  const parts = tokens(keyword);
  return parts.length > 0 && parts.every((p) => words.includes(p));
}

// ---------------------------------------------------------------------------
// Concept registry — "one distinct mention per concept", package-wide
// ---------------------------------------------------------------------------
//
// A *concept* is the kind of thing the owner complained about seeing two or
// three times in one package: a technology/proper name ("Java", "Spring
// Boot", "Kafka"), a multi-word key-phrase ("remote work"), a numeric metric
// ("2.5 million", "99.99%", "60%", "threefold") or a named example block.
//
// Every emitted line registers the concepts it introduces; every later line is
// tested against those registrations and rejected when it re-uses one — this is
// what makes the claimed-set flow from buildSummary → buildTakeaways →
// buildSocial.
//
// Matching is done *from the claim*, not from the candidate, so a repeat is
// caught even when it is re-worded, re-cased ("Java" alone instead of "Java and
// Spring Boot") or moved to a different section/platform.

/** Numeric metrics: "2.5 million", "800,000", "99.99%", "60%", "40". */
const NUMBER_RE = /\d[\d,]*(?:\.\d+)?\s*(?:%|percent\b|million\b|billion\b|thousand\b|k\b|x\b)?/gi;
/** Word-shaped multipliers stand in for numbers ("threefold" → "3x"). */
const MULTIPLIER_RE =
  /\b(?:two|three|four|five|ten)[- ]?fold\b|\b(?:double|triple|quadruple)(?:d|s)?\b/gi;
const MULTIPLIER_VALUE: Record<string, string> = {
  twofold: "2x",
  threefold: "3x",
  fourfold: "4x",
  fivefold: "5x",
  tenfold: "10x",
  double: "2x",
  doubled: "2x",
  doubles: "2x",
  triple: "3x",
  tripled: "3x",
  triples: "3x",
  quadruple: "4x",
};

/** Normalised identifier for a word-shaped concept ("Spring" → "spring"). */
function normalizeLabel(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function numberKeys(text: string): string[] {
  const out: string[] = [];
  for (const m of text.match(NUMBER_RE) ?? []) {
    const key = m.toLowerCase().replace(/[\s,]/g, "");
    if (key) out.push("n:" + key);
  }
  for (const m of text.match(MULTIPLIER_RE) ?? []) {
    const value = MULTIPLIER_VALUE[normalizeLabel(m)];
    if (value) out.push("n:" + value);
  }
  return out;
}

/**
 * Tokens the document itself writes in lowercase. A capitalised token that the
 * source also spells lowercase ("Written" opening a clause after a colon, when
 * the article says "written") is ordinary prose, not a name — so it must not
 * become a concept and must not block a later sentence.
 */
function lowercaseWordSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.match(/[A-Za-z][A-Za-z0-9'’-]*/g) ?? []) {
    if (raw === raw.toLowerCase()) out.add(normalizeLabel(raw));
  }
  return out;
}

/**
 * Capitalised tokens that are not merely the opener of a sentence: the tech
 * names, products and people a package must mention only once.
 */
function properNounKeys(
  text: string,
  lowercaseWords: Set<string> = new Set(),
  keywordTokens: Set<string> = new Set(),
): string[] {
  const out: string[] = [];
  for (const sentence of splitSentences(text)) {
    const first = normalizeLabel(sentence.trim().split(/\s+/)[0] ?? "");
    for (const raw of sentence.match(/\b[A-Z][A-Za-z0-9.+#-]{2,}\b/g) ?? []) {
      const key = normalizeLabel(raw);
      if (key.length < 3) continue;
      // Function words are never names, even when they open a clause after a
      // colon ("...: The lesson is simple") — they must not become concepts.
      if (STOPWORDS.has(key) || FILLER_WORDS.has(key)) continue;
      if (lowercaseWords.has(key)) continue;
      const techShaped = /[0-9.+#]/.test(raw) || raw === raw.toUpperCase();
      // A sentence opener is normally just prose, but when it is a technology
      // the document is about ("Kafka is the quiet through-line…") it is a
      // name like any other and must be claimed exactly once.
      if (key === first && !techShaped && !keywordTokens.has(key)) continue;
      out.push("w:" + key);
    }
  }
  return out;
}

/** A single claimed concept plus the test that detects it in later prose. */
interface ConceptMatcher {
  key: string;
  test: (text: string) => boolean;
}

/** Concepts introduced by `text`, with the matcher used to spot re-use. */
function conceptMatchers(
  text: string,
  keywords: string[],
  lowercaseWords: Set<string> = new Set(),
): ConceptMatcher[] {
  const out: ConceptMatcher[] = [];
  const seen = new Set<string>();
  const push = (key: string, test: (t: string) => boolean) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, test });
  };

  const keywordTokens = new Set<string>();
  for (const kw of keywords) for (const w of tokens(kw)) keywordTokens.add(w);

  for (const key of properNounKeys(text, lowercaseWords, keywordTokens)) {
    const word = key.slice(2);
    push(key, (t) => tokens(t).includes(word));
  }
  for (const key of numberKeys(text)) {
    push(key, (t) => numberKeys(t).includes(key));
  }
  for (const kw of keywords) {
    if (tokens(kw).length < 2 || !mentionsKeyword(kw, text)) continue;
    push("kw:" + tokens(kw).join(" "), (t) => mentionsKeyword(kw, t));
  }
  return out;
}

/**
 * Exported for the audit script: the normalised concepts a piece of text
 * claims. The engine itself never needs this directly — verifyMarketingPackage
 * uses it to re-prove the one-mention-per-concept rule from the outside.
 */
export function extractConcepts(
  text: string,
  keywords: string[] = [],
  lowercaseWords: Set<string> = new Set(),
): string[] {
  return conceptMatchers(text, keywords, lowercaseWords).map((m) => m.key);
}

type Section = "summary" | "takeaways" | "x" | "linkedin" | "instagram";

const PLATFORM_SECTIONS = new Set<Section>(["x", "linkedin", "instagram"]);

/**
 * The ledger every builder must route prose through. `accept()` returns false
 * when a proposed line repeats something already in the package, so the caller
 * simply moves on to its next candidate.
 */
class DedupLedger {
  /** Keywords discovered in the source document (candidate hashtags/topics). */
  readonly keywords: string[];
  /** Normalised keys of every emitted sentence. */
  private keys = new Set<string>();
  /** Every emitted sentence, for near-duplicate comparison. */
  private emitted: string[] = [];
  /** Term sets of every multi-term block emitted so far. */
  private blocks: Set<string>[] = [];
  /** Keywords already mentioned anywhere in the package's prose. */
  private mentioned = new Set<string>();
  /** Keyword → section that used it in builder-authored prose. */
  private builderUse = new Map<string, Section>();
  /** Tokens of the keywords: ignored by similarity (concept rule covers them). */
  private ignore = new Set<string>();
  /** Concept key → the section that claimed it (the shared claimed-set). */
  private claims = new Map<string, { section: Section; matcher: ConceptMatcher }>();
  /** Lowercase spellings in the source: which capitals are ordinary prose. */
  private lowercaseWords: Set<string>;

  section: Section = "summary";

  constructor(keywords: string[], lowercaseWords: Set<string> = new Set()) {
    this.keywords = keywords.filter(Boolean);
    this.lowercaseWords = lowercaseWords;
    for (const kw of this.keywords) for (const w of tokens(kw)) this.ignore.add(w);
  }

  /** All text recorded so far is attributed to `section`. */
  begin(section: Section) {
    this.section = section;
  }

  /**
   * Partition the keyword pool: hand `n` keywords to the current platform.
   * Only keywords that are NOT yet claimed anywhere in the package are handed
   * out — a keyword the summary already mentioned (or that matches an already
   * claimed concept, such as a technology name) stays claimed, so the platform
   * simply gets fewer keywords and falls back to its own generic framing. This
   * is what stops "Spring Boot" and "Kafka" being re-used as post hooks.
   */
  takeKeywords(n: number): string[] {
    const out: string[] = [];
    for (const kw of this.keywords) {
      if (out.length >= n) break;
      if (this.builderUse.has(kw) || out.includes(kw)) continue;
      if (this.mentioned.has(kw)) continue;
      if (this.isConceptClaimed(kw)) continue;
      out.push(kw);
    }
    for (const kw of out) this.builderUse.set(kw, this.section);
    return out;
  }

  /** Does `text` re-use a concept that some earlier line already claimed? */
  isConceptClaimed(text: string): boolean {
    for (const claim of this.claims.values()) {
      if (claim.matcher.test(text)) return true;
    }
    return false;
  }

  /** Would `text` repeat (or restate) something already emitted? */
  isRepeat(text: string): boolean {
    const key = dedupKey(text);
    if (!key) return true;
    if (this.isBare(text)) return true; // never emit "Spring Boot." as a line
    if (this.keys.has(key)) return true;
    if (this.nearDuplicate(text)) return true;
    if (this.reusesBlock(text)) return true;
    // Rule 3, package-wide: one distinct mention per concept.
    if (this.isConceptClaimed(text)) return true;
    // Rule 3: a keyword claimed by another platform must not reappear here.
    if (PLATFORM_SECTIONS.has(this.section)) {
      for (const kw of this.keywords) {
        const owner = this.builderUse.get(kw);
        if (owner && owner !== this.section && mentionsKeyword(kw, text)) return true;
      }
    }
    return false;
  }

  /** Emit `text` unless it repeats anything already in the package. */
  accept(text: string): boolean {
    const t = text.trim();
    if (!t || this.isRepeat(t)) return false;
    this.record(t);
    return true;
  }

  /** Record a line unconditionally (only used for unique fallback copy). */
  force(text: string): string {
    const t = text.trim();
    if (t) this.record(t);
    return t;
  }

  private record(text: string) {
    this.keys.add(dedupKey(text));
    this.emitted.push(text);
    for (const b of termLists(text)) this.blocks.push(b);
    // Register every concept this line introduces; later lines are tested
    // against these registrations (summary → takeaways → social kit).
    for (const matcher of conceptMatchers(text, this.keywords, this.lowercaseWords)) {
      if (!this.claims.has(matcher.key)) this.claims.set(matcher.key, { section: this.section, matcher });
    }
    // A keyword that a platform's own copy mentions is claimed for that
    // platform, so no other platform can mention the same concept again.
    const platform = PLATFORM_SECTIONS.has(this.section);
    for (const kw of this.keywords) {
      if (!mentionsKeyword(kw, text)) continue;
      this.mentioned.add(kw);
      if (platform && !this.builderUse.has(kw)) this.builderUse.set(kw, this.section);
    }
  }

  /**
   * A line with no substance of its own — a bare keyword ("Kafka."), a re-cased
   * technology list, or anything shorter than a real sentence. These are never
   * acceptable as a takeaway or a post line, however good they look in a score
   * ranking, so the candidate is rejected and the builder moves on.
   */
  private isBare(text: string): boolean {
    const words = tokens(text);
    if (words.length < 3) return true;
    for (const w of words) {
      if (STOPWORDS.has(w) || FILLER_WORDS.has(w)) continue;
      if (/^\d+$/.test(w)) continue;
      if (this.ignore.has(w)) continue; // a discovered keyword, not prose
      return false; // a plain content word → real sentence
    }
    return true;
  }

  /** Same idea, different words ("no restating the same sentence again"). */
  private nearDuplicate(text: string): boolean {
    const t = contentTerms(text, this.ignore);
    if (t.size < 3) return false;
    for (const prev of this.emitted) {
      const p = contentTerms(prev, this.ignore);
      if (p.size < 3) continue;
      let shared = 0;
      for (const w of t) if (p.has(w)) shared++;
      if (shared < 3) continue;
      if (shared / Math.min(t.size, p.size) >= 0.95) return true;
      if (shared / Math.max(t.size, p.size) >= 0.72) return true;
    }
    return false;
  }

  /** A reused multi-term block ("Java, Spring Boot, Kafka") is a duplicate. */
  private reusesBlock(text: string): boolean {
    for (const list of termLists(text)) {
      for (const prev of this.blocks) {
        let shared = 0;
        for (const w of list) if (prev.has(w)) shared++;
        if (shared >= 2 && shared >= 0.6 * Math.min(list.size, prev.size)) return true;
      }
    }
    return false;
  }
}

/** Try each candidate in order and return the first the ledger accepts. */
function firstAccepted(
  ledger: DedupLedger,
  candidates: (string | null | undefined)[],
): string | null {
  for (const c of candidates) {
    if (!c) continue;
    const line = ensureEnd(c.trim());
    if (ledger.accept(line)) return line;
  }
  return null;
}

/**
 * First acceptable line from a hand-written, concept-free fallback pool. Used
 * when a section has run out of unique source material: the package prefers
 * well-crafted generic copy over repeating anything already said.
 */
function fallbackLine(ledger: DedupLedger, lines: string[]): string {
  return firstAccepted(ledger, lines) ?? ledger.force(lines[0]);
}

// ---------------------------------------------------------------------------
// Rewriting — same fact, different wording, per platform
// ---------------------------------------------------------------------------

type Platform = "x" | "linkedin" | "instagram";

/** Safe 1:1 substitutions that turn source prose into marketing voice. */
const SYNONYMS: [RegExp, string][] = [
  [/\bshows\b/gi, "demonstrates"],
  [/\bshowed\b/gi, "demonstrated"],
  [/\bshow\b/gi, "demonstrate"],
  [/\bhelps\b/gi, "enables"],
  [/\bhelped\b/gi, "enabled"],
  [/\bhelp\b/gi, "enable"],
  [/\buses\b/gi, "leverages"],
  [/\bused\b/gi, "leveraged"],
  [/\busing\b/gi, "leveraging"],
  [/\buse\b/gi, "leverage"],
  [/\bbuilds\b/gi, "develops"],
  [/\bbuilt\b/gi, "developed"],
  [/\bbuilding\b/gi, "developing"],
  [/\bbuild\b/gi, "develop"],
  [/\bmakes\b/gi, "creates"],
  [/\bmade\b/gi, "created"],
  [/\bmake\b/gi, "create"],
  [/\bgets\b/gi, "achieves"],
  [/\bget\b/gi, "achieve"],
  [/\bwants\b/gi, "aims"],
  [/\bwant\b/gi, "aim"],
  [/\bneeds\b/gi, "requires"],
  [/\bneed\b/gi, "require"],
  [/\bfinds\b/gi, "identifies"],
  [/\bfind\b/gi, "identify"],
  [/\bimportant\b/gi, "critical"],
  [/\bcrucial\b/gi, "essential"],
  [/\bbig\b/gi, "significant"],
  [/\bchanges\b/gi, "shifts"],
  [/\bchange\b/gi, "shift"],
  [/\bgoals\b/gi, "objectives"],
  [/\bgoal\b/gi, "objective"],
  [/\bmuch\b/gi, "a great deal"],
];

/** Per-platform templates, so the three posts never read alike. */
const FRAMES: Record<Platform, string[]> = {
  x: [
    "Straight to it: {body} — that's the bit worth copying.",
    "The compressed read: {body}, and that detail compounds.",
    "One line on it: {body} — the part most write-ups bury.",
  ],
  linkedin: [
    "In practice: {body}. That is where the real work sits for most teams.",
    "For teams, the practical read is this: {body}. The implication is strategic, not cosmetic.",
    "Practically speaking: {body}; the commercial payoff shows up the following quarter.",
  ],
  instagram: [
    "Here's the idea: {body} — the kind of detail people save.",
    "Think about it: {body}. Small change, noticeable difference.",
    "Worth remembering: {body} — screenshot-worthy, honestly.",
  ],
};

/** Short, punchy bullets for the LinkedIn "What stands out" list. */
const BULLET_TEMPLATES = [
  "{body} — that detail is the whole game.",
  "The bit that actually moved the needle: {body}.",
  "{body}. Small lever, outsized return.",
];

/** Concept-free LinkedIn bullets, used when no unique source material is left. */
const BULLET_FALLBACKS = [
  "Lead with the outcome the reader cares about.",
  "Name the constraint before you name the fix.",
  "Show the before and after, not the theory in between.",
  "Keep one number per claim — it earns the rest of the sentence.",
];

/** Rotate a template list so each item in a platform opens differently. */
function rotate<T>(items: T[], by: number): T[] {
  const n = items.length;
  const offset = ((by % n) + n) % n;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

function applySynonyms(text: string): string {
  let out = text;
  for (const [re, rep] of SYNONYMS) {
    out = out.replace(re, (m) =>
      /^[A-Z]/.test(m) ? rep.charAt(0).toUpperCase() + rep.slice(1) : rep,
    );
  }
  return out;
}

/**
 * Compress a source sentence to one main clause with a different shape: the
 * trailing rationale is dropped and the verb is swapped by applySynonyms(), so
 * a platform line can never be a copy of the source sentence it came from.
 */
function compressClause(source: string, maxChars: number): string {
  let s = applySynonyms(stripTrailingPunct(source.trim()));
  // Drop a discourse lead-in ("The lesson is simple: …") so the compressed
  // clause starts on the actual point.
  const lead = s.match(/^the (?:lesson|point|takeaway|headline|idea) is (?:simple|clear|this)[:,]?\s*(.+)$/i);
  if (lead && lead[1].split(/\s+/).length >= 4) s = lead[1];
  const cut = s.search(/[,;]|\s(?:because|which|while|although|whereas)\s/i);
  if (cut > 25) s = s.slice(0, cut);
  const words = s.split(/\s+/);
  if (words.length > 14) {
    words.length = 14;
    // Never leave a dangling function word behind after the cut.
    while (
      words.length > 5 &&
      (STOPWORDS.has(words[words.length - 1].toLowerCase()) ||
        FILLER_WORDS.has(words[words.length - 1].toLowerCase()))
    ) {
      words.pop();
    }
    s = words.join(" ");
  }
  return trimSentence(s, maxChars).replace(/[,;:]+$/, "");
}

/**
 * Fill the first template × source combination the ledger accepts. The caller
 * supplies several candidates so a duplicate is simply skipped and the next
 * option is tried (this is what keeps every platform's copy non-repetitive).
 */
function deriveLine(
  ledger: DedupLedger,
  templates: string[],
  sources: string[],
  max: number,
): { line: string; source: string } | null {
  for (const template of templates) {
    for (const source of sources) {
      if (!source) continue;
      const line = ensureEnd(template.replace("{body}", capitalize(compressClause(source, max))));
      if (ledger.accept(line)) return { line, source };
    }
  }
  return null;
}

/** Pull the next unused source sentence, ranked by topical score. */
function makeSourcePicker(sentences: string[], used: Set<string>, freq: Map<string, number>) {
  const ranked = sentences
    .map((s, i) => ({ s, i, score: scoreSentence(s, freq) }))
    .filter((c) => !used.has(c.s))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  let cursor = 0;
  return () => (cursor < ranked.length ? ranked[cursor++].s : null);
}

// ---------------------------------------------------------------------------
// Keyword / key-phrase discovery (frequency based)
// ---------------------------------------------------------------------------

function discoverKeywords(text: string, topN = 6): string[] {
  const words = tokens(text);
  const freq = freqMap(text);

  // Weight bigram phrases that appear more than once (good topic signals).
  const bigrams = new Map<string, number>();
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i];
    const b = words[i + 1];
    if (STOPWORDS.has(a) || STOPWORDS.has(b)) continue;
    const phrase = `${a} ${b}`;
    bigrams.set(phrase, (bigrams.get(phrase) ?? 0) + 1);
  }

  // Merge: a strong bigram outranks its individual words.
  const merged = new Map<string, number>();
  for (const [phrase, count] of bigrams) {
    if (count >= 2) merged.set(phrase, count * 3);
  }
  for (const [word, count] of freq) {
    // Skip a word if it's already covered inside a chosen bigram later.
    merged.set(word, Math.max(merged.get(word) ?? 0, count));
  }

  const picked: string[] = [];
  const pickedWords = new Set<string>();
  const sorted = [...merged.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k, count] of sorted) {
    if (picked.length >= topN) break;
    const parts = k.split(" ");
    // Skip a part-word that is already fully represented by a picked phrase.
    const overlap = parts.some((p) => pickedWords.has(p));
    if (overlap && count < picked.length * 4) continue;
    picked.push(k);
    parts.forEach((p) => pickedWords.add(p));
  }
  if (picked.length < topN) {
    for (const [k] of sorted) {
      if (picked.length >= topN) break;
      if (!picked.includes(k)) picked.push(k);
    }
  }
  return picked.slice(0, topN);
}

function hashtagsFrom(keywords: string[], max = 5): string {
  return keywords
    .slice(0, max)
    .map((k) => "#" + k.replace(/\s+/g, ""))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Executive Summary + Key Takeaways
// ---------------------------------------------------------------------------

/** Shared state for the builders: one ledger, one record of consumed sources. */
interface BuildCtx {
  ledger: DedupLedger;
  /** Raw source sentences already consumed by the summary or the takeaways. */
  used: Set<string>;
  freq: Map<string, number>;
}

/**
 * Executive summary — 3 lines, ranked by topical score, in document order.
 * Every line goes through the ledger, so the summary itself can never contain
 * two identical (or near-identical) sentences.
 */
function buildSummary(sentences: string[], ctx: BuildCtx): string[] {
  const ledger = ctx.ledger;
  ledger.begin("summary");
  const ranked = sentences
    .map((s, i) => ({ s, i, score: scoreSentence(s, ctx.freq) }))
    .sort((a, b) => b.score - a.score || a.i - b.i);

  const chosen: { text: string; index: number }[] = [];
  for (const c of ranked) {
    if (chosen.length >= 3) break;
    const line = ensureEnd(capitalize(trimSentence(c.s)));
    if (!ledger.accept(line)) continue; // duplicate, or a concept already used
    ctx.used.add(c.s);
    chosen.push({ text: line, index: c.i });
  }
  // A package with no executive summary is broken (the translations are built
  // from it too), so a short or concept-dense document still gets the best line
  // it has — recorded through the ledger so the rest of the package sees it.
  if (chosen.length === 0 && sentences.length > 0) {
    const best = [...sentences].sort((a, b) => b.length - a.length)[0];
    const line = ledger.force(ensureEnd(capitalize(trimSentence(best))));
    ctx.used.add(best);
    return [line];
  }
  // Restore document order so the summary reads as a narrative.
  chosen.sort((a, b) => a.index - b.index);
  return chosen.map((c) => c.text);
}

/** Last-resort takeaway lines — generic, concept-free, all ledger-checked. */
const TAKEAWAY_FILLERS = [
  "The piece leans on concrete figures rather than general claims.",
  "Trade-offs get named openly instead of glossed over.",
  "The framing is practical: what changed, and what it cost.",
  "Readers come away with an actionable takeaway, not just theory.",
  "The strongest claims are the ones backed by specifics.",
  "The line from problem to outcome is easy to follow.",
  "The writing rewards a second read — the detail does the work.",
];

/**
 * Key takeaways — never returns a sentence the summary already used, never
 * repeats one of its own lines, never names a concept the summary claimed
 * (tech names, key-phrases, metrics), and never emits a bare keyword line.
 * Every candidate is filtered through the shared ledger; when the document has
 * no unique sentence left, the tail is filled with well-crafted generic lines
 * rather than repeating — or re-stacking — anything already in the package.
 */
function buildTakeaways(sentences: string[], ctx: BuildCtx): string[] {
  const ledger = ctx.ledger;
  ledger.begin("takeaways");
  const ranked = sentences
    .map((s, i) => ({ s, i, score: scoreSentence(s, ctx.freq) }))
    .sort((a, b) => b.score - a.score || a.i - b.i);

  const result: string[] = [];
  for (const c of ranked) {
    if (result.length >= 5) break;
    const line = trimSentence(ensureEnd(capitalize(c.s)));
    if (!ledger.accept(line)) continue; // duplicate, bare, or a claimed concept
    ctx.used.add(c.s);
    result.push(line);
  }

  // Top off with generic (but distinct and ledger-checked) filler lines.
  for (const f of TAKEAWAY_FILLERS) {
    if (result.length >= 5) break;
    if (ledger.accept(f)) result.push(f);
  }
  return result.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Social Media Kit
// ---------------------------------------------------------------------------
//
// Each platform gets its OWN angle, its own source sentences and its own
// keyword subset:
//
//   X          — sharp, short hook from the topic keywords + one compressed
//                point. No summary sentences, ever.
//   LinkedIn   — professional narrative: keyword-framed title, a business-voice
//                opening, one reworded body line and two bullets built from
//                different source sentences than X used.
//   Instagram  — visual-first: its own visual description plus a curious /
//                benefit-framed caption (never a recap of summary[0]).
//
// `buildSocial` deliberately does not receive the summary, so it is impossible
// for a platform post to paste a summary sentence verbatim.

function buildSocial(sentences: string[], ctx: BuildCtx): SocialKit {
  const ledger = ctx.ledger;
  const ht = hashtagsFrom(ledger.keywords);
  const nextSource = makeSourcePicker(sentences, ctx.used, ctx.freq);
  /**
   * Take up to `n` fresh candidates: source sentences neither the summary nor
   * the takeaways used. Takeaways are deliberately NOT a fallback pool — a
   * platform line must be first-hand material, never a re-write of a line that
   * already appeared above it in the package.
   */
  const candidates = (n: number, skip: Set<string>): string[] => {
    const out: string[] = [];
    let guard = 0;
    while (out.length < n && guard < 12) {
      guard++;
      const s = nextSource();
      if (!s) break;
      if (skip.has(s) || out.includes(s)) continue;
      out.push(s);
    }
    return out;
  };

  // Every source sentence may be paraphrased at most once in the social kit, so
  // the same example/metric can never be restated under a second platform or
  // bullet.
  const socialUsed = new Set<string>();
  const derive = (templates: string[], n: number, max: number): string | null => {
    const hit = deriveLine(ledger, templates, candidates(n, socialUsed), max);
    if (!hit) return null;
    socialUsed.add(hit.source);
    return hit.line;
  };

  // Claim one keyword for X, two for the LinkedIn framing, two for the visual
  // description and one for the caption, so no two platforms share a block.
  ledger.begin("x");
  const xKeyword = ledger.takeKeywords(1)[0] ?? null;

  // ---------------------------------------------------------------- X (short)
  const xHook =
    firstAccepted(ledger, [
      xKeyword
        ? `${keyphraseCase(xKeyword)} is the quiet through-line of this piece — and it changes how you read it.`
        : null,
      xKeyword ? `Most people skim straight past ${xKeyword}. Here's the bit worth keeping.` : null,
      xKeyword ? `${keyphraseCase(xKeyword)}, in one line: the detail everyone else buries.` : null,
      "One long piece, compressed into the part that actually matters.",
      "Short version of a long read — the insight, not the itinerary.",
    ]) ?? ledger.force("One long piece, compressed into the part that actually matters.");

  const xPoint =
    derive(rotate(FRAMES.x, 0), 3, 118) ??
    ledger.force("The practical detail is the part readers actually remember.");

  const xText = [xHook, "", xPoint, "Full breakdown ↓"].join("\n");

  // ------------------------------------------------------------- LinkedIn
  ledger.begin("linkedin");
  const linkedinKeywords = ledger.takeKeywords(2);
  const ctaKeyword = ledger.takeKeywords(1)[0] ?? null;
  const linkedinTitle =
    firstAccepted(ledger, [
      linkedinKeywords.length === 2
        ? `${keyphraseCase(linkedinKeywords.join(", "))} — what most write-ups skip.`
        : null,
      linkedinKeywords.length >= 1
        ? `${keyphraseCase(linkedinKeywords[0])} — what most write-ups skip.`
        : null,
      "What most write-ups skip — and how to actually use it.",
      "A practical note on the detail most teams walk straight past.",
    ]) ?? ledger.force("What most write-ups skip — and how to actually use it.");

  const linkedinOpening =
    derive(rotate(FRAMES.linkedin, 1), 3, 180) ??
    fallbackLine(ledger, [
      "The business case here is simpler than the jargon around it suggests.",
      "Most write-ups stop at the announcement; the harder part is what it takes to hold.",
    ]);

  const linkedinBody = derive(rotate(FRAMES.linkedin, 2), 3, 180);

  const bullets: string[] = [];
  for (let i = 0; i < 2; i++) {
    const bullet =
      derive(rotate(BULLET_TEMPLATES, i), 3, 130) ??
      firstAccepted(ledger, rotate(BULLET_FALLBACKS, i));
    if (bullet) bullets.push(bullet);
  }

  const linkedinCta =
    firstAccepted(ledger, [
      ctaKeyword
        ? `Curious where ${ctaKeyword} is heading next? Follow along for practical notes.`
        : null,
      "Curious how this plays out next? Follow along for practical notes.",
    ]) ?? ledger.force("Curious how this plays out next? Follow along for practical notes.");

  const linkedin = [
    linkedinTitle,
    "",
    linkedinOpening,
    ...(linkedinBody ? ["", linkedinBody] : []),
    "",
    "What stands out:",
    ...bullets.map((b) => `  • ${b}`),
    "",
    linkedinCta,
    "",
    ht,
  ].join("\n");

  // ------------------------------------------------------------ Instagram
  ledger.begin("instagram");
  const visualKeywords = ledger.takeKeywords(2);
  const captionKeyword = ledger.takeKeywords(1)[0] ?? null;
  const visualTopic = visualKeywords.length ? visualKeywords.join(" and ") : null;
  const visual =
    firstAccepted(ledger, [
      visualTopic
        ? `A clean modern flat-lay: an oversized headline card floating over a soft gradient, flanked by minimal icons for ${visualTopic}. Mobile-first 1080×1080 square, generous white space, one accent colour.`
        : null,
      visualTopic
        ? `Bold typographic carousel cover about ${visualTopic}: deep neutral background, single accent colour, a hand-drawn underline beneath the headline, plenty of breathing room.`
        : null,
      "A clean modern flat-lay: an oversized headline card floating over a soft gradient, flanked by two minimal props. Mobile-first 1080×1080 square, generous white space, one accent colour.",
      "Bold typographic carousel cover: deep neutral background, a single accent colour, a hand-drawn underline beneath the headline, and plenty of breathing room in a 1080×1080 square.",
      "Editorial photo-real shot, warm light and shallow depth of field, cropped square at 1080×1080 with space for a headline across the top third.",
    ]) ?? ledger.force("A bold typographic 1080×1080 square with one clear headline and a single accent colour.");

  const captionHook =
    firstAccepted(ledger, [
      captionKeyword
        ? `Ever wondered how ${captionKeyword} actually shows up in day-to-day work?`
        : null,
      captionKeyword ? `Three things most people get wrong about ${captionKeyword} ↓` : null,
      "Which part of this would you try first?",
      "Saving this one? Here's the part that pays off fastest.",
    ]) ?? ledger.force("Which part of this would you try first?");

  const captionBody =
    derive(rotate(FRAMES.instagram, 2), 3, 150) ??
    ledger.force("The fastest win is applying one idea properly instead of all of them badly.");

  const caption = [
    captionHook,
    "",
    captionBody,
    "",
    "Save this for the next time you need it 👇",
  ].join("\n");

  return {
    x: { text: xText, hashtags: "\n\n" + ht },
    linkedin,
    instagram: { visual, caption, hashtags: "\n\n" + ht },
  };
}

// ---------------------------------------------------------------------------
// Multilingual translation (lightweight dictionary-based heuristic)
// ---------------------------------------------------------------------------
//
// A real LLM would translate fluently; since we must run fully offline with no
// credentials, this uses a hand-curated common-word dictionary (es/fr/hi) with
// word-order-preserving replacement. Unknown words pass through untouched, so
// proper nouns, numbers and technical terms survive. Swap this function for a
// real translation API/LLM later without changing the UI.

interface LangDict {
  es: string;
  fr: string;
  hi: string;
}

const DICT: Record<string, LangDict> = {
  a: { es: "un", fr: "un", hi: "एक" },
  an: { es: "un", fr: "un", hi: "एक" },
  the: { es: "el", fr: "le", hi: "यह" },
  and: { es: "y", fr: "et", hi: "और" },
  of: { es: "de", fr: "de", hi: "का" },
  to: { es: "a", fr: "à", hi: "को" },
  in: { es: "en", fr: "dans", hi: "में" },
  for: { es: "para", fr: "pour", hi: "के लिए" },
  on: { es: "sobre", fr: "sur", hi: "पर" },
  with: { es: "con", fr: "avec", hi: "के साथ" },
  is: { es: "es", fr: "est", hi: "है" },
  are: { es: "son", fr: "sont", hi: "हैं" },
  was: { es: "era", fr: "était", hi: "था" },
  were: { es: "eran", fr: "étaient", hi: "थे" },
  be: { es: "ser", fr: "être", hi: "होना" },
  been: { es: "sido", fr: "été", hi: "रहा" },
  being: { es: "siendo", fr: "étant", hi: "होने" },
  have: { es: "tener", fr: "avoir", hi: "है" },
  has: { es: "tiene", fr: "a", hi: "है" },
  had: { es: "tenía", fr: "avait", hi: "था" },
  not: { es: "no", fr: "pas", hi: "नहीं" },
  this: { es: "esto", fr: "ceci", hi: "यह" },
  that: { es: "eso", fr: "cela", hi: "वह" },
  these: { es: "estos", fr: "ces", hi: "ये" },
  those: { es: "esos", fr: "ces", hi: "वे" },
  it: { es: "lo", fr: "il", hi: "यह" },
  its: { es: "su", fr: "son", hi: "इसका" },
  they: { es: "ellos", fr: "ils", hi: "वे" },
  them: { es: "les", fr: "les", hi: "उन्हें" },
  we: { es: "nosotros", fr: "nous", hi: "हम" },
  us: { es: "nosotros", fr: "nous", hi: "हमें" },
  our: { es: "nuestro", fr: "notre", hi: "हमारा" },
  your: { es: "tu", fr: "votre", hi: "आपका" },
  you: { es: "tú", fr: "vous", hi: "आप" },
  he: { es: "él", fr: "il", hi: "वह" },
  she: { es: "ella", fr: "elle", hi: "वह" },
  his: { es: "su", fr: "son", hi: "उसका" },
  her: { es: "su", fr: "son", hi: "उसका" },
  their: { es: "su", fr: "leur", hi: "उनका" },
  from: { es: "de", fr: "de", hi: "से" },
  by: { es: "por", fr: "par", hi: "द्वारा" },
  at: { es: "en", fr: "à", hi: "पर" },
  as: { es: "como", fr: "comme", hi: "के रूप में" },
  into: { es: "en", fr: "dans", hi: "में" },
  "about": { es: "sobre", fr: "à propos de", hi: "के बारे में" },
  can: { es: "puede", fr: "peut", hi: "सकता है" },
  could: { es: "podría", fr: "pourrait", hi: "सकता है" },
  will: { es: "será", fr: "sera", hi: "होगा" },
  would: { es: "haría", fr: "ferait", hi: "होगा" },
  should: { es: "debería", fr: "devrait", hi: "चाहिए" },
  may: { es: "puede", fr: "peut", hi: "हो सकता है" },
  might: { es: "podría", fr: "pourrait", hi: "हो सकता है" },
  more: { es: "más", fr: "plus", hi: "अधिक" },
  most: { es: "la mayoría", fr: "la plupart", hi: "अधिकांश" },
  much: { es: "mucho", fr: "beaucoup", hi: "बहुत" },
  many: { es: "muchos", fr: "beaucoup", hi: "कई" },
  some: { es: "algunos", fr: "certains", hi: "कुछ" },
  any: { es: "cualquier", fr: "tout", hi: "कोई" },
  all: { es: "todos", fr: "tous", hi: "सभी" },
  every: { es: "cada", fr: "chaque", hi: "हर" },
  each: { es: "cada", fr: "chaque", hi: "प्रत्येक" },
  only: { es: "solo", fr: "seulement", hi: "केवल" },
  just: { es: "solo", fr: "juste", hi: "बस" },
  often: { es: "a menudo", fr: "souvent", hi: "अक्सर" },
  always: { es: "siempre", fr: "toujours", hi: "हमेशा" },
  never: { es: "nunca", fr: "jamais", hi: "कभी नहीं" },
  very: { es: "muy", fr: "très", hi: "बहुत" },
  really: { es: "realmente", fr: "vraiment", hi: "वास्तव में" },
  important: { es: "importante", fr: "important", hi: "महत्वपूर्ण" },
  first: { es: "primero", fr: "premier", hi: "पहला" },
  last: { es: "último", fr: "dernier", hi: "अंतिम" },
  new: { es: "nuevo", fr: "nouveau", hi: "नया" },
  old: { es: "viejo", fr: "vieux", hi: "पुराना" },
  good: { es: "bueno", fr: "bon", hi: "अच्छा" },
  great: { es: "genial", fr: "excellent", hi: "महान" },
  better: { es: "mejor", fr: "meilleur", hi: "बेहतर" },
  best: { es: "mejor", fr: "meilleur", hi: "सर्वश्रेष्ठ" },
  big: { es: "grande", fr: "grand", hi: "बड़ा" },
  small: { es: "pequeño", fr: "petit", hi: "छोटा" },
  high: { es: "alto", fr: "élevé", hi: "उच्च" },
  low: { es: "bajo", fr: "faible", hi: "कम" },
  also: { es: "también", fr: "aussi", hi: "भी" },
  even: { es: "incluso", fr: "même", hi: "यहाँ तक कि" },
  well: { es: "bien", fr: "bien", hi: "अच्छी तरह" },
  now: { es: "ahora", fr: "maintenant", hi: "अभी" },
  when: { es: "cuando", fr: "quand", hi: "जब" },
  where: { es: "donde", fr: "où", hi: "जहाँ" },
  why: { es: "por qué", fr: "pourquoi", hi: "क्यों" },
  what: { es: "qué", fr: "quoi", hi: "क्या" },
  which: { es: "cuál", fr: "quel", hi: "जो" },
  how: { es: "cómo", fr: "comment", hi: "कैसे" },
  because: { es: "porque", fr: "parce que", hi: "क्योंकि" },
  but: { es: "pero", fr: "mais", hi: "लेकिन" },
  or: { es: "o", fr: "ou", hi: "या" },
  so: { es: "así que", fr: "donc", hi: "इसलिए" },
  if: { es: "si", fr: "si", hi: "अगर" },
  than: { es: "que", fr: "que", hi: "से" },
  do: { es: "hacer", fr: "faire", hi: "करना" },
  does: { es: "hace", fr: "fait", hi: "करता है" },
  did: { es: "hizo", fr: "a fait", hi: "किया" },
  made: { es: "hecho", fr: "fait", hi: "बनाया" },
  make: { es: "hacer", fr: "faire", hi: "बनाना" },
  go: { es: "ir", fr: "aller", hi: "जाना" },
  get: { es: "obtener", fr: "obtenir", hi: "पाना" },
  know: { es: "saber", fr: "savoir", hi: "जानना" },
  think: { es: "pensar", fr: "penser", hi: "सोचना" },
  see: { es: "ver", fr: "voir", hi: "देखना" },
  find: { es: "encontrar", fr: "trouver", hi: "ढूंढना" },
  use: { es: "usar", fr: "utiliser", hi: "उपयोग करना" },
  help: { es: "ayudar", fr: "aider", hi: "मदद करना" },
  want: { es: "querer", fr: "vouloir", hi: "चाहना" },
  need: { es: "necesitar", fr: "avoir besoin", hi: "ज़रूरत" },
  way: { es: "manera", fr: "manière", hi: "तरीका" },
  thing: { es: "cosa", fr: "chose", hi: "चीज़" },
  things: { es: "cosas", fr: "choses", hi: "चीजें" },
  people: { es: "personas", fr: "personnes", hi: "लोग" },
  person: { es: "persona", fr: "personne", hi: "व्यक्ति" },
  time: { es: "tiempo", fr: "temps", hi: "समय" },
  year: { es: "año", fr: "an", hi: "साल" },
  years: { es: "años", fr: "ans", hi: "साल" },
  day: { es: "día", fr: "jour", hi: "दिन" },
  days: { es: "días", fr: "jours", hi: "दिन" },
  life: { es: "vida", fr: "vie", hi: "जीवन" },
  work: { es: "trabajo", fr: "travail", hi: "काम" },
  world: { es: "mundo", fr: "monde", hi: "दुनिया" },
  business: { es: "negocio", fr: "entreprise", hi: "व्यवसाय" },
  company: { es: "empresa", fr: "entreprise", hi: "कंपनी" },
  companies: { es: "empresas", fr: "entreprises", hi: "कंपनियों" },
  market: { es: "mercado", fr: "marché", hi: "बाजार" },
  product: { es: "producto", fr: "produit", hi: "उत्पाद" },
  products: { es: "productos", fr: "produits", hi: "उत्पादों" },
  service: { es: "servicio", fr: "service", hi: "सेवा" },
  services: { es: "servicios", fr: "services", hi: "सेवाएं" },
  customer: { es: "cliente", fr: "client", hi: "ग्राहक" },
  customers: { es: "clientes", fr: "clients", hi: "ग्राहकों" },
  data: { es: "datos", fr: "données", hi: "डेटा" },
  results: { es: "resultados", fr: "résultats", hi: "परिणाम" },
  result: { es: "resultado", fr: "résultat", hi: "परिणाम" },
  research: { es: "investigación", fr: "recherche", hi: "शोध" },
  study: { es: "estudio", fr: "étude", hi: "अध्ययन" },
  report: { es: "informe", fr: "rapport", hi: "रिपोर्ट" },
  example: { es: "ejemplo", fr: "exemple", hi: "उदाहरण" },
  examples: { es: "ejemplos", fr: "exemples", hi: "उदाहरण" },
  fact: { es: "hecho", fr: "fait", hi: "तथ्य" },
  facts: { es: "hechos", fr: "faits", hi: "तथ्यों" },
  idea: { es: "idea", fr: "idée", hi: "विचार" },
  ideas: { es: "ideas", fr: "idées", hi: "विचारों" },
  point: { es: "punto", fr: "point", hi: "बिंदु" },
  points: { es: "puntos", fr: "points", hi: "बिंदु" },
  part: { es: "parte", fr: "partie", hi: "हिस्सा" },
  number: { es: "número", fr: "nombre", hi: "संख्या" },
  percent: { es: "por ciento", fr: "pour cent", hi: "प्रतिशत" },
  increase: { es: "aumento", fr: "augmentation", hi: "वृद्धि" },
  growth: { es: "crecimiento", fr: "croissance", hi: "वृद्धि" },
  change: { es: "cambio", fr: "changement", hi: "परिवर्तन" },
  changes: { es: "cambios", fr: "changements", hi: "परिवर्तन" },
  future: { es: "futuro", fr: "avenir", hi: "भविष्य" },
  technology: { es: "tecnología", fr: "technologie", hi: "प्रौद्योगिकी" },
  digital: { es: "digital", fr: "numérique", hi: "डिजिटल" },
  online: { es: "en línea", fr: "en ligne", hi: "ऑनलाइन" },
  social: { es: "social", fr: "social", hi: "सामाजिक" },
  media: { es: "medios", fr: "médias", hi: "मीडिया" },
  content: { es: "contenido", fr: "contenu", hi: "सामग्री" },
  marketing: { es: "marketing", fr: "marketing", hi: "मार्केटिंग" },
  brand: { es: "marca", fr: "marque", hi: "ब्रांड" },
  strategy: { es: "estrategia", fr: "stratégie", hi: "रणनीति" },
  value: { es: "valor", fr: "valeur", hi: "मूल्य" },
  benefits: { es: "beneficios", fr: "avantages", hi: "लाभ" },
  benefit: { es: "beneficio", fr: "avantage", hi: "लाभ" },
  cost: { es: "costo", fr: "coût", hi: "लागत" },
  money: { es: "dinero", fr: "argent", hi: "पैसा" },
  health: { es: "salud", fr: "santé", hi: "स्वास्थ्य" },
  energy: { es: "energía", fr: "énergie", hi: "ऊर्जा" },
  environment: { es: "medio ambiente", fr: "environnement", hi: "पर्यावरण" },
};

function translateSentence(sentence: string, lang: "es" | "fr" | "hi"): string {
  const words = sentence.match(/[A-Za-z0-9’'-]+|\s+|[.,!?;:…]/g) ?? [];
  const out: string[] = [];
  for (const w of words) {
    if (/^\s+$/.test(w) || /^[.,!?;:…]$/.test(w)) {
      out.push(w);
      continue;
    }
    const lower = w.toLowerCase();
    const entry = DICT[lower];
    if (entry) {
      // Preserve leading capital for sentence-starting tokens.
      const isCap = /^[A-Z]/.test(w);
      const translated = entry[lang];
      out.push(isCap ? translated.charAt(0).toUpperCase() + translated.slice(1) : translated);
    } else {
      out.push(w);
    }
  }
  return out.join("").replace(/\s+([.,!?;:…])/g, "$1");
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function generateMarketingPackage(text: string): MarketingResult {
  const sentences = splitSentences(text);
  const freq = freqMap(text);
  const keywords = discoverKeywords(text);

  // One ledger for the whole package: summary, takeaways and every platform
  // share it, so nothing can be emitted twice. The document's own lowercase
  // spellings tell the ledger which capitals are names and which are prose.
  const ctx: BuildCtx = {
    ledger: new DedupLedger(keywords, lowercaseWordSet(text)),
    used: new Set<string>(),
    freq,
  };

  const summary = buildSummary(sentences, ctx);
  const takeaways = buildTakeaways(sentences, ctx);
  const social = buildSocial(sentences, ctx);

  const summaryText = summary.join(" ");
  return {
    summary,
    takeaways,
    social,
    translations: {
      spanish: translateSentence(summaryText, "es"),
      french: translateSentence(summaryText, "fr"),
      hindi: translateSentence(summaryText, "hi"),
    },
    keywords,
  };
}

// ---------------------------------------------------------------------------
// Independent audit of a finished package
// ---------------------------------------------------------------------------
//
// verifyMarketingPackage() re-checks the three invariants from the outside,
// using the same normalisation as the ledger but with no knowledge of how the
// package was built. It is used by the team's dedup script to prove the output
// is repeat-free; the app does not need it at runtime.

export interface DedupViolation {
  rule: string;
  detail: string;
}

function proseUnits(pkg: MarketingResult): { where: Section; text: string }[] {
  const blocks: [Section, string][] = [
    ...pkg.summary.map((s) => ["summary", s] as [Section, string]),
    ...pkg.takeaways.map((s) => ["takeaways", s] as [Section, string]),
    ["x", pkg.social.x.text],
    ["linkedin", pkg.social.linkedin],
    ["instagram", pkg.social.instagram.visual],
    ["instagram", pkg.social.instagram.caption],
  ];
  const units: { where: Section; text: string }[] = [];
  for (const [where, block] of blocks) {
    for (const rawLine of block.split(/\n+/)) {
      const line = rawLine.replace(/^[\s•\-–]+/, "").trim();
      if (!line) continue;
      // Hashtag-only lines are labels, not prose → exempt from the prose rules.
      if (/^(#\S+\s*)+$/.test(line)) continue;
      for (const sentence of splitSentences(line)) units.push({ where, text: sentence });
    }
  }
  return units;
}

/** Returns every repetition that survived generation (always empty). */
export function verifyMarketingPackage(pkg: MarketingResult): DedupViolation[] {
  const violations: DedupViolation[] = [];
  const units = proseUnits(pkg);

  // Rule 1 — no sentence/paragraph twice, anywhere.
  const seen = new Map<string, Section>();
  for (const u of units) {
    const key = dedupKey(u.text);
    if (!key) continue;
    const prev = seen.get(key);
    if (prev !== undefined) {
      violations.push({
        rule: "duplicate-sentence",
        detail: `"${u.text}" (${u.where}) repeats a line already in ${prev}`,
      });
    } else {
      seen.set(key, u.where);
    }
  }

  // Rule 3 — a multi-term block ("Java, Spring Boot, Kafka") is emitted once.
  const blockOwner = new Map<string, string>();
  for (const u of units) {
    for (const list of termLists(u.text)) {
      const words = [...list].sort();
      for (let i = 0; i < words.length; i++) {
        for (let j = i + 1; j < words.length; j++) {
          const pair = `${words[i]}|${words[j]}`;
          const owner = blockOwner.get(pair);
          if (owner) {
            violations.push({
              rule: "repeated-concept-block",
              detail: `"${words[i]}, ${words[j]}" appears in both ${owner} and ${u.where}`,
            });
          } else {
            blockOwner.set(pair, u.where);
          }
        }
      }
    }
  }

  // Rule 3 — a keyword is referenced by builder prose in at most one platform.
  for (const kw of pkg.keywords) {
    const platforms = new Set<Section>();
    for (const u of units) {
      if (PLATFORM_SECTIONS.has(u.where) && mentionsKeyword(kw, u.text)) platforms.add(u.where);
    }
    if (platforms.size > 1) {
      violations.push({
        rule: "keyword-reused-across-platforms",
        detail: `"${kw}" appears in ${[...platforms].join(" and ")}`,
      });
    }
  }

  // Rule 3 — one distinct mention per concept across the WHOLE package
  // (summary + takeaways + every platform). Concepts are collected from the
  // finished package and then matched back against every section, so a
  // re-worded or re-cased repeat (a lone "Java" after "Java and Spring Boot")
  // is still caught.
  const matchers: ConceptMatcher[] = [];
  const seenConcepts = new Set<string>();
  const packageLowercase = lowercaseWordSet(units.map((u) => u.text).join(" "));
  for (const u of units) {
    for (const m of conceptMatchers(u.text, pkg.keywords, packageLowercase)) {
      if (seenConcepts.has(m.key)) continue;
      seenConcepts.add(m.key);
      matchers.push(m);
    }
  }
  for (const m of matchers) {
    const hitUnits = units.filter((u) => m.test(u.text));
    if (hitUnits.length < 2) continue;
    violations.push({
      rule: "concept-reused",
      detail: `${m.key} is mentioned in ${hitUnits.map((u) => u.where).join(" + ")}`,
    });
  }

  return violations;
}
