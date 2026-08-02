/**
 * Question → search terms.
 *
 * Retrieval needs the content words of a question, folded the way the FTS5
 * index folds them. Deliberately a heuristic and not a model call: an extra
 * round trip before the first token would double the latency of a panel whose
 * whole appeal is that it streams, and it would bill the student's key twice
 * for every question.
 *
 * This lives in `search/` rather than `ai/` so the search box and the MCP
 * handlers can use it without importing the AI layer.
 */
import { fold } from './fold';

/**
 * Words that say nothing about which note to look in. Both languages, always —
 * a French student asking a French question gets nothing from an English-only
 * list, and the app has no per-question language to switch on.
 */
const STOPWORDS = new Set([
  // English
  'a', 'about', 'after', 'again', 'all', 'also', 'am', 'an', 'and', 'any', 'are',
  'as', 'at', 'be', 'because', 'been', 'before', 'being', 'between', 'both', 'but',
  'by', 'can', 'could', 'did', 'do', 'does', 'doing', 'done', 'down', 'during',
  'each', 'explain', 'few', 'for', 'from', 'further', 'give', 'had', 'has', 'have',
  'having', 'he', 'her', 'here', 'hers', 'him', 'his', 'how', 'i', 'if', 'in',
  'into', 'is', 'it', 'its', 'just', 'know', 'like', 'me', 'mean', 'means', 'more',
  'most', 'much', 'my', 'no', 'nor', 'not', 'of', 'off', 'on', 'once', 'only',
  'or', 'other', 'our', 'out', 'over', 'own', 'said', 'same', 'say', 'says', 'she',
  'should', 'so', 'some', 'som', 'such', 'tell', 'than', 'that', 'the', 'their',
  'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to',
  'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'while', 'who', 'whom', 'whose', 'why', 'will', 'with',
  'would', 'you', 'your',
  // French
  'alors', 'au', 'aux', 'aussi', 'autre', 'avait', 'avec', 'avoir', 'bien', 'ca',
  'car', 'ce', 'cela', 'ces', 'cet', 'cette', 'ceux', 'chaque', 'comme',
  'comment', 'dans', 'de', 'des', 'donc', 'dont', 'du', 'elle', 'elles', 'en',
  'encore', 'est', 'et', 'etait', 'etaient', 'etre', 'eux', 'explique',
  'expliquer', 'fait', 'faire', 'ici', 'il', 'ils', 'je', 'la', 'le', 'les',
  'leur', 'leurs', 'lui', 'ma', 'mais', 'me', 'meme', 'mes', 'moi', 'mon', 'ne',
  'ni', 'nos', 'notre', 'nous', 'on', 'ont', 'ou', 'par', 'parce', 'pas',
  'peut', 'plus', 'pour', 'pourquoi', 'quand', 'que', 'quel', 'quelle',
  'quelles', 'quels', 'qui', 'quoi', 'sa', 'sans', 'se', 'ses', 'si', 'son',
  'sont', 'sous', 'sur', 'ta', 'te', 'tes', 'toi', 'ton', 'tous', 'tout',
  'toute', 'toutes', 'tu', 'un', 'une', 'vos', 'votre', 'vous', 'y',
]);

/** Past this, FTS5 prefix terms start costing more than they find. */
const MAX_TERMS = 12;

/** Below two content words a question is not specific enough to retrieve on. */
const MIN_TERMS_BEFORE_CARRY_FORWARD = 2;

/**
 * Content words from a question, folded to match the index
 * (`unicode61 remove_diacritics 2`), so "théorème" and "theoreme" agree.
 *
 * Short tokens survive when they carry a digit or were written in capitals:
 * `SN2`, `L2`, `pH` and `TP` are exactly the terms a student searches for, and
 * a blanket three-character floor would drop all of them.
 */
export function deriveKeywords(question: string, options: { max?: number } = {}): string[] {
  const max = options.max ?? MAX_TERMS;
  const terms: string[] = [];
  const seen = new Set<string>();

  // Split exactly where `unicode61` splits, so a term derived here is a term
  // the index can actually contain: `s'applique` is `s` + `applique` there too,
  // and a trailing `?` never becomes part of a word.
  for (const word of question.match(/[\p{L}\p{N}]+/gu) ?? []) {
    const folded = fold(word);
    if (!folded || STOPWORDS.has(folded)) continue;
    // `SN2`, `L2`, `pH`, `TP` are exactly what a student searches for, and a
    // blanket three-character floor would drop every one of them.
    const significant = /\d/.test(word) || /\p{Lu}/u.test(word);
    if (folded.length < 3 && !significant) continue;
    if (seen.has(folded)) continue;
    seen.add(folded);
    terms.push(folded);
    if (terms.length >= max) break;
  }

  return terms;
}

/**
 * Keywords for one turn of a conversation.
 *
 * "why does that follow?" has no content words at all, and it is precisely the
 * kind of follow-up this panel exists for. When a question is too thin to
 * retrieve on, the previous questions' keywords come along, so the follow-up
 * searches the same neighbourhood the student is already in.
 */
export function deriveTurnKeywords(question: string, priorQuestions: string[]): string[] {
  const own = deriveKeywords(question);
  if (own.length >= MIN_TERMS_BEFORE_CARRY_FORWARD) return own;

  const carried = [...own];
  const seen = new Set(own);
  // Most recent first: the question before this one is the best context.
  for (const prior of [...priorQuestions].reverse()) {
    for (const term of deriveKeywords(prior)) {
      if (seen.has(term)) continue;
      seen.add(term);
      carried.push(term);
      if (carried.length >= MAX_TERMS) return carried;
    }
  }
  return carried;
}
