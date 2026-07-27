/**
 * The NotaBene contract.
 *
 * Everything that crosses a trust boundary — a backup being restored, a note
 * arriving from the MCP server, a structured payload an LLM produced — is
 * parsed through these schemas before it can touch the library. Nothing else in
 * the app defines the shape of a note; when the model changes, it changes here
 * first and TypeScript points at every caller that has to follow.
 */
import { z } from 'zod';

/** Bumped whenever a persisted shape changes. See `migrations.ts`. */
export const SCHEMA_VERSION = 3;

const id = z.string().min(1);
const isoDate = z.string().datetime({ offset: true });
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #rrggbb');

// ---------------------------------------------------------------------------
// Document model
// ---------------------------------------------------------------------------

/**
 * ProseMirror/TipTap document JSON. Deliberately structural rather than
 * exhaustive: the node vocabulary belongs to the editor extensions, and pinning
 * every node type here would mean touching the contract for every new block.
 * What we do guarantee is that the tree is well-formed, so the flattener, the
 * export pipeline, and the search indexer can walk it without defensive checks.
 */
export type DocNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
};

export const DocNodeSchema: z.ZodType<DocNode> = z.lazy(() =>
  z.object({
    type: z.string().min(1),
    attrs: z.record(z.unknown()).optional(),
    content: z.array(DocNodeSchema).optional(),
    marks: z
      .array(
        z.object({ type: z.string().min(1), attrs: z.record(z.unknown()).optional() }),
      )
      .optional(),
    text: z.string().optional(),
  }),
);

export const NoteDocSchema = z.object({
  type: z.literal('doc'),
  content: z.array(DocNodeSchema).default([]),
});
export type NoteDoc = z.infer<typeof NoteDocSchema>;

// ---------------------------------------------------------------------------
// Library entities
// ---------------------------------------------------------------------------

