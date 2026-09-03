import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  generateMarketingPackage,
  type MarketingResult,
} from "~/lib/engine";
import { translateSummaryLLM } from "~/lib/llm-translate";

export const Route = createFileRoute("/")({
  component: Home,
});

// ---------------------------------------------------------------------------
// Clipboard helper with brief visual feedback
// ---------------------------------------------------------------------------
function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for older browsers / non-secure contexts.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(key);
    window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1600);
  };
  return { copied, copy };
}

function CopyButton({
  copied,
  onCopy,
  label = "Copy",
}: {
  copied: boolean;
  onCopy: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onCopy}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
        copied
          ? "bg-emerald-500 text-white"
          : "bg-white text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-200 dark:ring-gray-700 dark:hover:bg-gray-700"
      }`}
    >
      {copied ? (
        <>
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
            <path
              fillRule="evenodd"
              d="M16.7 5.3a1 1 0 0 1 0 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L8 12.6l7.3-7.3a1 1 0 0 1 1.4 0z"
              clipRule="evenodd"
            />
          </svg>
          Copied!
        </>
      ) : (
        <>
          <svg
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="h-3.5 w-3.5"
          >
            <rect x="7" y="7" width="9" height="9" rx="1.5" />
            <path d="M13 6V4.5A1.5 1.5 0 0 0 11.5 3h-7A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13H6" />
          </svg>
          {label}
        </>
      )}
    </button>
  );
}

function SectionCard({
  title,
  icon,
  copied,
  onCopy,
  copyLabel,
  children,
}: {
  title: string;
  icon: ReactNode;
  copied: boolean;
  onCopy: () => void;
  copyLabel?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <header className="flex items-center justify-between gap-3 border-b border-gray-100 px-5 py-4 dark:border-gray-800">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
            {icon}
          </span>
          <h2 className="text-sm font-bold tracking-tight text-gray-900 dark:text-gray-100">
            {title}
          </h2>
        </div>
        <CopyButton copied={copied} onCopy={onCopy} label={copyLabel ?? "Copy"} />
      </header>
      <div className="px-5 py-5">{children}</div>
    </section>
  );
}

const icon = (d: string) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-4.5 w-4.5"
  >
    <path d={d} />
  </svg>
);

const ICONS = {
  summary: icon(
    "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01",
  ),
  takeaways: icon("M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"),
  x: icon("M4 4l16 16M20 4L4 20"),
  linkedin: icon("M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4V9h4v1.5A5.98 5.98 0 0 1 16 8zM6 9H2v12h4zM4 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"),
  instagram: icon("M16 3H8a5 5 0 0 0-5 5v8a5 5 0 0 0 5 5h8a5 5 0 0 0 5-5V8a5 5 0 0 0-5-5zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7zM17.5 6.5h.01"),
  translate: icon("M4 5h7M9 3v2M5.5 3c.8 3 2.5 5.5 5 7M3 8c2.5.5 5 1.5 6.5 3.5M12 21l4-10 4 10M14.5 17h5"),
};

const FREE_LIMIT = 2;
const ADMIN_PASSWORD = "UnlockAI786";
const KEY_COUNT = "repurposeai_usage";
const KEY_UNLOCKED = "repurposeai_unlocked";
const KEY_HISTORY = "repurposeai_history";
const HISTORY_LIMIT = 5;

interface HistoryEntry {
  id: string;
  timestamp: number;
  preview: string;
  takeawayCount: number;
  result: MarketingResult;
}

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY_HISTORY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveHistoryList(list: HistoryEntry[]) {
  try {
    localStorage.setItem(KEY_HISTORY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days > 1 ? "s" : ""} ago`;
  return d.toLocaleDateString();
}

