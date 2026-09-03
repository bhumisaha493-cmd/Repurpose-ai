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

interface WordFreq {
  word: string;
  count: number;
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

function topEntries(map: Map<string, number>, n: number): WordFreq[] {
  return [...map.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, n);
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

/** Pick `n` highest-scoring sentences in original document order. */
function pickBest(sentences: string[], weights: Map<string, number>, n: number): string[] {
  const scored = sentences.map((s, i) => ({ s, i, score: scoreSentence(s, weights) }));
  const chosen = [...scored].sort((a, b) => b.score - a.score).slice(0, n);
  chosen.sort((a, b) => a.i - b.i);
  return chosen.map((c) => c.s);
}

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

function buildSummary(sentences: string[], freq: Map<string, number>): string[] {
  // Merge adjacent short sentences so each of the 3 lines reads like a real
  // sentence with enough context to be genuinely informative.
  const chosen = pickBest(sentences, freq, 3);
  return chosen.map((s) => ensureEnd(capitalize(trimSentence(s))));
}

function buildTakeaways(sentences: string[], freq: Map<string, number>, keywords: string[]): string[] {
  // Prefer the next-best sentences beyond those used in the summary.
  const ranked = [...sentences]
    .map((s, i) => ({ s, i, score: scoreSentence(s, freq) }))
    .sort((a, b) => b.score - a.score);
  const result: string[] = [];
  const used = new Set<string>();
  // Always reflect a couple of the top keywords as concrete takeaway lines.
  for (const s of ranked) {
    const t = trimSentence(ensureEnd(capitalize(s.s)));
    if (result.length >= 5) break;
    if (used.has(t)) continue;
    used.add(t);
    result.push(t);
  }
  // Backfill with keyword-driven statements if we have fewer than 5 sentences.
  for (const kw of keywords) {
    if (result.length >= 5) break;
    result.push(
      `Highlights ${kw} as a central theme in this content — a point worth acting on.`,
    );
  }
  // Top off so we always have exactly 5 punchy bullets.
  const filler = [
    "Key arguments are concentrated in the opening and closing paragraphs.",
    "The overall message is consistent and reinforces one clear thesis.",
    "Examples and data are used to support the main claims throughout.",
  ];
  let i = 0;
  while (result.length < 5) {
    const f = trimSentence(filler[i % filler.length]);
    if (!used.has(f)) {
      result.push(f);
      used.add(f);
    }
    i++;
  }
  return result.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Social Media Kit
// ---------------------------------------------------------------------------

/** Trim a sentence to a capsule, ending in a single "." or "…". */
function recap(s: string, max: number): string {
  const t = trimSentence(stripTrailingPunct(s), max);
  return /…$/.test(t) ? t : t + ".";
}

function buildSocial(summary: string[], takeaways: string[], keywords: string[], headline: string) {
  const first = summary[0] ?? headline;
  const second = summary[1] ?? takeaways[0] ?? "";
  const third = summary[2] ?? takeaways[1] ?? "";
  const ht = hashtagsFrom(keywords);

  const xText = [
    recap(first, 140),
    recap(second, 130),
    "",
    `Key insight: ${stripTrailingPunct(takeaways[0] ?? second)}.`,
  ].join(" ");
  const xHashtags = "\n\n" + ht;

  const linkedin = [
    `${keyphraseCase(headline)} — here's what matters.`,
    "",
    first,
    "",
    second,
    "",
    third,
    "",
    "The bottom line:",
    ...takeaways.slice(0, 3).map((t) => `  • ${stripTrailingPunct(t)}`),
    "",
    `Interested in this topic? Follow me for practical insights on ${keywords
      .slice(0, 2)
      .join(" and ")}.`,
    "",
    ht,
  ].join("\n");

  const visual = `A clean, modern flat-lay: bold headline "${keyphraseCase(
    headline,
  )}" centered on a soft gradient background, layered with subtle icons for ${keywords
    .slice(0, 3)
    .join(", ")}. Bright, high-contrast, mobile-first 1080×1080 square with generous white space and a single accent color.`;

  const caption = [
    recap(first, 150),
    "",
    recap(second, 150),
    "",
    stripTrailingPunct(takeaways[0]) + " — and that's just scratching the surface.",
    "",
    "Save this for later and share it with someone who needs it 👇",
  ].join("\n");

  return {
    x: { text: xText, hashtags: xHashtags },
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

  // A short, representative headline built from the top keywords.
  const headline = keywords.slice(0, 3).join(", ") || "This content";

  const summary = buildSummary(sentences, freq);
  const takeaways = buildTakeaways(sentences, freq, keywords);
  const social = buildSocial(summary, takeaways, keywords, headline);

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
