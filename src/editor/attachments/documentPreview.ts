export function readAttachmentBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result as ArrayBuffer), {
      once: true,
    });
    reader.addEventListener('error', () => reject(reader.error), { once: true });
    reader.readAsArrayBuffer(blob);
  });
}

export async function readAttachmentText(blob: Blob): Promise<string> {
  return new TextDecoder('utf-8').decode(await readAttachmentBuffer(blob));
}

interface RtfState {
  skip: boolean;
  unicodeFallback: number;
}

const DESTINATIONS = new Set([
  'author',
  'colortbl',
  'comment',
  'creatim',
  'datastore',
  'filetbl',
  'fonttbl',
  'footer',
  'footerf',
  'footerl',
  'footerr',
  'generator',
  'header',
  'headerf',
  'headerl',
  'headerr',
  'info',
  'keywords',
  'operator',
  'pict',
  'printim',
  'revtim',
  'stylesheet',
  'subject',
  'title',
  'xmlnstbl',
]);

const SYMBOLS: Record<string, string> = {
  bullet: '•',
  cell: '\t',
  emdash: '—',
  endash: '–',
  lquote: '‘',
  ldblquote: '“',
  line: '\n',
  par: '\n',
  rquote: '’',
  rdblquote: '”',
  row: '\n',
  tab: '\t',
};

/**
 * Convert RTF to safe, readable plain text. Formatting controls are discarded,
 * while paragraphs, Unicode escapes, punctuation, and Windows-1252 hex bytes
 * are retained.
 */
export function rtfToText(source: string): string {
  const states: RtfState[] = [{ skip: false, unicodeFallback: 1 }];
  const output: string[] = [];
  let index = 0;
  let fallback = 0;

  while (index < source.length) {
    const state = states[states.length - 1] ?? states[0]!;
    const character = source[index] ?? '';

    if (fallback > 0) {
      fallback -= 1;
      index += 1;
      continue;
    }
    if (character === '{') {
      states.push({ ...state });
      index += 1;
      continue;
    }
    if (character === '}') {
      if (states.length > 1) states.pop();
      index += 1;
      continue;
    }
    if (character !== '\\') {
      if (!state.skip && character !== '\r' && character !== '\n') output.push(character);
      index += 1;
      continue;
    }

    const next = source[index + 1] ?? '';
    if (next === '\\' || next === '{' || next === '}') {
      if (!state.skip) output.push(next);
      index += 2;
      continue;
    }
    if (next === '*') {
      state.skip = true;
      index += 2;
      continue;
    }
    if (next === "'") {
      const hex = source.slice(index + 2, index + 4);
      if (!state.skip && /^[\da-f]{2}$/i.test(hex)) {
        output.push(
          new TextDecoder('windows-1252').decode(Uint8Array.of(parseInt(hex, 16))),
        );
      }
      index += 4;
      continue;
    }

    const control = source.slice(index + 1).match(/^([a-z]+)(-?\d+)? ?/i);
    if (!control) {
      index += 2;
      continue;
    }
    const word = (control[1] ?? '').toLowerCase();
    const parameter = control[2] === undefined ? undefined : Number(control[2]);
    index += 1 + control[0].length;

    if (DESTINATIONS.has(word)) {
      state.skip = true;
    } else if (word === 'uc' && parameter !== undefined) {
      state.unicodeFallback = Math.max(0, parameter);
    } else if (word === 'u' && parameter !== undefined && !state.skip) {
      output.push(String.fromCharCode(parameter < 0 ? parameter + 65536 : parameter));
      fallback = state.unicodeFallback;
    } else if (SYMBOLS[word] && !state.skip) {
      output.push(SYMBOLS[word]);
    }
  }

  return output
    .join('')
    .split(String.fromCharCode(0))
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
