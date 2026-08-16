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

Phases A–J are code-complete, apart from the explicitly deferred signing,
notarization, and signed-update work: foundation, the TipTap authoring surface, course
organization/search, versions/backups/exports, the AI core, the local MCP
server, the study features, bulk selection, and tasks. The MCP and in-app Agent
share 20 tools: the original surface plus tag discovery, native merging,
recoverable Trash/restore operations, and the five task tools. E adds the
provider layer (Anthropic, OpenAI, Mistral, Gemini, OpenRouter, Ollama, LM
Studio, custom), Keychain key storage, rewrite-with-diff-gate, synthesis, and
an Ask panel for questions about a note. F adds the authenticated MCP
surface, client setup, agent activity, versioned writes, and optimistic
concurrency protection. G adds mind maps (a real editor block that survives
every export), flashcards with Anki export, and note-to-podcast over macOS
system voices, onboarding, editable study artefacts, accessibility, performance
instrumentation, and release documentation. J adds tasks: a recurrence engine,
reminders that survive a quit, a Tasks view, tasks linked to notes both in the
inspector and inline, and saving a web page onto a note. `docs/plan.md` tracks
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

## House rules

- Match surrounding style; keep comments purposeful — explain _why_, not _what_.
- Do not commit or push unless asked. Default branch: `main`.
- Keep changes scoped and update the phased plan when work changes status.
