# Release notes

## NotaBene 0.8.0

- **Tasks and to-dos.** A Tasks view in the sidebar with deadlines, priorities,
  courses, one level of subtasks, and repeats for the weekly problem set.
  Completing a repeating task rolls it forward to its next occurrence rather
  than closing it. Tasks link to notes both ways, and a task can be mentioned
  inline in prose as a live chip that shows its current status.
- **Reminders.** A task can carry a reminder, delivered as a macOS
  notification. Reminders fire while NotaBene is open; any that come due while
  it is closed arrive, grouped, the next time it launches. There is no
  background service, and the setting says so.
- **Tasks through MCP and the in-app agent.** Five new tools, so an agent can
  see what is due, create assignments, tick them off and link them to notes.
  As with notes, an agent can fill recoverable Trash but cannot empty it.
- **Save a web page onto a note.** Paste a URL and NotaBene fetches the page
  once, keeps the readable article, and stores it as an attachment. It previews
  inside the app, opens in your browser, can be fetched again, and turns into a
  note the same way a PDF or a DOCX does. The page is contacted only when you
  ask; images are not saved with it.

This release updates the library schema from version 5 to 7 for tasks and
task reminders. Existing libraries are migrated automatically when they are
opened.

## NotaBene 0.7.5

- **Read and annotate PDFs without leaving NotaBene.** PDF attachments now open
  in a full-window reader with page navigation, zoom, text search, persistent
  highlights, and notes. A highlighted passage can be brought into the open
  note with its source and page number intact.
- **Find text inside document attachments.** DOCX, ODT, RTF, Markdown, and
  plain-text previews have an in-document search bar with match counts and
  next/previous navigation. Search highlights clear correctly in the macOS
  WebKit view when the query is erased or the search is closed.
- **Move the library safely.** Settings can show the current library location,
  verify a destination, and move the library without risking a partial copy.
  The storage layer also exposes read-only health information before a move is
  attempted.
- **The Agent can manage a larger part of the library.** It can discover tags,
  merge notes in an explicit order, move notes to recoverable Trash, and
  restore them. Permanent deletion remains unavailable.
- **Gemini's model catalogue is current**, including the latest Flash models.

This release updates the library schema from version 4 to 5 to store PDF
annotations on attachments. Existing libraries are migrated automatically when
they are opened.

## NotaBene 0.6.2

- **Cancel now stops the model, not just the waiting.** Pressing Cancel during
  a rewrite, a summary, a set of flashcards, a mind map or a podcast script
  used to leave the model running to the end — and a cancelled summary would
  still create its note when it got there. The request is now genuinely called
  off, on a local model as much as a hosted one, and the dialog comes back the
  moment you press the button rather than when the last token lands. A cancel
  is also no longer reported as an error, because it is not one.
- **Small local models are much better at the features that need a structured
  answer.** A seven-billion-parameter model on your Mac often thinks out loud
  before answering, wraps the answer in a code fence, or writes a note with
  real line breaks inside it — all of which used to end in "the model did not
  return JSON". NotaBene now reads past the thinking and the fence, repairs
  punctuation without ever touching a word of the content, and, if the answer
  is still unreadable, shows the model what it wrote and asks once more. A
  model that answers correctly the first time is never asked twice, and every
  answer is still validated before it can reach a note.
- **The export sheet closes once the file is written**, instead of staying open
  to say it is done.
- **The AI features work again on LM Studio.** Rewrite, synthesis, flashcards,
  mind maps and podcasts asked LM Studio for its JSON mode in the wording every
  other OpenAI-compatible server accepts, and recent LM Studio builds answer
  that with `'response_format.type' must be 'json_schema' or 'text'`. NotaBene
  no longer sends the field to LM Studio: the prompt already asks for a single
  JSON object, and the answer is validated before it can reach a note either
  way. Asking questions about a note was never affected, because it asks for
  prose.

Nothing here is persisted differently: no schema change, no `SCHEMA_VERSION`
bump.

## NotaBene 0.6.1

- **Select several notes at once.** Command-click adds a note to the selection,
  shift-click takes a run of them, Escape clears it. A bar above the list says
  how many are selected and what can be done to them: move them to a course,
  add a tag, merge them, and — behind the `⋯` — export, archive, or send them to
  the trash. Right-clicking inside a selection acts on all of it, and so does
  dragging it onto a course, a section, or the inbox. In the trash the bar
  offers one thing, which is putting them all back.
- **Merge notes into one.** File → Merge Notes (⌥⌘M) folds a selection into a
  single new note. The most recently edited one leads by default and the order
  can be rearranged before anything is written; each note keeps its title as a
  heading, with its own headings moved down a level so the result has an
  outline rather than a flat run of sections. The merged note inherits the
  course when every source agreed on one, and carries all their tags. The
  originals go to the trash, are archived, or are left alone — you choose each
  time, and the choice is remembered as the default for the next one.