function useTrial() {
  const readCount = () => {
    try {
      return Number(localStorage.getItem(KEY_COUNT)) || 0;
    } catch {
      return 0;
    }
  };
  const readUnlocked = () => {
    try {
      return localStorage.getItem(KEY_UNLOCKED) === "1";
    } catch {
      return false;
    }
  };

  const [usageCount, setUsageCount] = useState(readCount);
  const [unlocked, setUnlocked] = useState(readUnlocked);
  // Track whether the locked overlay has been shown this session (so closing
  // it dismisses until the next blocked attempt).
  const [showLocked, setShowLocked] = useState(false);

  const persistCount = (n: number) => {
    setUsageCount(n);
    try {
      localStorage.setItem(KEY_COUNT, String(n));
    } catch {
      /* ignore */
    }
  };

  const registerUse = () => persistCount(Math.min(usageCount + 1, FREE_LIMIT + 1));

  const unlock = () => {
    setUnlocked(true);
    setShowLocked(false);
    try {
      localStorage.setItem(KEY_UNLOCKED, "1");
    } catch {
      /* ignore */
    }
  };

  const remaining = Math.max(0, FREE_LIMIT - usageCount);

  return { usageCount, unlocked, showLocked, remaining, registerUse, unlock, setShowLocked };
}

