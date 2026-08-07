# AGENTS.md

See [CLAUDE.md](CLAUDE.md) — it is the single guide for coding agents working in
this repository, and covers the commands, the architecture rules, and the
conventions worth knowing before touching anything.

When browser-based UI inspection or end-to-end verification is needed, prefer
the bundled Browser plugin over Playwright CLI.

## App launch and UI verification

- Do not use Computer Use or other desktop automation to inspect the NotaBene
  app. If visual UI inspection is useful, run the web app and use the bundled
  Browser plugin, even though it does not reproduce the exact Tauri shell.
  Leave Tauri-specific UI verification to the user; agents should otherwise
  verify app changes with builds, checks, and automated tests.
- The app window the user uses for development and UI verification is already
  launched by `pnpm tauri:dev`. It has HMR, reflects the current workspace, and
  its process name is lowercase `notabene`.
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