- **The multi-note AI features work on the selection**, which is what they were
  always written for: synthesis, flashcards, and podcasts now read the whole
  set rather than one note. They stop at ten notes, and at a length limit
  besides, and say so before a request is sent rather than after.
- A selected note's highlight no longer touches the chrome above it.

Nothing here is persisted differently: no schema change, no `SCHEMA_VERSION`
bump.

## NotaBene 0.6.0

- **A document becomes a note, on your Mac.** File → Convert a document to note
  (⌘⇧O) reads a PDF, Word, PowerPoint, Excel, OpenDocument, EPUB, RTF, CSV,
  Markdown, or plain-text file and turns it into a real NotaBene note —
  headings, paragraphs, lists, and tables, in the editor, editable. Extraction
  runs entirely in the app's own process through a bundled converter: nothing is
  uploaded, and no key is needed. An attachment you already have can be
  converted in place, from the Attachments pane or from its preview window, and
  the original file can be kept attached to the note that came out of it.
- **Optional layout by a model, which cannot rewrite your handout.** A
  converted PDF often arrives as the right words with none of the shape. The
  import dialog offers a second pass — off by default, and a separate step
  because it is the one part that leaves the machine — that asks your
  configured provider to put headings, paragraphs, and lists back. The promise
  is that the _wording_ never changes, and the promise is enforced rather than
  requested: every proposed edit is measured against the block it claims to lay
  out, and one that drops a word, rewrites a sentence, or invents more than a
  heading's worth of text is discarded. The dialog reports how many edits were
  applied and how many were refused, and a note a model shaped is recorded with
  `source: 'ai'` like every other one. Settings → AI can point **Document
  layout** at a model of its own.
- **A scanned PDF says so.** A PDF with no text layer used to be a conversion
  that produced nothing; it now fails with an OCR message that explains why.
- **More files can be attached**, including `.doc`, `.ppt`/`.pptx`, `.xls`/`.xlsx`,
  `.ods`, `.odp`, `.epub`, and `.csv`. These are stored and convertible; the
  in-app preview still covers images, audio, video, PDF, DOCX, ODT, RTF,
  Markdown, and text, and the preview button is now shown only where a preview
  actually exists.
- **The attachment viewer says DOCX.** Its badge showed the raw MIME type,
  which spells `DOCX` in fifty more characters. It now shows the file's own
  kind, with the full type on hover.

Nothing here is persisted differently: no schema change, no `SCHEMA_VERSION`
bump.

## NotaBene 0.5.1

- Settings moved to a more findable place in the shell.
- A local model endpoint is asked what it is running, so the model's real name
  is shown instead of a generic label, and a local provider is labelled as
  local.
- Minor fixes.

## NotaBene 0.5.0

- **Concentration mode is a place to write.** The mode used to collapse three
  panes, ghost the toolbar, and leave both bars sitting where they were. Chrome
  now retreats and returns: the title bar and status bar leave their edges and
  come back when the pointer reaches for them, when something inside takes
  focus, or when a modal opens — keeping their space in the layout, so the page
  never jumps. Entering records the panes you had open and leaving puts them
  back, and toggling one in between peeks it rather than ending the mode.
- **Typewriter mechanics.** The line holding the caret can be pinned at a fixed
  height while you type — but never on a click — the blocks around it recede by
  colour, and an optional block cursor replaces the caret. An opt-in typewriter
  look gives the mode warm stock, softened ink, a narrower measure, looser
  leading, and a margin rule, in both themes, leaving your chosen typeface
  alone. Everything is governed by a `focus` settings group in Settings →
  Editor; the old persisted `focusMode` boolean that nothing read is migrated
  away.
- **Ranked search behind Ask.** The note list wants AND matching — another word
  narrows the results. A question wants the opposite: requiring every word of
  "vecteur direction rotation" finds nothing, when the note you meant says "un
  vecteur propre ne tourne pas". Retrieval now runs its own ranked query over
  FTS5 with `OR` between terms and a weighted `bm25` score, ordered by
  relevance alone, so a pinned but barely-matching note cannot crowd out the
  material that answers the question.
- **Ask, scoped.** The Ask panel answers over the current note, its course, or
  the whole library, and cites the notes it drew on. Both search paths build
  their SQL through one query builder, so a filter added for the note list is a
  filter retrieval gets too.

Concentration mode also fixes a pre-existing bug it made obvious: Chromium
matches `:focus-visible` on any editable element however focus arrived, so the
global focus ring outdrew the editor's own `outline: none` and framed the note
in 2px of accent for as long as the caret was in it.

Nothing here is persisted differently: no schema change, no `SCHEMA_VERSION`
bump.

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
