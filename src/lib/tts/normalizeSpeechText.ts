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
