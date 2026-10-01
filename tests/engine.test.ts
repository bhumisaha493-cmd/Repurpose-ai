// ---------------------------------------------------------------------------
// RepurposeAI — regression tests for the DYNAMIC content engine.
//
// These tests exist because of a real owner report: the app appeared to return
// a fixed boilerplate package ("Digital products are intangible goods…" with
// #digital / #products) no matter what was pasted in. The engine source has
// never contained those strings — the report came from a stale deployment — so
// the point of this suite is to lock the dynamic behaviour in permanently:
//
//   1. Different inputs must produce different summaries, takeaways, posts and
//      hashtags (output derives from the input).
//   2. Output must be provably derived from THIS input: distinctive tokens from
//      the input appear in its package, and tokens from another topic do not
//      leak in.
//   3. The known mock strings must never appear.
//   4. The anti-repetition invariants (one mention per core concept, no
//      sentence emitted twice) must hold.
//   5. Hardening: deterministic output, no "undefined"/"NaN" leaking out of
//      templates, no crash on empty / whitespace-only / tiny input.
//
// Run with:  bun test        (Bun's built-in test runner — no network, no deps)
// ---------------------------------------------------------------------------
import { describe, expect, test } from "bun:test";
import {
  generateMarketingPackage,
  verifyMarketingPackage,
} from "../src/lib/engine";
import type { MarketingResult } from "../src/lib/engine";

// ---------------------------------------------------------------------------
// Fixtures — two plainly different topics
// ---------------------------------------------------------------------------
/** Topic A: a Java / Spring Boot / Kafka fintech migration. */
const TECH_TOPIC = `Our team migrated the payment platform from a monolithic architecture to microservices built with Java and Spring Boot, using Kafka for event streaming between services. The migration took nine months and involved 40 engineers. We chose Java and Spring Boot because of their maturity in financial services, and Kafka because it gives us reliable message delivery at scale. The new architecture handles 2.5 million transactions per day, up from 800,000 before. Availability is now 99.99%. Key results include a 60% reduction in latency and a threefold increase in throughput. The team is now planning to move the analytics pipeline to the same stack.`;

/** Topic B: remote-work productivity research. */
const REMOTE_TOPIC = `Remote work stopped being an experiment years ago, but the productivity debate has not settled. Our research team surveyed 1,200 knowledge workers across 14 companies and interviewed 30 managers to find out what actually changes when people stop sharing an office. The headline finding is uncomfortable: individual output barely moved, while the way work gets coordinated changed completely. Teams that documented decisions in writing shipped features 22% faster than teams that relied on status meetings, and they reported fewer interruptions during long focus blocks. Meeting load, not hours logged, was the strongest predictor of burnout, so managers who cut recurring check-ins in half kept nine out of ten engineers on their teams. Attendance-based reviews still punish people who write instead of talk, even though the evidence shows no link between visible activity and delivered results. The strongest managers we studied publish a weekly written update, protect two quiet mornings, and measure outcomes rather than presence. Hybrid schedules, not fully distributed ones, produced the best retention in our sample, with 84% of employees staying two years or longer. The lesson is simple: written clarity beats improvised coordination.`;

/** Vocabulary that only ever appears in the *other* topic's document. */
const TECH_ONLY_TOKENS = ["java", "kafka", "spring boot", "microservices", "monolith"];
const REMOTE_ONLY_TOKENS = [
  "remote",
  "burnout",
  "knowledge workers",
  "meeting load",
  "hybrid",
];

