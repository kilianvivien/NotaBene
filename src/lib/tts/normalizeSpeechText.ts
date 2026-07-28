/**
 * Deterministic speech normalization. It removes presentation syntax without
 * rewriting the student's meaning or involving an AI provider.
 */
export function normalizeSpeechText(text: string, locale = 'en'): string {
  const language = locale.toLowerCase().slice(0, 2);
  return (
    text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[([^\]]*)]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)]\((https?:\/\/[^)]+)\)/g, '$1')
      .replace(
        /https?:\/\/(?:www\.)?([^/\s]+)(?:\/\S*)?/g,
        language === 'fr' ? 'lien vers $1' : 'link to $1',
      )
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+[.)]\s+/gm, '')
      .replace(/[*_~>|]/g, ' ')
      .replace(/&/g, language === 'fr' ? ' et ' : ' and ')
      // Emoji and pictographs are visual metadata, not prose.
      .replace(/\p{Extended_Pictographic}/gu, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*\n\s*/g, '. ')
      .replace(/(?:\.\s*){2,}/g, '. ')
      .trim()
  );
}

const MAX_WORDS = 280;
const MAX_CHARS = 1_600;

/** Split at sentence boundaries, then at words only when a sentence exceeds
 * the model's safe request budget. */
export function speechRequests(text: string, locale = 'en'): string[] {
  const normalized = normalizeSpeechText(text, locale);
  if (!normalized) return [];
  const sentences = normalized.match(/[^.!?…]+[.!?…]*/g) ?? [normalized];
  const requests: string[] = [];
  let current = '';
  let words = 0;

  const flush = () => {
    if (current.trim()) requests.push(current.trim());
    current = '';
    words = 0;
  };

  for (const sentence of sentences) {
    const sentenceWords = sentence.trim().split(/\s+/);
    if (
      current &&
      (words + sentenceWords.length > MAX_WORDS ||
        current.length + sentence.length > MAX_CHARS)
    ) {
      flush();
    }
    for (const word of sentenceWords) {
      if (words >= MAX_WORDS || current.length + word.length + 1 > MAX_CHARS) flush();
      current += `${current ? ' ' : ''}${word}`;
      words += 1;
    }
  }
  flush();
  return requests;
}