export const CourseSchema = z.object({
  id,
  name: z.string().min(1),
  color: hexColor,
  /** Emoji or lucide icon name; emoji reads better in a dense sidebar. */
  icon: z.string().default('📘'),
  professor: z.string().optional(),
  semester: z.string().optional(),
  credits: z.number().int().nonnegative().optional(),
  /** Free-form timetable slot, e.g. "Mon 10:00–12:00". Display only in v1. */
  schedule: z.string().optional(),
  order: z.number().int().nonnegative().default(0),
  archived: z.boolean().default(false),
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type Course = z.infer<typeof CourseSchema>;

export const SectionSchema = z.object({
  id,
  courseId: id,
  name: z.string().min(1),
  order: z.number().int().nonnegative().default(0),
});
export type Section = z.infer<typeof SectionSchema>;

export const TAG_NAMESPACES = ['topic', 'prof', 'semester', 'exam', 'type'] as const;
export const TagNamespaceSchema = z.enum(TAG_NAMESPACES);
export type TagNamespace = z.infer<typeof TagNamespaceSchema>;
export const DEFAULT_TAG_COLOR = '#9b5c2f';
export const TAG_COLORS = [
  '#9b5c2f',
  '#3478c7',
  '#7d5aa8',
  '#aa4e6e',
  '#4b7c58',
  '#b56b22',
  '#4d7f8d',
  '#6f6b64',
] as const;

export const TagSchema = z.object({
  id,
  /** `null` for a plain free tag; a namespace makes it facetable in search. */
  namespace: TagNamespaceSchema.nullable().default(null),
  name: z.string().min(1),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .default(DEFAULT_TAG_COLOR),
});
export type Tag = z.infer<typeof TagSchema>;

export const NoteSchema = z.object({
  id,
  courseId: id.nullable().default(null),
  sectionId: id.nullable().default(null),
  title: z.string().default(''),
  doc: NoteDocSchema,
  /**
   * Flattened text, derived from `doc` on every write. Persisted (rather than
   * recomputed) because it is what FTS5 indexes and what list snippets render.
   */
  plainText: z.string().default(''),
  tagIds: z.array(id).default([]),
  pinned: z.boolean().default(false),
  archived: z.boolean().default(false),
  /** Set when the note is in Trash; `null` for live notes. */
  trashedAt: isoDate.nullable().default(null),
  createdAt: isoDate,
  updatedAt: isoDate,
  /** Manual ordering within a section; ties break on `updatedAt`. */
  order: z.number().int().nonnegative().default(0),
});
export type Note = z.infer<typeof NoteSchema>;

/** What the note list and search results render — never the full document. */
export const NoteSummarySchema = NoteSchema.omit({ doc: true, plainText: true }).extend({
  snippet: z.string().default(''),
});
export type NoteSummary = z.infer<typeof NoteSummarySchema>;

/** Content-addressed blob: images, drawing renders, attachment payloads, audio. */
export const AssetSchema = z.object({
  /** SHA-256 of the bytes — identity and deduplication in one. */
  id,
  mime: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  createdAt: isoDate,
});
export type Asset = z.infer<typeof AssetSchema>;

export const AttachmentSchema = z.object({
  id,
  noteId: id,
  assetId: id,
  name: z.string().min(1),
  createdAt: isoDate,
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const SNAPSHOT_CAUSES = ['auto', 'session', 'restore', 'ai', 'agent'] as const;
export const SnapshotCauseSchema = z.enum(SNAPSHOT_CAUSES);
export type SnapshotCause = z.infer<typeof SnapshotCauseSchema>;

export const SnapshotSchema = z.object({
  id,
  noteId: id,
  doc: NoteDocSchema,
  title: z.string().default(''),
  cause: SnapshotCauseSchema,
  createdAt: isoDate,
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

/**
 * In-flight editor state, written ahead of the debounced autosave.
 *
 * Not part of `LibrarySchema`, and deliberately so: a journal row is a few
 * seconds of unsaved typing, not library content. It has nothing to say in a
 * backup, and it disappears the moment its note reaches disk. It lives in the
 * contract because it crosses IPC, not because it is persisted for keeps —
 * which is why adding it needed no `SCHEMA_VERSION` bump: `editor_journal` has
 * been part of schema v1 since the first migration.
 */
export const JournalEntrySchema = z.object({
  noteId: id,
  doc: NoteDocSchema,
  title: z.string().default(''),
  writtenAt: isoDate,
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

/** A journal entry that outlived its note's last save, with enough of the note
 * to describe the choice the recovery prompt is asking the user to make. */
export const PendingRecoverySchema = JournalEntrySchema.extend({
  noteTitle: z.string().default(''),
  noteUpdatedAt: isoDate,
});
export type PendingRecovery = z.infer<typeof PendingRecoverySchema>;

export const SavedSearchSchema = z.object({
  id,
  name: z.string().min(1),
  /** Raw query string in the app's search syntax; parsed at run time. */
  query: z.string(),
  createdAt: isoDate,
});
export type SavedSearch = z.infer<typeof SavedSearchSchema>;

export const NoteTemplateSchema = z.object({
  id,
  name: z.string().min(1),
  /** `null` = global template, otherwise scoped to one course. */
  courseId: id.nullable().default(null),
  titlePattern: z.string().default(''),
  doc: NoteDocSchema,
  tagIds: z.array(id).default([]),
});
export type NoteTemplate = z.infer<typeof NoteTemplateSchema>;

/** A note that contains a wiki link to another note. */
export const BacklinkSchema = z.object({
  sourceId: id,
  sourceTitle: z.string(),
  snippet: z.string().default(''),
  updatedAt: isoDate,
});
export type Backlink = z.infer<typeof BacklinkSchema>;

// ---------------------------------------------------------------------------
// Library envelope — what backups and full exports carry
// ---------------------------------------------------------------------------

/**
 * The whole library in one validated envelope. Note what is absent: settings
 * and API keys. Backups must never be able to leak a key, so secrets simply
 * have no representation in this shape (PRD §5.4).
 */
export const LibrarySchema = z.object({
  schemaVersion: z.number().int().positive(),
  exportedAt: isoDate,
  appVersion: z.string().default('0.0.0'),
  courses: z.array(CourseSchema).default([]),
  sections: z.array(SectionSchema).default([]),
  notes: z.array(NoteSchema).default([]),
  tags: z.array(TagSchema).default([]),
  assets: z.array(AssetSchema).default([]),
  attachments: z.array(AttachmentSchema).default([]),
  snapshots: z.array(SnapshotSchema).default([]),
  savedSearches: z.array(SavedSearchSchema).default([]),
  templates: z.array(NoteTemplateSchema).default([]),
});
export type Library = z.infer<typeof LibrarySchema>;

// ---------------------------------------------------------------------------
// AI structured outputs
// ---------------------------------------------------------------------------

/**
 * Mind map produced by an LLM. Constrained hard on purpose: a model that
 * invents an edge to a node id that does not exist should fail validation
 * rather than render a broken graph.
 */
export const MindMapSchema = z
  .object({
    title: z.string().min(1),
    nodes: z
      .array(
        z.object({
          id,
          label: z.string().min(1),
          note: z.string().optional(),
          group: z.string().optional(),
        }),
      )
      .min(1),
    edges: z
      .array(z.object({ from: id, to: id, label: z.string().optional() }))
      .default([]),
  })
  .superRefine((map, ctx) => {
    const known = new Set(map.nodes.map((node) => node.id));
    for (const [index, edge] of map.edges.entries()) {
      for (const end of ['from', 'to'] as const) {
        if (!known.has(edge[end])) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['edges', index, end],
            message: `edge points at unknown node "${edge[end]}"`,
          });
        }
      }
    }
  });
export type MindMap = z.infer<typeof MindMapSchema>;

export const FlashcardSchema = z.object({
  id,
  kind: z.enum(['basic', 'cloze']).default('basic'),
  front: z.string().min(1),
  back: z.string().min(1),
  hint: z.string().optional(),
  tags: z.array(z.string()).default([]),
});
export type Flashcard = z.infer<typeof FlashcardSchema>;

export const FlashcardDeckSchema = z.object({
  title: z.string().min(1),
  cards: z.array(FlashcardSchema).min(1),
});
export type FlashcardDeck = z.infer<typeof FlashcardDeckSchema>;

export const PodcastScriptSchema = z.object({
  title: z.string().min(1),
  mode: z.enum(['narrator', 'dialogue']).default('narrator'),
  segments: z
    .array(
      z.object({
        /** Speaker label; `narrator` mode uses a single speaker throughout. */
        speaker: z.string().default('narrator'),
        text: z.string().min(1),
      }),
    )
    .min(1),
});
export type PodcastScript = z.infer<typeof PodcastScriptSchema>;

/**
 * A block-level rewrite proposal. The editor renders these as a diff and the
 * user accepts or rejects each one — the model never writes straight into a
 * note (PRD §4, principle 4).
 */
export const RewriteProposalSchema = z.object({
  blocks: z
    .array(
      z.object({
        /** Index into the note's top-level `doc.content`. */
        index: z.number().int().nonnegative(),
        action: z.enum(['replace', 'insert', 'remove']),
        node: DocNodeSchema.optional(),
        rationale: z.string().optional(),
      }),
    )
    .default([]),
});
export type RewriteProposal = z.infer<typeof RewriteProposalSchema>;

// ---------------------------------------------------------------------------
// AI wire shapes
//
// What a model is actually asked to emit, as opposed to what the app then
// works with. Models are reliable at Markdown and unreliable at ProseMirror
// JSON, so every one of these speaks Markdown and `src/lib/ai/` converts. The
// schemas above stay the app-facing contract; these are the trust boundary.
// ---------------------------------------------------------------------------

export const AiRewriteResponseSchema = z.object({
  blocks: z
    .array(
      z.object({
        /** Index into the numbered block list the prompt showed the model. */
        index: z.number().int().nonnegative(),
        action: z.enum(['replace', 'insert', 'remove']),
        /** Absent for `remove`; required for the other two, checked below. */
        markdown: z.string().optional(),
        rationale: z.string().max(400).optional(),
      }),
    )
    .superRefine((blocks, ctx) => {
      for (const [index, block] of blocks.entries()) {
        if (block.action !== 'remove' && !block.markdown?.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'markdown'],
            message: `"${block.action}" needs replacement text`,
          });
        }
      }
    })
    .default([]),
  /** One line the diff panel shows above the blocks. */
  summary: z.string().max(400).optional(),
});
export type AiRewriteResponse = z.infer<typeof AiRewriteResponseSchema>;

export const AiSynthesisResponseSchema = z.object({
  title: z.string().min(1).max(200),
  markdown: z.string().min(1),
});
export type AiSynthesisResponse = z.infer<typeof AiSynthesisResponseSchema>;
