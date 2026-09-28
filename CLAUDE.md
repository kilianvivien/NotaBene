# CLAUDE.md

Concise guidance for working in NotaBene.

## Product

NotaBene is a local-first, privacy-first note-taking app for students: rich
class notes, course organization, fast search, clean exports, and
bring-your-own-key AI. macOS desktop (Tauri), with a web-ready core.

Everything stays on the user's machine. No accounts, no cloud, no telemetry.

**Scope test, decided 2026-08-09: students first, researchers second.** The
undergraduate in a lecture is still the primary user and keeps a veto — nothing
for the researcher may make the class-notes path slower or harder to learn —
but "a grad student would use this and an undergraduate would not" is no longer
a reason to reject a feature. macOS only: no mobile, no web as a product. See
`docs/plan.md` §1, which also lists what that direction explicitly rules out.

Source of truth (these live in `docs/`, which is gitignored — they are working
documents, not shipped artifacts):

- `docs/PRD-notabene-v0.1.md` — product spec. Written for the student-only
  scope; §1 of the plan is what supersedes it on direction.
- `docs/plan.md` — the current plan: what is done, what is open, and what is
  settled. Keep it current; edit an item rather than starting a new document.
- `docs/GeoCarto-design.md` — the Liquid Glass design system.
- `docs/archive/` — superseded planning documents, with a README explaining what
  each one was and which parts of it survived into `plan.md`. The phased
  implementation plan lives there now; phases A–I are all complete.

## Commands

```bash
pnpm dev         # Vite dev server, port 5173 (in-memory store)
pnpm tauri:dev   # full desktop app with SQLite
pnpm build       # typecheck + production build
pnpm typecheck   # TypeScript only
pnpm test        # Vitest
pnpm lint        # ESLint
pnpm format      # Prettier write
```

Run `pnpm typecheck && pnpm lint && pnpm test` before committing, plus
`cargo check` in `src-tauri/` when Rust changed.

## Stack

React 19, TypeScript (strict), Vite, Tailwind v4, Zustand + immer, Zod,
TipTap/ProseMirror, Excalidraw, react-i18next, lucide-react. Tauri 2 shell with
rusqlite + FTS5, and an embedded rmcp/axum MCP server. Package manager: pnpm.

## Architecture

Four rules carry most of the weight:

1. **`src/lib/commands/` is the only mutation path.** The editor, the AI panel,
   and the MCP server all call the same command functions. Never call
   `library.upsertNote` from a component or an MCP handler.
2. **`src/lib/adapters/` is the platform boundary.** No file outside it may
   import `@tauri-apps/*`. `adapters/index.ts` picks implementations by runtime;
   a future web build changes that one file.
3. **`src/lib/schema/` is the contract.** Anything crossing a trust boundary — a
   backup, an MCP payload, an LLM's JSON — is parsed through it first. Its Rust
   counterparts are `src-tauri/src/db/model.rs` and `db/schema.sql`; **all three
   move together**, in the same commit, with a `SCHEMA_VERSION` bump.
4. **MCP writes travel Rust → webview → command layer.** The Rust server is an
   authenticated gateway only. That is what makes an agent edit get the same
   validation, autosave, and version history as a keystroke.

## Conventions

- Build UI from `src/components/glass/` and the tokens in
  `src/styles/tokens.css`. Support light and dark themes plus the selectable
  accent palette. NotaBene uses opaque, readable surfaces; do not imitate
  transparency with coloured gradients. Token prefix is `--nb-`.
- The shell fills the window edge to edge — the OS draws the frame. Do not
  reintroduce an inset, rounded "window" panel.
- Split state in `src/lib/state/`: `uiStore` (chrome), `libraryStore` (read
  cache), `editorStore` (open note + autosave), `settingsStore`.
  `libraryStore` is a cache of reads, never a source of truth; after any write,
  call `refreshCurrentView()`.
- AI dialogs ask their question with `ChoiceGroup` (cards that each say what
  they do) rather than segmented controls or dropdowns, and show the sources
  with `Sources`. Check & correct and Visualize are the reference.
- Put every user-facing string in both `src/locales/en` and `src/locales/fr`,
  including error messages.
- Shell layout lives in `src/app/shell/`; the view → query mapping is
  `viewQuery.ts`, shared with export selection and the MCP search tool.
- Menu items, shortcuts, and chrome buttons all resolve to one id in
  `src/lib/commands/appCommands.ts`. The native menu bar is _generated_ from
  that table (`src/app/menuBar.ts` → `MenuAdapter` → Rust), so a new command is
  added there and nowhere else. Commands from later phases belong in the table
  too, with their `landsIn` phase — they render disabled.
- Backups and exports must never contain secrets. `LibrarySchema` has no field
  a key could occupy — keep it that way. Keys go through `SecretsAdapter`.
