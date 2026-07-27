/**
 * Prompts.
 *
 * Kept in one file, in English, regardless of the app's locale: a prompt is
 * code, and translating it would mean two behaviours to test instead of one.
 * What *is* localised is the language the model answers in, which every prompt
 * takes as an explicit instruction rather than leaving to the model's guess
 * about the note's language — a French lecture note with English section
 * headings should not come back half-translated.
 *
 * The Markdown dialect these prompts describe is the one in
 * `src/editor/markdown/`, which is also what export writes. Teaching the model
 * the same dialect the app already round-trips is what keeps a rewritten
 * callout a callout.
 */
import type { AiMessage } from './protocols';

export type RewriteMode = 'light' | 'full' | 'custom';
export type SynthesisStyle = 'summary' | 'revision' | 'qa' | 'glossary';

const DIALECT = `The note is written in a Markdown dialect with a few additions:
- \`> [!INFO]\`, \`> [!WARN]\`, \`> [!IMPORTANT]\` open a callout block.
- \`> [!TOGGLE Summary]\` opens a collapsible section.
- \`$x$\` is inline maths, \`$$…$$\` is a maths block.
- \`[[Note title]]\` links to another note in the library.
Preserve these markers exactly. Never invent a \`[[link]]\` to a note that was not already in the text.`;

function languageRule(language: string): string {
  return language.startsWith('fr')
    ? 'Answer in French, matching the register of the source note.'
    : 'Answer in English, matching the register of the source note.';
}

/** Every structured feature says this. Models are chatty by default and a
 * leading "Sure! Here's the JSON:" is the single most common parse failure. */
const JSON_ONLY =
  'Reply with a single JSON object and nothing else. No prose before it, no prose after it, no Markdown code fence around it.';

// -- Rewrite -----------------------------------------------------------------

const REWRITE_INTENT: Record<RewriteMode, string> = {
  light:
    'Fix spelling, grammar, punctuation and obvious transcription slips. Do not restructure, do not add information, and do not change the author\'s voice. Most blocks should come back untouched.',
  full: 'Rewrite for clarity: tighten sentences, fix grammar, and give shapeless runs of text real structure (headings, lists, callouts) where the content warrants it. Keep every fact, figure and definition the author wrote. Add nothing that was not already there.',
  custom: '',
};

export function rewritePrompt(options: {
  mode: RewriteMode;
  instruction?: string;
  blocks: string[];
  language: string;
}): AiMessage[] {
  const intent =
    options.mode === 'custom'
      ? (options.instruction?.trim() ?? '')
      : REWRITE_INTENT[options.mode];

  const numbered = options.blocks
    .map((block, index) => `<block index="${index}">\n${block}\n</block>`)
    .join('\n\n');

  return [
    {
      role: 'system',
      content: `You are editing a student's class notes inside a note-taking app. You are careful and conservative: these are someone's revision materials before an exam, and a fact you "corrected" into something wrong costs them marks.

${DIALECT}

${languageRule(options.language)}

The note is given as numbered blocks. Return only the blocks you want to change.

${JSON_ONLY} It must match:
{"summary": "one sentence describing what you changed", "blocks": [{"index": <number>, "action": "replace" | "insert" | "remove", "markdown": "<the new block as Markdown>", "rationale": "<short reason>"}]}

Rules:
- "replace" swaps block <index>. "insert" adds a new block *before* block <index>. "remove" deletes block <index> and takes no "markdown".
- One entry per block. Never merge two source blocks into one entry.
- If a block is already fine, leave it out entirely. An empty "blocks" array is a valid and often correct answer.
- Never return the whole note reworded when a handful of fixes would do.`,
    },
    {
      role: 'user',
      content: `${intent}\n\n${numbered}`,
    },
  ];
}

// -- Synthesis ---------------------------------------------------------------

const SYNTHESIS_INTENT: Record<SynthesisStyle, string> = {
  summary:
    'Write an executive summary: what this material is about, the handful of claims that matter, and what a reader should walk away knowing. Prose, not bullets, except where a list is genuinely the clearest form.',
  revision:
    'Write a revision sheet: the key definitions, formulae, dates and distinctions, organised under headings, dense enough to revise from the night before an exam. Use callouts for the things most often got wrong.',
  qa: 'Write a self-test: questions that probe understanding rather than recall of wording, each followed by its answer inside a `> [!TOGGLE Answer]` block so the reader can cover it up.',
  glossary:
    'Write a glossary: every term of art that appears in the material, defined in one or two sentences, in alphabetical order, as a definition list of bold term followed by its definition.',
};

export function synthesisPrompt(options: {
  style: SynthesisStyle;
  sources: { title: string; markdown: string }[];
  language: string;
}): AiMessage[] {
  const body = options.sources
    .map(
      (source, index) =>
        `<source index="${index}" title="${source.title.replace(/"/g, "'")}">\n${source.markdown}\n</source>`,
    )
    .join('\n\n');

  return [
    {
      role: 'system',
      content: `You are producing revision material from a student's class notes.

${DIALECT}

${languageRule(options.language)}

Work only from the sources given. Where they are silent, say so rather than filling the gap from general knowledge — a confident sentence the lecturer never said is worse than an acknowledged gap. Do not add a \`[[link]]\`; the app adds links back to the sources itself.

${JSON_ONLY} It must match:
{"title": "<a title for the new note>", "markdown": "<the note body as Markdown>"}`,
    },
    {
      role: 'user',
      content: `${SYNTHESIS_INTENT[options.style]}\n\n${body}`,
    },
  ];
}

// -- Ask ---------------------------------------------------------------------

/**
 * Questions about a note.
 *
 * The grounding rule is the whole feature. A student asking "what did she say
 * about the second theorem" wants what is in *their* note, and a model that
 * smooths over a gap with textbook knowledge turns a study aid into a source of
 * plausible-sounding errors they will not catch until the exam.
 */
export function askPrompt(options: {
  sources: { title: string; markdown: string }[];
  history: AiMessage[];
  question: string;
  language: string;
}): AiMessage[] {
  const body = options.sources
    .map(
      (source, index) =>
        `<note index="${index}" title="${source.title.replace(/"/g, "'")}">\n${source.markdown}\n</note>`,
    )
    .join('\n\n');

  return [
    {
      role: 'system',
      content: `You are answering questions about a student's own class notes, shown below.

${languageRule(options.language)}

- Answer from the notes first. Quote or point at the passage you are relying on.
- When the notes do not cover something, say plainly that the note does not say. You may then add what you know, but label it clearly as outside the note.
- Be concise. This is a side panel, not an essay.
- Plain Markdown only — no JSON, no code fence around the whole answer.

${body}`,
    },
    ...options.history,
    { role: 'user', content: options.question },
  ];
}
