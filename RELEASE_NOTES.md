# Release notes

## NotaBene 0.4.0

- **Neural voices that never leave the Mac.** Settings → Speech now offers two
  optional on-device models beside the macOS system voices and the hosted
  Voxtral and Gemini engines. **Kokoro 82M Q8_0** is a 153 MB download with one
  English and one French voice, quick enough for everyday read-aloud;
  **Voxtral 4B Q4_K** is a 2.35 GB download with seven preset English and
  French voices and noticeably better prosody. Both run on Apple Silicon
  through a native runtime bundled with the app, so the text being spoken never
  leaves the machine — read aloud and spoken episodes get neural quality with
  no API key and nothing uploaded.
- **Model downloads you stay in control of.** Each model is fetched from a
  pinned Hugging Face revision, verified against a recorded SHA-256, and
  installed only after you accept its licence — Apache 2.0 for Kokoro,
  CC BY-NC 4.0 and non-commercial use for Voxtral. A download can be cancelled
  and started again later, and an installed model can be tested, unloaded from
  memory, or removed from disk.
- **Numbers are spoken, not skipped.** The grapheme-to-phoneme data Kokoro
  ships with contains no digits, so a number used to fall out of the sentence
  silently. Numbers, decimals, and temperatures are now expanded to words in
  English and French before they reach the model.
- **Search finds commands too.** The title-bar field searches commands beside
  notes, with arrow-key selection and each command's shortcut shown. It runs
  the same search ⌘K does, so the two entry points cannot drift apart.
- **NotaBene on GitHub** joins the Help menu (⌘⌥G), and external links open in
  your browser rather than failing quietly.

Voxtral synthesis was also made durable on real notes: long text is split into
chunks the model can finish, a truncated or silent chunk is regenerated instead
of shipped, and generation limits stop a runaway decode from hanging an
episode.

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
