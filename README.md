<p align="center">
  <img src="./assets/branding/notabene-icon-master.png" alt="NotaBene app icon" width="128" height="128">
</p>

<h1 align="center">NotaBene</h1>

<p align="center">
  <strong>Your notes. Your Mac. Your intelligence.</strong>
</p>

<p align="center">
  A local-first class-notes app for writing, organizing, understanding, and
  revising—without giving up ownership of your work.
</p>

<p align="center">
  <img alt="Platform: macOS 13+" src="https://img.shields.io/badge/macOS-13%2B-111827?style=flat-square&logo=apple&logoColor=white">
  <img alt="Built with Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white">
  <img alt="Status: early development" src="https://img.shields.io/badge/status-early_development-F59E0B?style=flat-square">
  <a href="./LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-3B82F6?style=flat-square"></a>
</p>

![NotaBene 0.2 showing the localized starter course, rich editor, and three-pane library](./assets/screenshots/notabene-0.2.png)

> [!IMPORTANT]
> NotaBene 1.0 is feature-complete, but the current build is not yet a trusted
> public download: Developer ID notarization and signed auto-updates are
> intentionally deferred.

## Why NotaBene?

Most note apps make you choose between a capable editor, useful study tools,
and control over your own data. NotaBene is being built so you do not have to.

- **Local by default.** Notes, attachments, versions, and settings stay on your
  Mac in a local SQLite library.
- **Made for classes.** Courses, sections, typed tags, backlinks, maths,
  drawings, and fast full-text search are first-class features.
- **AI on your terms.** Bring your own API key, connect a local model, or use no
  AI at all. Suggested edits always pass through a preview.
- **No account required.** There is no NotaBene cloud, analytics pipeline, or
  subscription standing between you and your notes.

## Highlights

| Write                               | Organize                             | Study                             | Own                          |
| ----------------------------------- | ------------------------------------ | --------------------------------- | ---------------------------- |
| Rich-text and Markdown shortcuts    | Courses, sections, and smart folders | AI synthesis and Q&A              | Local SQLite + FTS5          |
| Tables, callouts, toggles, and code | Typed, facetable tags                | Mind maps and flashcards          | Continuous autosave          |
| LaTeX maths and inline images       | `[[wiki links]]` and backlinks       | Anki deck export                  | Version history and recovery |
| Re-editable Excalidraw drawings     | Command palette and quick notes      | Note-to-podcast with macOS voices | Backups and portable exports |

### A serious authoring surface

NotaBene uses TipTap and ProseMirror to provide a responsive, keyboard-friendly
editor with headings, lists, tasks, highlights, links, code blocks, tables,
collapsible sections, callouts, LaTeX maths, images, and drawings. A slash menu,
formatting toolbar, find and replace, and native shortcuts keep common actions
close at hand.

### Organization that matches a semester

Build a library from **courses → sections → notes**, then cut across that
hierarchy with namespaced tags such as `topic:`, `prof:`, `semester:`, `exam:`,
and `type:`. Templates make recurring note formats quick to start, while wiki
links and backlinks connect ideas across classes.

### Search that keeps up

SQLite FTS5 searches titles, note bodies, tags, and course names. Search is
diacritics-insensitive—`resume` can find `résumé`—and accepts composable filters:

```text
course:Analysis has:drawing after:2026-01-01
exam:midterm is:pinned
```

### Study tools built from your notes

With a provider configured, NotaBene can:

- rewrite or correct a selection with a before/after diff;
- synthesize one or more notes into structured material;
- answer questions about the open note;
- generate a visual mind map;
- create basic and cloze flashcards, then export them to Anki; and
- turn a note into a locally rendered podcast using macOS system voices.

Supported AI connections include Anthropic, OpenAI, Mistral, Gemini,
OpenRouter, Ollama, LM Studio, and custom OpenAI-compatible endpoints. API keys
are stored in the macOS Keychain, not in the note database.

### Exports that leave with you

Export a note, course, folder, or selection as:

- Markdown
- HTML
- PDF
- DOCX
- Anki decks for generated flashcards

Drawings and mind maps are preserved in document exports, and secrets are never
included in an export or backup.

### Agent-ready, without opening your library to the network

