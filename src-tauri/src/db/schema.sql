-- NotaBene schema v1.
--
-- Mirrors src/lib/schema/schema.ts; the two must move together. Notes keep
-- their document as JSON (the editor owns that shape) while every field the app
-- filters or sorts on is a real column, so the query planner can use an index
-- instead of parsing JSON per row.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS courses (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    color       TEXT NOT NULL,
    icon        TEXT NOT NULL DEFAULT '📘',
    professor   TEXT,
    semester    TEXT,
    credits     INTEGER,
    schedule    TEXT,
    "order"     INTEGER NOT NULL DEFAULT 0,
    archived    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sections (
    id          TEXT PRIMARY KEY,
    course_id   TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    "order"     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sections_course ON sections(course_id, "order");

CREATE TABLE IF NOT EXISTS notes (
    id          TEXT PRIMARY KEY,
    -- A note outlives its course: deleting a course files its notes back into
    -- the inbox rather than destroying a semester of work.
    course_id   TEXT REFERENCES courses(id) ON DELETE SET NULL,
    section_id  TEXT REFERENCES sections(id) ON DELETE SET NULL,
    title       TEXT NOT NULL DEFAULT '',
    doc_json    TEXT NOT NULL,
    plain_text  TEXT NOT NULL DEFAULT '',
    pinned      INTEGER NOT NULL DEFAULT 0,
    archived    INTEGER NOT NULL DEFAULT 0,
    trashed_at  TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    "order"     INTEGER NOT NULL DEFAULT 0,
    -- Denormalised feature flags so `has:image` stays an indexed comparison
    -- rather than a JSON scan across the whole library.
    has_image     INTEGER NOT NULL DEFAULT 0,
    has_drawing   INTEGER NOT NULL DEFAULT 0,
    has_table     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_notes_course ON notes(course_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_trashed ON notes(trashed_at);

CREATE TABLE IF NOT EXISTS tags (
    id          TEXT PRIMARY KEY,
    namespace   TEXT,
    name        TEXT NOT NULL
);

-- One tag per (namespace, name), case-insensitively: `topic:Calculus` and
-- `topic:calculus` must not become two filters.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_unique
    ON tags(COALESCE(namespace, ''), name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS note_tags (
    note_id     TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    tag_id      TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (note_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag_id);

CREATE TABLE IF NOT EXISTS assets (
    id          TEXT PRIMARY KEY,   -- SHA-256 of the bytes
    mime        TEXT NOT NULL,
    bytes       INTEGER NOT NULL,
    width       INTEGER,
    height      INTEGER,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
    id          TEXT PRIMARY KEY,
    note_id     TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    asset_id    TEXT NOT NULL REFERENCES assets(id),
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attachments_note ON attachments(note_id);

CREATE TABLE IF NOT EXISTS snapshots (
    id          TEXT PRIMARY KEY,
    note_id     TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    doc_json    TEXT NOT NULL,
    title       TEXT NOT NULL DEFAULT '',
    cause       TEXT NOT NULL,
    run_id      TEXT,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshots_note ON snapshots(note_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_run ON snapshots(run_id);

CREATE TABLE IF NOT EXISTS saved_searches (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    query       TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS templates (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    course_id     TEXT REFERENCES courses(id) ON DELETE CASCADE,
    title_pattern TEXT NOT NULL DEFAULT '',
    doc_json      TEXT NOT NULL
);

-- Wiki links, resolved by note id so a rename never breaks a link. `target_id`
-- is NULL for a link whose note does not exist yet — those render as
-- "unresolved" and create the note on click.
CREATE TABLE IF NOT EXISTS note_links (
    source_id     TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    target_id     TEXT REFERENCES notes(id) ON DELETE SET NULL,
    target_title  TEXT NOT NULL,
    PRIMARY KEY (source_id, target_title)
);

CREATE INDEX IF NOT EXISTS idx_note_links_target ON note_links(target_id);

-- Full-text index. `unicode61 remove_diacritics 2` is what makes a search for
-- "resume" find "résumé" — non-negotiable for a French-speaking user base.
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    title,
    plain_text,
    content = 'notes',
    content_rowid = 'rowid',
    tokenize = "unicode61 remove_diacritics 2"
);

-- Keep the index in step with the table. Doing this in triggers rather than in
-- application code means an agent write, a restore, and a keystroke all
-- maintain the index identically.
CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, title, plain_text)
    VALUES (new.rowid, new.title, new.plain_text);
END;

CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, plain_text)
    VALUES ('delete', old.rowid, old.title, old.plain_text);
END;

CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, plain_text)
    VALUES ('delete', old.rowid, old.title, old.plain_text);
    INSERT INTO notes_fts(rowid, title, plain_text)
    VALUES (new.rowid, new.title, new.plain_text);
END;

-- In-flight editor state, written ahead of the debounced autosave. On launch
-- any row here is newer than its note and is offered as crash recovery.
CREATE TABLE IF NOT EXISTS editor_journal (
    note_id     TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
    doc_json    TEXT NOT NULL,
    title       TEXT NOT NULL,
    written_at  TEXT NOT NULL
);
