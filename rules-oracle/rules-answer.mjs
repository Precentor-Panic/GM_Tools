/**
 * Rules-answer composer — the ONE LLM call of the rules oracle (Aureus
 * table wave B4/G13). Deterministic retrieval (./index.mjs's searchRules)
 * stays free and is the default surface; this module composes a CITED
 * ruling from the retrieved excerpts for the GM-side "Ask a ruling" panel
 * and its post-to-Foundry-chat button.
 *
 * GM-ONLY by adjudication (Russell, 2026-09-03): players could
 * prompt-engineer favorable rulings, so no player-facing surface exists —
 * "rules oracle as a table mechanic" is a recorded future idea, not v1.
 *
 * Grounding discipline: the prompt carries ONLY the retrieved excerpts
 * (already snippet-capped by rules-library-search.mjs's IP caps) and
 * instructs answer-only-from-excerpts with (LABEL p.N) citations — an
 * unmarked book (page:null) cites as (LABEL). ZERO retrieved sources →
 * NO model call at all (cost avoidance + honesty): the caller renders
 * "not found in the library."
 *
 * Natural-language questions don't match an all-terms search, so the query
 * derives from the question via stopword-stripped content terms; when the
 * full set is too strict, the fallback is an OR-merge — each of the top
 * (longest) terms searched individually, results deduped and merged.
 * Deterministic and documented — never an LLM-side query rewrite.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { callModelDetailed, fillTemplate } from "../mutation-engine/llm-call.mjs";
import { searchRules } from "./index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_TEMPLATE = readFileSync(join(__dirname, "..", "prompts", "rules-answer.md"), "utf8");

export const DEFAULT_RULES_ANSWER_MODEL = "claude-sonnet-5";

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "than", "so", "to", "of", "in", "on", "at", "by", "for",
  "with", "without", "as", "is", "are", "was", "were", "be", "been", "being", "do", "does", "did", "can",
  "could", "may", "might", "must", "shall", "should", "will", "would", "i", "my", "we", "our", "you", "your",
  "he", "she", "it", "its", "they", "them", "their", "what", "when", "where", "which", "who", "whom", "why",
  "how", "that", "this", "these", "those", "there", "here", "from", "into", "onto", "about", "against",
  "somebody", "anybody", "everybody", "nobody", "anyone", "everyone", "something", "anything",
  "during", "while", "have", "has", "had", "not", "no", "get", "gets", "make", "makes", "take", "takes",
  "use", "uses", "using", "still", "also", "just", "even", "player", "character", "pc", "my", "someone"
]);

/**
 * Light suffix stem so a substring search bridges inflections — "grappling"
 * must find "grappled"/"grapple" (a real miss in the first live smoke).
 * Deliberately crude and order-of-checks-only; no stemming library.
 */
export function stemTerm(w) {
  if (w.length > 6 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** Stopword-stripped, lowercased, lightly-stemmed content terms of a natural-language question (order preserved, deduped post-stem). */
export function extractSearchTerms(question) {
  const stems = String(question ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ""))
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .map(stemTerm);
  return [...new Set(stems)];
}

function renderCitation(m) {
  if (m.family) {
    // Structured rows carry the raw 5etools source code + printed page.
    return m.page != null ? `(${m.source} p.${m.page})` : `(${m.source})`;
  }
  return m.page != null ? `(${m.label} p.${m.page})` : `(${m.label})`;
}

function renderExcerpts(hits) {
  const lines = [];
  let n = 0;
  for (const m of hits.structured.matches) {
    n++;
    lines.push(`[${n}] ${renderCitation(m)} ${m.name}${m.ruleType ? ` [${m.ruleType}]` : ""}\n${m.text}`);
  }
  for (const m of hits.books.matches) {
    n++;
    lines.push(`[${n}] ${renderCitation(m)}\n${m.snippet}`);
  }
  return { text: lines.join("\n\n"), count: n };
}

/**
 * @param {string} dataDir  the WF data dir (for the plutonium-side structured index)
 * @param {string} question the GM's natural-language rules question
 * @param {object} [opts]   {client, apiKey, model, maxTokens, limit} — llm-call.mjs's standard injection seams
 * @returns {Promise<{question, answer:string|null, noSources?:true, terms:string[], hits}>}
 */
export async function answerRulesQuestion(dataDir, question, opts = {}) {
  const q = String(question ?? "").trim();
  if (!q) throw new Error("answerRulesQuestion: a non-empty question is required.");

  const terms = extractSearchTerms(q);
  const allTerms = await searchRules(dataDir, { query: terms.join(" ") || q, limit: opts.limit });

  // The all-terms pass is precise but brittle (the first live smoke: the
  // PHB's actual grappling rule says "speed is halved", so a question
  // phrased with "reduce" excluded the one page that answers it, while
  // noisy stat-block pages matched every term). So the top (longest) terms
  // ALWAYS also run individually and SUPPLEMENT the all-terms hits —
  // all-terms first (precision), OR-supplement after (recall), deduped,
  // capped. Deterministic; never an LLM query rewrite.
  const usedTerms = terms.length > 1 ? [...terms].sort((a, b) => b.length - a.length).slice(0, 4) : terms;
  const structured = [...allTerms.structured.matches];
  const books = [...allTerms.books.matches];
  const seenS = new Set(structured.map((m) => `${m.family}|${m.name}|${m.source}`));
  const seenB = new Set(books.map((m) => `${m.book}|${m.page}`));
  let installedS = allTerms.structured.installed;
  let installedB = allTerms.books.installed;
  if (terms.length > 1) {
    for (const term of usedTerms) {
      const h = await searchRules(dataDir, { query: term, limit: opts.limit });
      installedS = h.structured.installed;
      installedB = h.books.installed;
      for (const m of h.structured.matches) {
        const key = `${m.family}|${m.name}|${m.source}`;
        if (!seenS.has(key)) { seenS.add(key); structured.push(m); }
      }
      for (const m of h.books.matches) {
        const key = `${m.book}|${m.page}`;
        if (!seenB.has(key)) { seenB.add(key); books.push(m); }
      }
    }
  }
  const hits = {
    structured: { installed: installedS, matches: structured.slice(0, 8) },
    books: { installed: installedB, matches: books.slice(0, 8) }
  };

  const { text: excerpts, count } = renderExcerpts(hits);
  if (!count) {
    return { question: q, answer: null, noSources: true, terms: usedTerms, hits };
  }

  const prompt = fillTemplate(PROMPT_TEMPLATE, { question: q, excerpts });
  const { text } = await callModelDetailed(prompt, {
    client: opts.client,
    apiKey: opts.apiKey,
    model: opts.model ?? DEFAULT_RULES_ANSWER_MODEL,
    maxTokens: opts.maxTokens ?? 1024
  });
  const answer = String(text ?? "").trim();
  if (!answer) throw new Error("answerRulesQuestion: the model returned no usable answer.");
  return { question: q, answer, terms: usedTerms, hits };
}