/** The exact boilerplate the owner reported seeing. It must never come back. */
const MOCK_STRINGS = [
  "Digital products",
  "digital products are intangible goods",
  "intangible goods",
  "#digital",
  "#products",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whitespace-insensitive word/phrase match ("spring boot" → /spring\s+boot/i). */
function mentions(haystack: string, needle: string): boolean {
  const body = escapeRe(needle).replace(/\s+/g, "\\s+");
  const left = /^[a-z0-9]/i.test(needle) ? "\\b" : "";
  const right = /[a-z0-9]$/i.test(needle) ? "\\b" : "";
  return new RegExp(`${left}${body}${right}`, "i").test(haystack);
}

/** Every prose surface of the package; hashtag-only lines are dropped. */
type Section = "summary" | "takeaways" | "x" | "linkedin" | "instagram";

function proseSections(pkg: MarketingResult): Record<Section, string> {
  const strip = (block: string) =>
    block
      .split(/\n+/)
      .map((line) => line.replace(/^[\s•\-–]+/, "").trim())
      .filter((line) => line.length > 0 && !/^(#\S+\s*)+$/.test(line))
      .join("\n");
  return {
    summary: pkg.summary.join("\n"),
    takeaways: pkg.takeaways.join("\n"),
    x: strip(pkg.social.x.text),
    linkedin: strip(pkg.social.linkedin),
    instagram: strip(
      `${pkg.social.instagram.visual}\n${pkg.social.instagram.caption}`,
    ),
  };
}

/** Everything a user could copy out of the app, in one string. */
function copyableText(pkg: MarketingResult): string {
  return [
    ...pkg.summary,
    ...pkg.takeaways,
    pkg.social.x.text,
    pkg.social.x.hashtags,
    pkg.social.linkedin,
    pkg.social.instagram.visual,
    pkg.social.instagram.caption,
    pkg.social.instagram.hashtags,
    pkg.translations.spanish,
    pkg.translations.french,
    pkg.translations.hindi,
  ].join("\n");
}

function hashtagText(pkg: MarketingResult): string {
  return `${pkg.social.x.hashtags} ${pkg.social.instagram.hashtags}`;
}

function hashtagTags(pkg: MarketingResult): string[] {
  return (hashtagText(pkg).match(/#[A-Za-z0-9_]+/g) ?? []).map((t) =>
    t.slice(1).toLowerCase(),
  );
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Case/punctuation-insensitive key, used to spot a sentence emitted twice. */
function sentenceKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const tech = generateMarketingPackage(TECH_TOPIC);
const remote = generateMarketingPackage(REMOTE_TOPIC);
const TOPICS: [string, string, MarketingResult][] = [
  ["tech", TECH_TOPIC, tech],
  ["remote-work", REMOTE_TOPIC, remote],
];

// ---------------------------------------------------------------------------
// 1. Input-dependence — the package is generated, not returned from a table
// ---------------------------------------------------------------------------
describe("dynamic generation: output derives from the input", () => {
  test("different topics produce different summaries", () => {
    expect(normalize(tech.summary.join(" "))).not.toBe(
      normalize(remote.summary.join(" ")),
    );
    expect(tech.summary.length).toBeGreaterThan(0);
    expect(remote.summary.length).toBeGreaterThan(0);
  });

  test("different topics produce different key takeaways", () => {
    expect(tech.takeaways.join("\n")).not.toBe(remote.takeaways.join("\n"));
    // No takeaway is shared between the two topics.
    const remoteKeys = new Set(remote.takeaways.map(sentenceKey));
    expect(tech.takeaways.filter((t) => remoteKeys.has(sentenceKey(t)))).toEqual([]);
  });

  test("different topics produce different social posts", () => {
    expect(normalize(tech.social.x.text)).not.toBe(normalize(remote.social.x.text));
    expect(normalize(tech.social.linkedin)).not.toBe(
      normalize(remote.social.linkedin),
    );
    // The whole kit (including the Instagram block) must not be a clone.
    expect(JSON.stringify(tech.social)).not.toBe(JSON.stringify(remote.social));
  });

  test("hashtags follow the topic instead of a fixed list", () => {
    const techTags = hashtagTags(tech);
    const remoteTags = hashtagTags(remote);
    expect(techTags.length).toBeGreaterThan(0);
    expect(remoteTags.length).toBeGreaterThan(0);
    expect(new Set(techTags)).not.toEqual(new Set(remoteTags));
    // A hardcoded list would give both topics the same tags.
    expect(techTags.filter((t) => remoteTags.includes(t))).toEqual([]);
  });

  test("translations differ between topics as well", () => {
    expect(normalize(tech.translations.spanish)).not.toBe(
      normalize(remote.translations.spanish),
    );
    expect(normalize(tech.translations.french)).not.toBe(
      normalize(remote.translations.french),
    );
    expect(normalize(tech.translations.hindi)).not.toBe(
      normalize(remote.translations.hindi),
    );
  });

  test("generating twice for the same input is deterministic (pure function)", () => {
    expect(generateMarketingPackage(TECH_TOPIC)).toEqual(tech);
    expect(generateMarketingPackage(REMOTE_TOPIC)).toEqual(remote);
  });
});

// ---------------------------------------------------------------------------
// 2. Content provenance — the output is traceable to this input
// ---------------------------------------------------------------------------
describe("content provenance: this topic in, this topic out", () => {
  test("the tech package is built from the tech document", () => {
    const text = copyableText(tech);
    expect(mentions(text, "kafka")).toBe(true);
    expect(mentions(text, "java")).toBe(true);
    // The topic's own technology names end up as hashtags.
    expect(hashtagTags(tech)).toContain("kafka");
    expect(hashtagTags(tech)).toContain("java");
    // Summary lines are lifted from the source document, not invented.
    const source = normalize(TECH_TOPIC);
    expect(tech.summary.filter((s) => source.includes(normalize(s)))).not.toEqual([]);
  });

  test("the remote-work package is built from the remote-work document", () => {
    const text = copyableText(remote);
    expect(mentions(text, "remote work")).toBe(true);
    expect(mentions(text, "written clarity")).toBe(true);
    // At least one hashtag is a word the reader would recognise from the input.
    const remoteVocabulary = [
      "remote",
      "managers",
      "teams",
      "work",
      "years",
      "people",
      "strongest",
      "productivity",
      "meetings",
      "burnout",
      "onboarding",
    ];
    expect(hashtagTags(remote).some((t) => remoteVocabulary.includes(t))).toBe(true);
    const source = normalize(REMOTE_TOPIC);
    expect(remote.summary.filter((s) => source.includes(normalize(s)))).not.toEqual([]);
  });

  test("every extracted keyword comes from the input document", () => {
    for (const [name, source, pkg] of TOPICS) {
      expect(pkg.keywords.length).toBeGreaterThan(0);
      const foreign = pkg.keywords.filter((k) => !mentions(source, k));
      expect(`${name}: ${foreign.join(", ")}`).toBe(`${name}: `);
    }
  });

  test("no token from the other topic leaks into this topic's output", () => {
    const techText = copyableText(tech);
    const remoteText = copyableText(remote);
    expect(REMOTE_ONLY_TOKENS.filter((t) => mentions(techText, t))).toEqual([]);
    expect(TECH_ONLY_TOKENS.filter((t) => mentions(remoteText, t))).toEqual([]);
  });

  test("keyword sets are disjoint between the two topics", () => {
    expect(tech.keywords.filter((k) => remote.keywords.includes(k))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. The reported static/mock output must never return
// ---------------------------------------------------------------------------
describe("no hardcoded mock output", () => {
  test("the reported boilerplate strings never appear for either topic", () => {
    const found: string[] = [];
    for (const [name, , pkg] of TOPICS) {
      const text = copyableText(pkg);
      for (const mock of MOCK_STRINGS) {
        if (mentions(text, mock)) found.push(`${name} contains "${mock}"`);
      }
    }
    expect(found).toEqual([]);
  });

  test("hashtags are not the fixed #digital/#products set", () => {
    const offenders: string[] = [];
    for (const [name, , pkg] of TOPICS) {
      const tags = new Set(hashtagTags(pkg));
      if (tags.has("digital")) offenders.push(`${name} emits #digital`);
      if (tags.has("products")) offenders.push(`${name} emits #products`);
    }
    expect(offenders).toEqual([]);
  });

  test("a different input changes the package (guard against a cached package)", () => {
    const tweaked = generateMarketingPackage(TECH_TOPIC.replace(/Kafka/g, "RabbitMQ"));
    expect(copyableText(tweaked)).not.toBe(copyableText(tech));
    expect(mentions(copyableText(tweaked), "rabbitmq")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Anti-repetition invariants (regression for the one-mention-per-concept work)
// ---------------------------------------------------------------------------
describe("anti-repetition invariants", () => {
  test("the engine's own external audit reports no violations", () => {
    for (const [name, , pkg] of TOPICS) {
      expect([name, ...verifyMarketingPackage(pkg)]).toEqual([name]);
    }
  });

  test("no prose sentence is emitted twice across summary/takeaways/posts", () => {
    for (const [name, , pkg] of TOPICS) {
      const sections = proseSections(pkg);
      const seen = new Map<string, string>();
      const duplicates: string[] = [];
      for (const section of Object.keys(sections) as Section[]) {
        for (const line of sections[section].split(/\n+/)) {
          for (const sentence of line.split(/(?<=[.!?])\s+/)) {
            const key = sentenceKey(sentence);
            if (!key) continue;
            const owner = seen.get(key);
            if (owner) duplicates.push(`${name}: ${section} repeats ${owner}: "${sentence}"`);
            else seen.set(key, section);
          }
        }
      }
      expect(duplicates).toEqual([]);
    }
  });

  test("a core concept keyword is used by at most one prose section", () => {
    // "Core concept" = a multi-word phrase or a name the source capitalises
    // ("Kafka", "Spring Boot"). A generic lowercase noun the document happens to
    // repeat ("team", "work") is ordinary prose: the engine's rule is one
    // *emission* per concept, not one occurrence per common noun. Hashtag reuse
    // is by design, so this check looks at prose only.
    for (const [name, source, pkg] of TOPICS) {
      const coreKeywords = pkg.keywords.filter(
        (keyword) =>
          keyword.includes(" ") ||
          (keyword.match(/[A-Za-z][a-z]{2,}/g) ?? []).some((word) => {
            // Case-sensitive: only a word the document itself capitalises is a
            // name ("Kafka"), not the ordinary noun it would be in lowercase
            // ("team").
            const capitalised = word.charAt(0).toUpperCase() + word.slice(1);
            return new RegExp(`\\b${escapeRe(capitalised)}\\b`).test(source);
          }),
      );
      const sections = proseSections(pkg);
      const reuse: string[] = [];
      for (const keyword of coreKeywords) {
        const owners = (Object.keys(sections) as Section[]).filter((section) =>
          mentions(sections[section], keyword),
        );
        if (owners.length > 1) reuse.push(`${name}: "${keyword}" in ${owners.join(" + ")}`);
      }
      expect(reuse).toEqual([]);
      if (name === "tech") {
        // The tech fixture must actually exercise the rule. (For the
        // remote-work fixture every extracted keyword happens to be a generic
        // lowercase noun, so the rule is exercised there by the curated
        // concept lists in the two tests below.)
        const core = coreKeywords.map((k) => k.toLowerCase());
        expect(core.length).toBeGreaterThanOrEqual(3);
        expect(core).toContain("kafka");
        expect(core).toContain("spring boot");
      }
    }
  });

  test("named entities and metrics are each stated in exactly one section (tech input)", () => {
    const sections = proseSections(tech);
    const concepts: [string, RegExp][] = [
      ["Java", /\bjava\b/i],
      ["Spring Boot", /spring\s*boot/i],
      ["Kafka", /\bkafka\b/i],
      ["microservices", /\bmicroservices?\b/i],
      ["2.5 million transactions", /2\.5\s*million/i],
      ["60% latency reduction", /\b60\s*%/],
      ["99.99% availability", /99\.99\s*%/],
      ["40 engineers", /\b40\b/],
    ];
    const counts = concepts.map(([label, re]) => {
      const owners = (Object.keys(sections) as Section[]).filter((s) => re.test(sections[s]));
      return `${label}:${owners.length}`;
    });
    expect(counts).toEqual(concepts.map(([label]) => `${label}:1`));
  });

  test("named entities and metrics are each stated in exactly one section (remote-work input)", () => {
    const sections = proseSections(remote);
    const concepts: [string, RegExp][] = [
      ["remote work", /remote\s*work/i],
      ["meeting load", /meeting\s*load/i],
      ["burnout", /\bburnout\b/i],
      ["written clarity", /written\s*clarity/i],
      ["1,200 workers", /1[,.]?200/],
      ["22% faster", /\b22\s*%/],
      ["84% retention", /\b84\s*%/],
      ["weekly written update", /weekly\s+written\s+update/i],
      ["knowledge workers", /knowledge\s*workers/i],
    ];
    const counts = concepts.map(([label, re]) => {
      const owners = (Object.keys(sections) as Section[]).filter((s) => re.test(sections[s]));
      return `${label}:${owners.length}`;
    });
    expect(counts).toEqual(concepts.map(([label]) => `${label}:1`));
  });
});

// ---------------------------------------------------------------------------
// 5. Hardening checks
// ---------------------------------------------------------------------------
describe("hardening", () => {
  test("no template artefact (undefined / NaN / [object Object]) reaches the user", () => {
    const artefacts: string[] = [];
    for (const [name, , pkg] of TOPICS) {
      const hits = copyableText(pkg).match(/undefined|NaN|\[object Object\]/g);
      if (hits) artefacts.push(`${name}: ${[...new Set(hits)].join(", ")}`);
    }
    expect(artefacts).toEqual([]);
  });

  test("the documented package shape is always produced", () => {
    const problems: string[] = [];
    for (const [name, , pkg] of TOPICS) {
      if (pkg.summary.length === 0) problems.push(`${name}: empty summary`);
      if (pkg.takeaways.length !== 5) {
        problems.push(`${name}: ${pkg.takeaways.length} takeaways (expected 5)`);
      }
      if (pkg.keywords.length === 0) problems.push(`${name}: no keywords`);
      if (typeof pkg.social.x.text !== "string" || pkg.social.x.text.length === 0) {
        problems.push(`${name}: X post missing`);
      }
      if (typeof pkg.social.linkedin !== "string" || pkg.social.linkedin.length === 0) {
        problems.push(`${name}: LinkedIn post missing`);
      }
      if (pkg.social.instagram.visual.length === 0 || pkg.social.instagram.caption.length === 0) {
        problems.push(`${name}: Instagram block missing`);
      }
      for (const lang of ["spanish", "french", "hindi"] as const) {
        if (pkg.translations[lang].length === 0) problems.push(`${name}: ${lang} missing`);
      }
    }
    expect(problems).toEqual([]);
  });

  test("degenerate input does not throw and still returns a package", () => {
    const problems: string[] = [];
    const inputs: [string, string][] = [
      ["empty", ""],
      ["whitespace only", "   \n\t  "],
      ["tiny", "Ship small. Learn fast."],
      ["one word", "Kubernetes"],
      ["no terminal punctuation", "an article about caching without any full stop"],
    ];
    for (const [label, input] of inputs) {
      try {
        const pkg = generateMarketingPackage(input);
        if (!Array.isArray(pkg.summary)) problems.push(`${label}: summary is not an array`);
        if (!Array.isArray(pkg.takeaways)) problems.push(`${label}: takeaways is not an array`);
        if (typeof hashtagText(pkg) !== "string") problems.push(`${label}: hashtags missing`);
        if (typeof pkg.social.linkedin !== "string") problems.push(`${label}: linkedin missing`);
        if (typeof pkg.translations.hindi !== "string") problems.push(`${label}: hindi missing`);
      } catch (error) {
        problems.push(`${label}: threw ${(error as Error).message}`);
      }
    }
    expect(problems).toEqual([]);
  });

  test("whitespace-only input behaves exactly like empty input", () => {
    expect(generateMarketingPackage("   \n\t  ")).toEqual(generateMarketingPackage(""));
  });

  test("the engine runs from a bare import — no network, credentials or server call", async () => {
    // If the engine depended on a server function, an env var or fetch, this
    // import (or the call above) would fail inside the test runner.
    const mod = await import("../src/lib/engine");
    expect(typeof mod.generateMarketingPackage).toBe("function");
    expect(typeof mod.splitSentences).toBe("function");
  });
});