function Home() {
  const [text, setText] = useState("");
  const [result, setResult] = useState<MarketingResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [translationsLoading, setTranslationsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminPass, setAdminPass] = useState("");
  const [adminError, setAdminError] = useState<string | null>(null);
  const [adminSuccess, setAdminSuccess] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const { copied, copy } = useCopy();
  const trial = useTrial();

  // Load previously saved generations from LocalStorage when the page loads.
  useEffect(() => {
    setHistory(loadHistory());
  }, []);

  const saveHistoryEntry = (pkg: MarketingResult) => {
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`;
    const preview = (pkg.summary[0] ?? pkg.keywords.slice(0, 3).join(", ") ?? "Generation").slice(
      0,
      120,
    );
    setHistory((prev) => {
      const next = [
        {
          id,
          timestamp: Date.now(),
          preview,
          takeawayCount: pkg.takeaways.length,
          result: pkg,
        },
        ...prev,
      ].slice(0, HISTORY_LIMIT);
      saveHistoryList(next);
      return next;
    });
    return id;
  };

  const updateHistoryTranslations = (id: string, translations: MarketingResult["translations"]) => {
    setHistory((prev) => {
      const next = prev.map((h) =>
        h.id === id ? { ...h, result: { ...h.result, translations } } : h,
      );
      saveHistoryList(next);
      return next;
    });
  };

  const loadIntoView = (entry: HistoryEntry) => {
    setResult(entry.result);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const clearHistory = () => {
    setHistory([]);
    try {
      localStorage.removeItem(KEY_HISTORY);
    } catch {
      /* ignore */
    }
  };

  const words = text.trim().split(/\s+/).filter(Boolean).length;

  const handleGenerate = () => {
    // Hard gate: block generation entirely if the trial limit is reached.
    if (!trial.unlocked && trial.usageCount >= FREE_LIMIT) {
      trial.setShowLocked(true);
      setResult(null);
      return;
    }
    setError(null);
    trial.registerUse();
    setLoading(true);
    setTranslationsLoading(true);
    // Small deliberate delay so the UI reads as "processing".
    window.setTimeout(() => {
      const pkg = generateMarketingPackage(text);
      // Summary / takeaways / social render immediately, with the in-browser
      // dictionary translations as the instant, offline-safe placeholder.
      setResult(pkg);
      setLoading(false);
      // Save this generation to LocalStorage history (capped at most recent 5).
      const entryId = saveHistoryEntry(pkg);
      // Kick off the fluent server-side translation. When it returns it swaps
      // in the native-quality Spanish/French/Hindi; if the key is missing or
      // the API fails, `null` keeps the dictionary fallback already rendered.
      translateSummaryLLM({ data: pkg.summary.join(" ") })
        .then((fluent) => {
          if (fluent) {
            const translations = {
              spanish: fluent.spanish,
              french: fluent.french,
              hindi: fluent.hindi,
            };
            setResult((r) =>
              r
                ? {
                    ...r,
                    translations,
                  }
                : r,
            );
            // Keep the saved history entry in sync with the refined output.
            updateHistoryTranslations(entryId, translations);
          }
        })
        .catch(() => {
          /* translation failed — keep the dictionary fallback */
        })
        .finally(() => setTranslationsLoading(false));
    }, 600);
  };

  const handleAdminSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (adminPass === ADMIN_PASSWORD) {
      trial.unlock();
      setAdminSuccess(true);
      setAdminError(null);
      setAdminPass("");
    } else {
      setAdminError("Incorrect password. Please try again.");
    }
  };

  const countString = `${words.toLocaleString()} words · ${text.length.toLocaleString()} chars`;

  return (
    <div className="min-h-dvh bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      {/* Hero */}
      <header className="border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-5 py-5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-sm">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
                <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="text-lg font-black tracking-tight">RepurposeAI</span>
          </div>
          <span className="hidden rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200 sm:inline-block dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30">
            ⚡ Runs in your browser — no signup
          </span>
        </div>
      </header>

      {/* Hero copy */}
      <div className="mx-auto max-w-4xl px-5 pt-12 pb-8 text-center sm:pt-16">
        <h1 className="mx-auto max-w-2xl text-4xl font-black tracking-tight text-balance sm:text-5xl">
          Turn any long-form content into a{" "}
          <span className="bg-gradient-to-r from-indigo-500 to-violet-600 bg-clip-text text-transparent">
            complete marketing package
          </span>{" "}
          in one click.
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-lg text-gray-600 dark:text-gray-400">
          Paste an article, transcript, or your notes. Get an executive summary,
          key takeaways, ready-to-post social content, and multilingual
          translations — instantly, right in your browser.
        </p>
      </div>

      {/* Input */}
      <div className="mx-auto max-w-4xl px-5 pb-10">
        <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste your article, transcript, or notes here…"
            spellCheck={false}
            rows={9}
            className="block w-full resize-y bg-transparent px-5 py-4 text-[15px] leading-relaxed text-gray-900 outline-none placeholder:text-gray-400 dark:text-gray-100 dark:placeholder:text-gray-500"
          />
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 bg-gray-50/60 px-4 py-3 dark:border-gray-800 dark:bg-gray-900/60">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
              {countString}
            </span>
            <div className="flex items-center gap-2">
              <span
                className={`hidden rounded-full px-3 py-1 text-xs font-semibold sm:inline-block ${
                  trial.unlocked
                    ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30"
                    : "bg-amber-50 text-amber-700 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30"
                }`}
              >
                {trial.unlocked
                  ? "♾️ Unlimited"
                  : `${trial.remaining} of ${FREE_LIMIT} free generation${trial.remaining === 1 ? "" : "s"} left`}
              </span>
              {text.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setText("");
                    setResult(null);
                    setError(null);
                  }}
                  className="rounded-lg px-3 py-1.5 text-xs font-semibold text-gray-500 ring-1 ring-gray-200 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:ring-gray-700 dark:hover:bg-gray-800"
                >
                  Clear
                </button>
              )}
              <button
                type="button"
                onClick={handleGenerate}
                disabled={loading}
                className="rounded-lg bg-gradient-to-r from-indigo-600 to-violet-600 px-5 py-2 text-sm font-bold text-white shadow-sm transition hover:from-indigo-500 hover:to-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {loading ? (
                  <span className="inline-flex items-center gap-2">
                    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 animate-spin">
                      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.3" />
                      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                    </svg>
                    Generating…
                  </span>
                ) : (
                  "Generate"
                )}
              </button>
            </div>
          </div>
        </div>

        {error && (
          <p className="mt-3 rounded-lg bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-800 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30">
            {error}
          </p>
        )}
        {words > 0 && !error && (
          <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
            Ready to generate — no minimum length required.
          </p>
        )}
      </div>

      {/* Results */}
      {result && (
        <main className="mx-auto max-w-4xl space-y-5 px-5 pb-20">
          {/* Executive Summary */}
          <SectionCard
            title="Executive Summary"
            icon={ICONS.summary}
            copied={copied === "summary"}
            onCopy={() => copy("summary", result.summary.join(" "))}
          >
            <div className="space-y-3">
              {result.summary.map((s, i) => (
                <p key={i} className="text-[15px] leading-relaxed text-gray-700 dark:text-gray-300">
                  {s}
                </p>
              ))}
            </div>
            {result.keywords.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-1.5">
                {result.keywords.map((k) => (
                  <span
                    key={k}
                    className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                  >
                    {k}
                  </span>
                ))}
              </div>
            )}
          </SectionCard>

          {/* Key Takeaways */}
          <SectionCard
            title="Key Takeaways"
            icon={ICONS.takeaways}
            copied={copied === "takeaways"}
            onCopy={() => copy("takeaways", result.takeaways.map((t) => `• ${t}`).join("\n"))}
          >
            <ul className="space-y-2.5">
              {result.takeaways.map((t, i) => (
                <li key={i} className="flex gap-3 text-[15px] leading-relaxed text-gray-700 dark:text-gray-300">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-[11px] font-bold text-white">
                    {i + 1}
                  </span>
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </SectionCard>

          {/* Social Media Kit */}
          <div className="rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <header className="flex items-center gap-2.5 border-b border-gray-100 px-5 py-4 dark:border-gray-800">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4.5 w-4.5">
                  <path d="M12 3a9 9 0 1 0 9 9" />
                  <path d="M12 7a5 5 0 1 0 5 5" />
                  <path d="M12 11h9" />
                </svg>
              </span>
              <h2 className="text-sm font-bold tracking-tight">Social Media Kit</h2>
            </header>
            <div className="divide-y divide-gray-100 dark:divide-gray-800">
              {/* X */}
              <div className="px-5 py-5">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm font-bold">
                    <span className="text-gray-900 dark:text-gray-100">{ICONS.x}</span> X (Twitter)
                  </div>
                  <CopyButton copied={copied === "x"} onCopy={() => copy("x", result.social.x.text + result.social.x.hashtags)} />
                </div>
                <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-gray-700 dark:text-gray-300">
                  {result.social.x.text}
                  <span className="block text-sky-600 dark:text-sky-400">{result.social.x.hashtags}</span>
                </p>
              </div>
              {/* LinkedIn */}
              <div className="px-5 py-5">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm font-bold">
                    <span className="text-gray-900 dark:text-gray-100">{ICONS.linkedin}</span> LinkedIn
                  </div>
                  <CopyButton copied={copied === "linkedin"} onCopy={() => copy("linkedin", result.social.linkedin)} />
                </div>
                <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-gray-700 dark:text-gray-300">
                  {result.social.linkedin}
                </p>
              </div>
              {/* Instagram */}
              <div className="px-5 py-5">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm font-bold">
                    <span className="text-gray-900 dark:text-gray-100">{ICONS.instagram}</span> Instagram
                  </div>
                  <CopyButton copied={copied === "instagram"} onCopy={() => copy("instagram", `Visual:\n${result.social.instagram.visual}\n\nCaption:\n${result.social.instagram.caption}${result.social.instagram.hashtags}`)} />
                </div>
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">Visual</p>
                <p className="mt-1 mb-4 text-[15px] leading-relaxed text-gray-700 dark:text-gray-300">
                  {result.social.instagram.visual}
                </p>
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">Caption</p>
                <p className="mt-1 whitespace-pre-wrap text-[15px] leading-relaxed text-gray-700 dark:text-gray-300">
                  {result.social.instagram.caption}
                  <span className="block text-pink-600 dark:text-pink-400">{result.social.instagram.hashtags}</span>
                </p>
              </div>
            </div>
          </div>

          {/* Multilingual Translation */}
          <SectionCard
            title="Multilingual Translation"
            icon={ICONS.translate}
            copied={copied === "translations"}
            onCopy={() =>
              copy(
                "translations",
                [
                  `Spanish:\n${result.translations.spanish}`,
                  `French:\n${result.translations.french}`,
                  `Hindi:\n${result.translations.hindi}`,
                ].join("\n\n"),
              )
            }
          >
            <div className="grid gap-4 sm:grid-cols-1">
              {translationsLoading && (
                <p className="flex items-center gap-2 rounded-xl bg-indigo-50 px-4 py-3 text-sm font-medium text-indigo-700 ring-1 ring-indigo-100 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-500/20">
                  <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent dark:border-indigo-400" />
                  Refining translations with AI…
                </p>
              )}
              {(
                [
                  ["🇪🇸 Spanish", result.translations.spanish],
                  ["🇫🇷 French", result.translations.french],
                  ["🇮🇳 Hindi", result.translations.hindi],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="rounded-xl bg-gray-50 p-4 ring-1 ring-gray-100 dark:bg-gray-800/50 dark:ring-gray-800">
                  <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-gray-400 dark:text-gray-500">{label}</p>
                  <p className="text-[15px] leading-relaxed text-gray-700 dark:text-gray-300">{value}</p>
                </div>
              ))}
            </div>
          </SectionCard>

          <p className="pt-2 text-center text-xs text-gray-400 dark:text-gray-600">
            Everything is generated locally in your browser — your content never leaves your device.
          </p>
        </main>
      )}

      {/* Empty state */}
      {!result && !loading && (
        <div className="mx-auto max-w-4xl px-5 pb-24 text-center">
          <div className="rounded-2xl border border-dashed border-gray-300 bg-white/50 px-6 py-12 dark:border-gray-700 dark:bg-gray-900/40">
            <p className="text-sm font-medium text-gray-500 dark:text-gray-400">
              Paste your content above, then hit{" "}
              <span className="font-bold text-indigo-600 dark:text-indigo-400">
                Generate
              </span>{" "}
              to build your full kit — summary, takeaways, social posts, and translations.
            </p>
          </div>
        </div>
      )}

      {/* History */}
      <div className="mx-auto max-w-4xl px-5 pb-16">
        <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <header className="flex items-center justify-between gap-3 border-b border-gray-100 px-5 py-4 dark:border-gray-800">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4.5 w-4.5">
                  <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                  <path d="M3 3v5h5" />
                  <path d="M12 7v5l3 2" />
                </svg>
              </span>
              <h2 className="text-sm font-bold tracking-tight text-gray-900 dark:text-gray-100">
                History
              </h2>
            </div>
            {history.length > 0 && (
              <button
                type="button"
                onClick={clearHistory}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold text-gray-500 ring-1 ring-gray-200 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:ring-gray-700 dark:hover:bg-gray-800"
              >
                Clear
              </button>
            )}
          </header>
          <div className="px-5 py-5">
            {history.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                No generations yet — your saved results will appear here.
              </p>
            ) : (
              <ul className="space-y-2.5">
                {history.map((h) => (
                  <li key={h.id}>
                    <button
                      type="button"
                      onClick={() => loadIntoView(h)}
                      title="Click to reload this generation"
                      className="w-full cursor-pointer rounded-xl border border-gray-100 bg-gray-50/60 px-4 py-3 text-left transition hover:border-indigo-200 hover:bg-indigo-50/60 dark:border-gray-800 dark:bg-gray-800/40 dark:hover:border-indigo-500/40 dark:hover:bg-indigo-500/10"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs font-semibold text-gray-500 dark:text-gray-400">
                          {formatTimestamp(h.timestamp)}
                        </span>
                        <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                          {h.takeawayCount} takeaways
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-gray-700 dark:text-gray-300">
                        {h.preview}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      <footer className="border-t border-gray-200 bg-white py-6 text-center text-sm text-gray-400 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-600">
        <p className="mb-4">RepurposeAI — Content Repurposing &amp; Multilingual Translation Agent</p>
        {!adminOpen ? (
          <button
            type="button"
            onClick={() => {
              setAdminOpen(true);
              setAdminError(null);
              setAdminSuccess(false);
            }}
            className="rounded-lg px-3 py-1 text-xs font-medium text-gray-400 underline-offset-2 hover:text-gray-600 hover:underline dark:text-gray-600 dark:hover:text-gray-400"
          >
            Admin Login
          </button>
        ) : (
          <div className="mx-auto max-w-xs px-5">
            {trial.unlocked ? (
              <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                ✅ Unlimited access active for this session.
              </p>
            ) : (
              <form
                onSubmit={handleAdminSubmit}
                className="flex items-center justify-center gap-2"
              >
                <input
                  type="password"
                  value={adminPass}
                  onChange={(e) => {
                    setAdminPass(e.target.value);
                    setAdminError(null);
                  }}
                  placeholder="Admin password"
                  autoFocus
                  className="w-40 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:focus:border-indigo-500 dark:focus:ring-indigo-500/30"
                />
                <button
                  type="submit"
                  className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300"
                >
                  Unlock
                </button>
                <button
                  type="button"
                  onClick={() => setAdminOpen(false)}
                  className="rounded-lg px-2 py-1.5 text-xs font-medium text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                >
                  Cancel
                </button>
              </form>
            )}
            {adminError && (
              <p className="mt-2 text-xs font-medium text-rose-600 dark:text-rose-400">{adminError}</p>
            )}
          </div>
        )}
      </footer>

      {/* Trial-limit locked overlay */}
      {trial.showLocked && !trial.unlocked && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-5 backdrop-blur-sm"
          onClick={() => trial.setShowLocked(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-2xl dark:border-gray-700 dark:bg-gray-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 text-3xl dark:bg-amber-500/15">
              🔒
            </div>
            <h2 className="text-xl font-black tracking-tight text-gray-900 dark:text-gray-100">
              Trial Limit Reached
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-gray-600 dark:text-gray-400">
              Please contact the developer to unlock unlimited lifetime access.
            </p>
            <button
              type="button"
              onClick={() => trial.setShowLocked(false)}
              className="mt-6 w-full rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:from-indigo-500 hover:to-violet-500"
            >
              Close
            </button>

            <div className="mt-6 border-t border-gray-100 pt-5 dark:border-gray-800">
              <p className="mb-3 text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
                Already have access?
              </p>
              {!adminOpen ? (
                <button
                  type="button"
                  onClick={() => {
                    setAdminOpen(true);
                    setAdminError(null);
                    setAdminSuccess(false);
                  }}
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-indigo-200 bg-indigo-50 px-5 py-2.5 text-sm font-bold text-indigo-700 transition hover:bg-indigo-100 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-300 dark:hover:bg-indigo-500/20"
                >
                  🔑 Admin Login
                </button>
              ) : (
                <form onSubmit={handleAdminSubmit} className="flex flex-col items-center gap-2.5">
                  <input
                    type="password"
                    value={adminPass}
                    onChange={(e) => {
                      setAdminPass(e.target.value);
                      setAdminError(null);
                    }}
                    placeholder="Admin password"
                    autoFocus
                    className="w-full max-w-xs rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm text-gray-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:focus:border-indigo-500 dark:focus:ring-indigo-500/30"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="submit"
                      className="rounded-xl bg-gray-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300"
                    >
                      Unlock
                    </button>
                    <button
                      type="button"
                      onClick={() => setAdminOpen(false)}
                      className="rounded-xl px-3 py-2 text-sm font-medium text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                    >
                      Cancel
                    </button>
                  </div>
                  {adminError && (
                    <p className="text-xs font-medium text-rose-600 dark:text-rose-400">{adminError}</p>
                  )}
                </form>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
