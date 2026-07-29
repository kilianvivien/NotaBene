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

/**
 * Voxtral is less forgiving than the system and Kokoro engines when prompts
 * contain invisible Unicode or finish without spoken punctuation. Keep this
 * profile separate so the engines that already work retain their exact input.
 */
export function normalizeVoxtralSpeechText(text: string, locale = 'en'): string {
  const language = locale.toLowerCase().slice(0, 2);
  const visible = text
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(
      /(-?\d+(?:[.,]\d+)?)\s*°\s*C\b/gi,
      (_, value: string) =>
        language === 'fr'
          ? `${value} degrés Celsius`
          : `${value} degrees Celsius`,
    );
  const normalized = normalizeSpeechText(visible, locale)
    .replace(/\.{3,}/g, '…')
    .replace(/([!?])\1+/g, '$1')
    .replace(/([!?…])\s*\.+/g, '$1')
    .replace(/\s*--+\s*/g, ' - ')
    .replace(/[ \t]+/g, ' ')
    .trim();

  if (!normalized || /[.!?…]["')\]]?$/.test(normalized)) return normalized;
  if (/[,;:]$/.test(normalized)) return `${normalized.slice(0, -1)}.`;
  return `${normalized}.`;
}
