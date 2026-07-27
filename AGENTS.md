# AGENTS.md

See [CLAUDE.md](CLAUDE.md) — it is the single guide for coding agents working in
this repository, and covers the commands, the architecture rules, and the
conventions worth knowing before touching anything.

When browser-based UI inspection or end-to-end verification is needed, prefer
the bundled Browser plugin over Playwright CLI.

## App launch and UI verification

- For development and UI verification, use the app window already launched by
  `pnpm tauri:dev`. It has HMR, reflects the current workspace, and its process
  name is lowercase `notabene`.
- Production builds are named `NotaBene` (capital N and B). Treat that casing
  difference as significant: `notabene` means the Tauri dev process;
  `NotaBene` means a production app bundle.
- Never ask desktop automation to open or resolve `NotaBene` by app name or by
  the shared `app.notabene.desktop` bundle identifier. That can silently launch
  the stale `/Applications/NotaBene.app` instead of attaching to the Tauri dev
  window.
- Do not launch `/Applications/NotaBene.app` to verify workspace changes unless
  a fresh production build has first completed successfully and the resulting
  `.app` has been copied to `/Applications/NotaBene.app`.
- Starting another `pnpm tauri:dev` process is not a substitute for attaching
  to the dev window that is already open. Check the existing task/terminal
  before starting or stopping a dev server.
