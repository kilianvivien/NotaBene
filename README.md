# NotaBene

**The class-notes app that respects your privacy and makes your notes work for you.**

NotaBene is a local-first, privacy-first note-taking app for students. It looks
and feels native on macOS, and gives you what class notes actually need: fast
rich-text editing with images, drawings, tables and maths; organization by
course and topic; search that keeps up with you; clean exports; and AI features
that turn raw lecture notes into study material.

Everything stays on your machine. No account, no cloud, no telemetry. AI is
**bring-your-own-key** — or fully local — never a bundled subscription.

> **Status: early development.** Phase A (foundation) is landing; the rich-text
> editor, search, exports, and AI features are in progress. Not yet usable as a
> daily driver.

## What it does

- **Typing-first editor** — headings, lists, tables, callouts, collapsible
  sections, code blocks, LaTeX maths, inline images, and re-editable Excalidraw
  drawings. Slash menu, Markdown shortcuts, full keyboard control.
- **Organized by course** — courses → sections → notes, plus typed tags
  (`topic:`, `prof:`, `semester:`, `exam:`, `type:`), smart folders, and
  `[[wiki links]]` with backlinks.
- **Search that keeps up** — SQLite FTS5 across titles, body, tags and course
  names, diacritics-insensitive (so `resume` finds `résumé`), with composable
  filters like `course:Analysis has:drawing after:2026-01-01`.
- **Never lose a keystroke** — continuous autosave, per-note version history,
  crash recovery, one-click local backups.
- **Exports that hold up** — Markdown, HTML, PDF and DOCX, for a single note or
  a whole course.
- **AI that earns its place** — rewrite and correct, synthesis, mind maps,
  flashcards (with Anki export), and note-to-podcast. Every AI action shows a
  preview before it touches a note.
- **Works with your coding agent** — an embedded local MCP server lets Claude
  Code and other MCP clients read, search, and write your notes. Loopback-only,
  token-authenticated, and it exposes no delete.

## Privacy

The only network calls NotaBene ever makes are the AI providers you configure
yourself, the update check, and optional model downloads — each clearly
surfaced. API keys live in the macOS Keychain and never appear in backups or
exports. There is no analytics of any kind.

## Development

Requires Node 20+, pnpm, and a Rust toolchain with Xcode command-line tools.

```bash
pnpm install
pnpm dev
```

`pnpm dev` runs the UI in a browser against an in-memory store — good for
working on layout and components, but notes do not survive a reload.

```bash
pnpm tauri:dev
```

runs the real desktop app with the SQLite store.

```bash
pnpm typecheck && pnpm lint && pnpm test
cd src-tauri && cargo check
```

See `CLAUDE.md` for the architecture rules that matter most.

## License

Apache 2.0. See [LICENSE](LICENSE).
