# Release notes

## NotaBene 0.3.2

- **Abbreviations.** Settings → Abbreviations holds your own typing shortcuts:
  type `tvi`, finish the word, and the note reads "théorème des valeurs
  intermédiaires". A shortcut only expands at the end of a word and never
  inside code, a lower-case one also matches its capitalised spelling, and the
  words it wrote are briefly tinted so an expansion never reads as a typo.

Editor fixes:

- **Equations work again.** Inserting one did nothing on the desktop build:
  the prompt it asked for is a no-op in the macOS web view. Equations are now
  entered in a proper dialog with a live preview, and the same dialog opens on
  a double-click to edit one. Links, which asked the same way, are fixed with
  it.
- Equations no longer render doubled in HTML exports.
- Dead-key accents work in image captions — typing `^` then `e` gives `ê`
  rather than `^e`.
- The drawing window no longer opens over the traffic lights.

## NotaBene 0.3.1

Fixes for the features 0.3.0 shipped in a rough state, plus a third speech
engine:

- Gemini neural voices as a selectable TTS engine, alongside macOS system
  voices and hosted Voxtral;
- reliable spoken-episode generation and in-app playback;
- attachment previews with zoom, and document attachments — PDF, DOCX, ODT,
  RTF, Markdown, and plain text — opening in the app instead of an external
  viewer.

## NotaBene 0.3.0

- **Ask answers from a chosen source.** The Ask panel is reworked around two
  modes: **Note only**, which answers strictly from the open note, and
  **Note + AI**, which may add clearly labelled outside knowledge.
- **A simpler speech story.** The on-device Voxtral engine is gone; the hosted
  Voxtral API remains, so no model download stands between you and a spoken
  note. A failed download can no longer leave the installer stuck.
- Interface and workflow refinements across the shell, and a Web Crypto digest
  fix that makes the browser and Tauri adapters agree.

## NotaBene 0.2.0

NotaBene 0.2 completes the local-first class-note workflow: rich authoring,
courses and search, version history and recovery, portable exports, optional
bring-your-own-provider AI, authenticated local MCP access, and study tools.

Release polish adds:

- a localized starter course on first run;
- an editable mind-map tree with collapsible/reorderable branches, PNG and
  Markdown-outline exports, and “save as note”;
- an in-app flashcard review mode;
- MP3 podcast export and note attachment;
- a command palette and anchored editor controls;
- keyboard focus containment, reduced-motion/transparency handling, and EN/FR
  locale-parity checks;
- release performance instrumentation and a documented security review.

## Known limitation, all releases

Developer ID signing/notarization and signed auto-updates are deferred. The
published DMG is ad-hoc signed only, so macOS Gatekeeper may warn or block it.
Do not distribute it as a trusted public release.
