# CLAUDE.md

Concise guidance for working in NotaBene.

## Product

NotaBene is a local-first, privacy-first note-taking app for students: rich
class notes, course organization, fast search, clean exports, and
bring-your-own-key AI. macOS desktop (Tauri), with a web-ready core.

Everything stays on the user's machine. No accounts, no cloud, no telemetry.

Source of truth (these live in `docs/`, which is gitignored — they are working
documents, not shipped artifacts):

- `docs/PRD-notabene-v0.1.md` — product spec.
- `docs/notabene-implementation-plan.md` — phased plan; keep status banners current.
- `docs/GeoCarto-design.md` — the Liquid Glass design system.

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
- MCP exposes no destructive tool. Agents archive; they do not delete.
- AI provider traffic goes through `src-tauri/src/ai.rs`, not the webview's
  `fetch`, so no provider host appears in `connect-src`. Prompts, parsing and
  provider definitions stay in `src/lib/ai/`; the transport only carries bytes.
  Anything a model returns is parsed through `src/lib/schema/` before it can
  reach a note, and AI writes go through `src/lib/commands/aiCommands.ts` with
  `source: 'ai'`.
- Prefer failing loudly over a silent fallback. Unimplemented Rust commands
  return a named "lands in phase X" error rather than empty data.

## Status

Phases A–G are code-complete: foundation, the TipTap authoring surface, course
organization/search, versions/backups/exports, the AI core, the local MCP
server, and the study features. E adds the
provider layer (Anthropic, OpenAI, Mistral, Gemini, OpenRouter, Ollama, LM
Studio, custom), Keychain key storage, rewrite-with-diff-gate, synthesis, and
an Ask panel for questions about a note. F adds the authenticated 11-tool MCP
surface, client setup, agent activity, versioned writes, and optimistic
concurrency protection. G adds mind maps (a real editor block that survives
every export), flashcards with Anki export, and note-to-podcast over macOS
system voices. Section 3 of the implementation plan tracks the remaining gaps
honestly — read it before assuming something works.

Phase G notes worth knowing before touching it:

- A mind map node carries both `data` (the tree) and `svg` (the render from
  `src/lib/mindmap/layout.ts`). The SVG is what HTML, PDF, DOCX and Markdown
  export draw, exactly as `drawing` works — never re-render at export time.
- Decks are not library entities and must not become them. They live in a note
  or in Anki, which is why G needed no `SCHEMA_VERSION` bump.
- TTS is `say(1)` behind `src-tauri/src/tts.rs`, writing 16-bit PCM at 22.05 kHz
  so `src/lib/podcast/wav.ts` can join segments by concatenating samples. Change
  one of those two and you must change the other.

## House rules

- Match surrounding style; keep comments purposeful — explain _why_, not _what_.
- Do not commit or push unless asked. Default branch: `main`.
- Keep changes scoped and update the phased plan when work changes status.