- MCP exposes no permanent deletion. Agents may archive or use recoverable
  Trash, but they cannot empty or purge it, delete library containers, or
  bypass optimistic concurrency checks.
- AI provider traffic goes through `src-tauri/src/ai.rs`, not the webview's
  `fetch`, so no provider host appears in `connect-src`. Prompts, parsing and
  provider definitions stay in `src/lib/ai/`; the transport only carries bytes.
  Anything a model returns is parsed through `src/lib/schema/` before it can
  reach a note, and AI writes go through `src/lib/commands/aiCommands.ts` with
  `source: 'ai'`.
- Prefer failing loudly over a silent fallback. Unimplemented Rust commands
  return a named "lands in phase X" error rather than empty data.

## Status

Phases A–L are code-complete, apart from the explicitly deferred signing,
notarization, and signed-update work: foundation, the TipTap authoring surface, course
organization/search, versions/backups/exports, the AI core, the local MCP
server, the study features, bulk selection, and tasks. The MCP and in-app Agent
share 29 tools (the in-app agent adds two pseudo-tools of its own, `finish` and
`ask_student`, which are loop control rather than capabilities): the original surface plus tag discovery, native merging,
recoverable Trash/restore operations, bulk archiving, the five task tools, and
the eight of the agent's tier 2 (attachments and highlights, versions, and the
study features as tools).
The tools that act on many notes take a `notes: [{ noteId, baseUpdatedAt }]`
list — `manage_tags` accepts both that and the original single-note form.
E adds the provider layer (Anthropic, OpenAI, Mistral, Gemini, OpenRouter,
Ollama, LM Studio, custom), Keychain key storage, rewrite-with-diff-gate,
synthesis, and an Ask panel for questions about a note. F adds the authenticated MCP
surface, client setup, agent activity, versioned writes, and optimistic
concurrency protection. G adds mind maps (a real editor block that survives
every export), flashcards with Anki export, and note-to-podcast over macOS
system voices, onboarding, editable study artefacts, accessibility, performance
instrumentation, and release documentation. J adds tasks: a recurrence engine,
reminders that survive a quit, a Tasks view, tasks linked to notes both in the
inspector and inline, and saving a web page onto a note. K (1.1.0) adds word
completion from a per-course vocabulary, curated course terms, an AI
vocabulary review, and an on-demand paragraph check. L (1.2.0, importers and
calendars) adds importing a Markdown folder, an Obsidian vault or a Notion
export, with a preview, folder-to-course mapping, idempotent re-import and
provenance, and tasks to and from `.ics` calendars. M (1.3, in progress) adds
lecture recording anchored to the blocks typed during it. `docs/plan.md` tracks
what is still open honestly — read it before assuming something works.

Phase G notes worth knowing before touching it:

- A mind map node carries both `data` (the tree) and `svg` (the render from
  `src/lib/mindmap/layout.ts`). The SVG is what HTML, PDF, DOCX and Markdown
  export draw, exactly as `drawing` works — never re-render at export time.
  Reading one happens in `src/app/mindmap/MindMapViewer.tsx`, which portals to
  `document.body`: a `position: fixed` overlay rendered inside a ProseMirror
  node view is laid out against the editor's scroll container, not the window.
- Decks are not library entities and must not become them. They live in a note
  or in Anki, which is why G needed no `SCHEMA_VERSION` bump.
- A flashcard's `back` may be empty, and only for a cloze card — it is Anki's
  _Extra_ field, not the answer. `answerable()` in `src/lib/schema/` is the
  check that matters; requiring `back` rejected whole decks.
- TTS is `say(1)` behind `src-tauri/src/tts.rs`, writing 16-bit PCM at 22.05 kHz
  so `src/lib/podcast/wav.ts` can join segments by concatenating samples. Change
  one of those two and you must change the other. Every command in that file is
  `async` over `spawn_blocking` — a synchronous Tauri command runs on the main
  thread, and `say` on a paragraph freezes the window if it does.
- Tags are stored as `namespace:name` because that is what makes them
  facetable, and displayed through `tagLabel()` because `type:summary` is not a
  label. Query with `tagQuery()`, show with `tagLabel()`.

Phase I notes worth knowing before touching it:

- `uiStore.multiSelection` is authoritative whenever it is non-empty, and
  `selectedNoteId` then means only "the note the editor is showing" — the two
  can disagree, because the open note can be command-clicked out of a
  selection. A selection of one collapses to empty, which every consumer reads
  as "no bulk selection, fall back to `selectedNoteId`".
- Anything acting on one row that could mean the whole selection goes through
  `selectionFor(noteId)` — the note-list context menu and every sidebar drop
  target do. Do not read `multiSelection` directly at those call sites.
- Bulk writes call `applyNoteUpdate` (the refresh-free half of
  `updateNoteCommand`) and refresh the read caches **once**, at the end.
  Looping the public command re-runs the note list's query per note.