NotaBene includes an authenticated local
[Model Context Protocol](https://modelcontextprotocol.io/) server. Compatible
clients can search, read, create, update, move, organize, and archive notes
through the same validated command layer used by the app.

The server binds to loopback only, requires a token, records agent activity,
uses optimistic concurrency protection, and deliberately exposes no permanent
delete operation.

## Privacy model

NotaBene has no accounts, cloud sync, telemetry, advertising, or analytics.
Normal note-taking does not require an internet connection.

Network access is limited to services that are visible and initiated by you:

1. the AI provider or local-model endpoint you configure; and
2. the application update check.

AI output is treated as untrusted input: structured responses are validated,
and edits are previewed before they enter a note. API keys live in the macOS
Keychain and cannot be represented in the backup schema.

## Current status

The product foundation and phases A–H are code-complete, except for the
explicitly deferred signing and signed-update work:

- native shell and local persistence;
- rich authoring;
- course organization and full-text search;
- versions, recovery, backups, and exports;
- bring-your-own-key and local-model AI;
- the authenticated MCP integration; and
- editable mind maps with image/outline export, flashcard review, and MP3
  note-to-podcast attachments;
- first-run guidance, EN/FR coverage, keyboard accessibility, and local
  performance instrumentation.

See [release notes](./RELEASE_NOTES.md), the [security policy](./SECURITY.md),
and [third-party notices](./THIRD_PARTY_NOTICES.md).

## Getting started

NotaBene currently targets **macOS 13 Ventura or newer**.

### Prerequisites

- [Node.js](https://nodejs.org/) 20 or newer
- [pnpm](https://pnpm.io/)
- A stable [Rust toolchain](https://rustup.rs/)
- Xcode Command Line Tools

```bash
xcode-select --install
corepack enable
pnpm install
```

### Run the web UI

```bash
pnpm dev
```

This starts Vite on `http://localhost:5173` with an in-memory adapter. It is
useful for frontend work, but notes do not survive a reload.

### Run the desktop app

```bash
pnpm tauri:dev
```

This launches the complete Tauri app backed by the local SQLite store.

### Build a macOS bundle

```bash
pnpm tauri:build
```

The generated `.app` and `.dmg` artifacts are written under
`src-tauri/target/release/bundle/`.

## Development

### Quality checks

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

When Rust code changes:

```bash
cd src-tauri
cargo check
```

Additional commands:

| Command             | Purpose                                 |
| ------------------- | --------------------------------------- |
| `pnpm test:watch`   | Run Vitest in watch mode                |
| `pnpm e2e`          | Run the Playwright end-to-end suite     |
| `pnpm format:check` | Check formatting without changing files |
| `pnpm format`       | Format the repository with Prettier     |
| `pnpm preview`      | Preview the production web build        |

### Architecture at a glance

```mermaid
flowchart LR
    UI["React UI<br/>Editor · AI · MCP bridge"] --> CMD["Shared command layer<br/>validation · history · autosave"]
    CMD --> ADAPTERS["Platform adapters"]
    ADAPTERS --> MEMORY["In-memory store<br/>browser development"]
    ADAPTERS --> TAURI["Tauri IPC"]
    TAURI --> DB["SQLite + FTS5"]
    TAURI --> OS["Keychain · files · TTS"]
    MCP["Authenticated local MCP client"] --> GATEWAY["Rust MCP gateway"]
    GATEWAY --> CMD
```

Four boundaries keep the application predictable:

1. `src/lib/commands/` is the only mutation path.
2. `src/lib/adapters/` isolates browser and Tauri implementations.
3. `src/lib/schema/` validates everything crossing a trust boundary.
4. MCP writes return through the webview and shared command layer, so an
   agent-authored edit receives the same validation and history as a keystroke.

The frontend is built with React 19, TypeScript, Vite, Tailwind CSS, Zustand,
Zod, TipTap, and Excalidraw. The native shell uses Tauri 2 and Rust with
`rusqlite`, FTS5, `rmcp`, and `axum`.

### Repository map

```text
src/
├── app/                 Application shell, dialogs, settings, and feature UI
├── components/glass/    Reusable interface primitives
├── editor/              TipTap editor, extensions, and Markdown conversion
├── lib/
│   ├── adapters/        Browser/Tauri platform boundary
│   ├── ai/              Providers, prompts, parsing, and AI workflows
│   ├── commands/        The shared mutation and application-command layer
│   ├── export/          Markdown, HTML, PDF, DOCX, and Anki export
│   ├── schema/          Runtime contracts and migrations
│   └── state/           Focused Zustand stores
└── locales/             English and French translations

src-tauri/
└── src/
    ├── db/              SQLite schema, migrations, and repositories
    ├── mcp/             Authenticated local MCP server
    ├── ai.rs            Native AI transport
    └── tts.rs           macOS speech rendering
```

Read [CLAUDE.md](./CLAUDE.md) before making code changes. It is the source of
truth for architecture rules, conventions, and verification expectations.

## Contributing

Issues, focused pull requests, and thoughtful product feedback are welcome
while NotaBene takes shape. Please:

1. open an issue before beginning a large or architectural change;
2. keep user-facing text available in both English and French;
3. add or update tests for changed behavior; and
4. run the relevant quality checks before submitting a pull request.

Please do not include real notes, API keys, databases, or other personal data
in bug reports and test fixtures.

## License

NotaBene is available under the [Apache License 2.0](./LICENSE).
