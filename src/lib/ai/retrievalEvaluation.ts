/**
 * Reproducible retrieval quality metrics.
 *
 * The corpus and the retrieval implementation intentionally live elsewhere:
 * this scorer accepts only judgments and ranked ids, so the same harness can
 * compare today's lexical path with a future local-embedding experiment
 * without changing what "better" means halfway through the comparison.
 */
export interface RetrievalJudgment {
  id: string;
  relevantNoteIds: string[];
}

export interface RetrievalEvaluationResult {
  /** Fraction of questions with at least one relevant note in the first K. */
  hitRateAtK: number;
  /** Mean fraction of all known-good sources recovered in the first K. */
  recallAtK: number;
  /** Mean reciprocal rank of the first relevant source. */
  meanReciprocalRank: number;
  /** One stable headline number: the mean of recall@K and MRR. */
  score: number;
  cutoff: number;
  questionCount: number;
}

export function scoreRetrieval(
  judgments: RetrievalJudgment[],
  rankedByQuestion: ReadonlyMap<string, readonly string[]>,
  cutoff = 5,
): RetrievalEvaluationResult {
  if (!judgments.length) {
    return {
      hitRateAtK: 0,
      recallAtK: 0,
      meanReciprocalRank: 0,
      score: 0,
      cutoff,
      questionCount: 0,
    };
  }

  let hits = 0;
  let recall = 0;
  let reciprocalRank = 0;

  for (const judgment of judgments) {
    const expected = new Set(judgment.relevantNoteIds);
    const ranked = [...(rankedByQuestion.get(judgment.id) ?? [])].slice(0, cutoff);
    const relevantRanks = ranked
      .map((noteId, index) => (expected.has(noteId) ? index + 1 : 0))
      .filter((rank) => rank > 0);

    if (relevantRanks.length) {
      hits += 1;
      reciprocalRank += 1 / Math.min(...relevantRanks);
    }
    recall += expected.size
      ? new Set(ranked.filter((id) => expected.has(id))).size / expected.size
      : 0;
  }

  const hitRateAtK = hits / judgments.length;
  const recallAtK = recall / judgments.length;
  const meanReciprocalRank = reciprocalRank / judgments.length;
  return {
    hitRateAtK,
    recallAtK,
    meanReciprocalRank,
    score: (recallAtK + meanReciprocalRank) / 2,
    cutoff,
    questionCount: judgments.length,
  };
}