- Merge honours `input.noteIds` as the running order — the dialog seeds it from
  `mergeOrder()` and the student rearranges it, so re-sorting inside the
  command would discard what they arranged. Merge is shared with MCP and the
  in-app Agent; sources may be kept, archived, or moved to recoverable Trash,
  but never permanently deleted.
- `MAX_AI_SOURCES` caps synthesis, flashcards and podcast together. The count
  is refused in the dialog; the token budget comes back as `details.limit` so
  the message is translated at the surface rather than carried from the
  command layer in English.

Phase J notes worth knowing before touching it:

- Tasks _are_ library entities, unlike decks: they took `SCHEMA_VERSION` from 5
  to 7, with `V6` and `V7` in `src-tauri/src/db/migrations.rs` and a table in
  `db/tasks.rs`. All three legs of rule 3 moved together — keep it that way.
- Reminders are a thirty-second poll in `src/lib/tasks/reminderScheduler.ts`,
  not a `setTimeout` ladder: a timer does not survive the laptop sleeping
  between an evening reminder and the morning it is due. The first sweep after
  launch is also the catch-up, delivering everything already past as one
  grouped notification, and `remindedAt` is what makes each fire exactly once
  across a relaunch. Nothing runs while the app is closed, by decision.
- Exactly one occurrence of a recurring task exists at a time — completing it
  rolls the due date forward instead of closing it, which is what stops "every
  Tuesday" from materialising a hundred rows. The arithmetic in
  `src/lib/tasks/recurrence.ts` runs in local time on purpose: doing it in UTC
  moves an 08:00 task by an hour for half the year.
- Trashing a task takes its subtasks with it and restoring lifts them back.
  As everywhere else, MCP gets `trashed: true/false` and no permanent delete.
- Fetching a web page goes through `src-tauri/src/web.rs`, never the webview,
  and that is a security boundary rather than a transport preference: it
  refuses non-HTTP schemes, loopback, the private ranges, link-local and
  carrier-grade NAT, after resolution rather than before. `http://localhost:22600`
  is NotaBene's own MCP server, and a pasted link must not be able to drive it.

Phase K notes worth knowing before touching it:

- Only the curated half of a course's vocabulary is library data
  (`course_terms`, schema v8). What completion offers beyond it is harvested
  from the notes on demand in `src/lib/vocabulary/` and never stored — the
  same reason the search index is not in a backup. `rejected` terms are what
  keep a recurring typo from being harvested and offered back.
- `src/lib/vocabulary/text.ts` folds per code point and deliberately differs
  from `src/lib/search/fold.ts`. The completer cuts ghost text off a term by
  position, so a folded prefix must be exactly as long as what was typed, and
  the suggestion keeps the accents that search folding throws away.
- `WordCompletion` computes its suggestion inside the keystroke's own
  transaction (the editor re-renders on every transaction), shows one only
  after plain typed text, claims Tab only while a suggestion is visible (lists
  and tables indent on Tab), and stands aside during composition — macOS
  composes accents. `WordCompletion.test.ts` holds those lines.
- The harvest runs in slices of under a frame (`cache.ts`), never on a
  keystroke; the keystroke path is a binary search.
- Completion draws on three sources, merged in `rankCompletions`: the course
  index (cache), an index of the open note rebuilt in the plugin's `view`
  after a typing pause, and learned boosts from `learned.ts` (`localStorage`,
  never library data). `presence.ts` turns the Settings choice into every
  threshold at once; `configureVocabulary` invalidates the cache on change.
- Proofreading is a read like Define: corrections go back to the editor,
  which applies them as one transaction and refuses if the paragraph changed
  since it was sent.

Phase L notes worth knowing before touching it:

- Schema v9 added `notes.import_key` (`{source}:{key}` — a path for a folder,
  Notion's page id), `notes.imported_at`, and `tasks.import_key` for the
  coming `.ics` import. `createdAt` keeps the *source file's* date;
  `importedAt` is when NotaBene wrote it, and `updatedAt > importedAt` is how
  a re-import knows a note was edited here since.
- `src-tauri/src/folder_import.rs` is a security boundary like `web.rs`: it
  reads outside the `fs` scope, so it only reads under a root that
  `folder_import_pick` (the native panel, opened from Rust) recorded. Never
  add a command that takes a root from the webview.
- Readers (`src/lib/import/sources/`) write nothing and know nothing about
  courses. `plan.ts` is pure and decides everything — re-import matching,
  unique titles (shallowest path keeps the title), and **pre-minted ids**, so
  an in-batch link carries its target's id before either note exists.
  `applySourceImportCommand` only executes the plan.
- Foreign Markdown is parsed with `markdownToDoc(md, { wikiLinks: 'obsidian',
  resolveWikiLink })`; the default dialect stays NotaBene's `[[Title|id]]`.
  An alias is the node's `label` attr — presentation only; Markdown export
  drops it (`docs/export-fidelity.md`).
- `createNotesCommand` takes `BatchNoteInput` (id, importKey, importedAt,
  source dates). Keep those fields off `CreateNoteInput`, which MCP reaches.
- Clicking a `[[Title]]` with no id resolves by title first
  (`resolveWikiTitleCommand`) and only creates a note when none exists.
- The agent speaks native function calling where the provider table says
  `nativeTools`, and the JSON decision document elsewhere. Tool definitions
  are generated from `TOOL_ARGUMENT_SCHEMAS` in `lib/mcp/toolHandlers.ts` via
  `lib/mcp/jsonSchema.ts` — a new tool gets its definition by being in that
  table, never by a hand-written schema. Turns stay stateless (the compacted
  transcript as prose), reads in one turn run in parallel, writes in order.
  Measure a loop change with `pnpm eval:agent` before claiming it helped.
- Calendars (`src/lib/export/ics.ts`, `src/lib/import/ics.ts`) write `VEVENT`s
  in floating local time with `UID:task-{id}@notabene`; local midnight means
  all-day. Import is strict and bounded, maps only rules that fit the three
  presets (the rest import as one date, flagged), and keys tasks by
  `ics:{UID}`. Neither is reachable over MCP.
- A first run on an empty library shows `WelcomeScreen`: a feature tour
  plus import, the sample course (`runOnboardingCommand`), or empty. Help
  reopens it (`help.welcome`) with only the import.
  `firstRunPendingCommand` closes the first run quietly over a library that
  already holds anything. The e2e specs answer it through `e2e/app.ts`.
- `Recurrence.monthDay` is the anchor day of a monthly rule. The command
  layer sets it (`anchorRecurrence`) when a rule or due date is written and
  never on a rollover — that is what keeps the 31st from drifting to the 28th.

Agent tier 2 notes (1.3, plan §3.2 items 5–9) worth knowing before touching it:

- The study-feature tools (`generate_flashcards`, `synthesize_notes`,
  `visualize_note`, `define`) call the same commands as the dialogs, passing
  the *tool's* `CommandContext` through (`StudyWrite` in `studyCommands.ts`),
  so a write carries the run id and whole-run undo finds it. Their model cost
  reaches the run through `context.onModelUsage`, and `modelCallFits` refuses
  one that would not fit the ceiling *before* paying for it. Over MCP they
  need write access, because they spend the student's key.
- A run whose plan uses `organize`, `manage_tags`, `archive_notes` or
  `trash_notes` stages those writes in `run.changeset` (`agentChangeset.ts`)
  instead of making them. Ten notes or fewer apply as the run finishes; more,
  or an unfinished run, wait for Apply/Cancel in the panel. Applying goes
  through the same executor and journal, skips a note changed outside the run
  (`noteVersions` holds the run's own later versions), and re-checks scope.
  Section creation and tag renames are never staged — later calls need them.
- Near the provider's input limit the loop condenses its transcript into an
  `AgentProgress` summary (model-written, mechanical fallback) and continues;
  the ceilings still bound the run.

Lecture audio notes (phase M, plan §10.0) worth knowing before touching it:

- Capture is `MediaRecorder` in the webview behind `RecorderAdapter`
  (`src/lib/adapters/recorder/`); the file is Rust's. `recording.rs` appends
  each four-second slice in order and flushes it before answering, into
  `recordings/` under app data, and finishing copies it into the asset store
  without the bytes crossing IPC again. Whatever is left there at launch is
  offered back by `RecoveryPrompt`; nothing ever resumes the microphone.
- A kept recording is an ordinary attachment whose id is the recording id —
  minted before capture. Anchors carry that id, which is the whole link; no
  schema bump, and a new recording is always a new attachment.
- `audioAnchor` is a global attribute on paragraphs and headings
  (`LectureAnchors.ts`), set once when a block goes from empty to typed, only
  in the note the recording started in, never on paste or a large insertion,
  and not inherited on Enter. The extension is in every editor: without the
  attribute in the schema an editor would drop anchors on save. Exports ignore
  it.
- How the microphone is read lives in `settings.recording` (Settings →
  Recording): device, a gain stage behind a limiter in the capture graph
  (default ×2), automatic level, noise reduction. Transcription is planned
  for 1.3.5 (§10.3) and gets its section in that pane, not a new one. Never
  call CrispASR's `set_punc_model`: it downloads a model on first use.
- Markers are drawn only for recordings the player found on the open note
  (`lecturePlaybackStore`), which loads audio on first play, not on open.

## House rules

- Match surrounding style; keep comments purposeful — explain _why_, not _what_.
- Do not commit or push unless asked. Default branch: `main`.
- Keep changes scoped and update the phased plan when work changes status.
