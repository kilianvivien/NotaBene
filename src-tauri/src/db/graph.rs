//! The library as a graph, and the links it is missing.
//!
//! Read-only over tables that already exist: `note_links` is maintained inside
//! every note's save (`notes::rebuild_links`), so the graph is a read of what
//! the backlink index already knows, never a second scan of every document.
//!
//! An *unlinked mention* is a note that names another by its title without
//! linking to it. The rules, in one place because the inspector and the graph
//! must agree on them:
//!
//! - whole title, whole words, case-insensitive;
//! - titles under four characters are skipped -- "Lab" would match everywhere;
//! - duplicate titles go to the first row, as `resolve_wiki_title_in` does;
//! - a note that already links to the target is not a mention of it;
//! - only live notes are suggested from or to: Trash and the archive are out.
//!
//! `plain_text` is what is searched, and a wiki link contributes nothing to it
//! (the node is an atom with no text), so a linked title is never mistaken for
//! an unlinked one.

use std::collections::HashSet;

use aho_corasick::{AhoCorasick, MatchKind};
use rusqlite::Connection;

use super::model::{GraphEdge, GraphNode, LibraryGraph, UnlinkedMention};
use super::notes::resolve_wiki_title_in;
use super::{DbError, DbResult, Store};

/// Titles shorter than this are never offered as mentions.
const MIN_MENTION_TITLE_CHARS: usize = 4;
/// Short, so the mention itself is inside the two lines the inspector shows.
const SNIPPET_LEAD_CHARS: usize = 24;
const SNIPPET_CHARS: usize = 200;
/// SQLite has no array type; tag ids come back joined on a unit separator,
/// which no id contains.
const TAG_SEPARATOR: char = '\u{1f}';

/// Every live note and every resolved link between two of them.
///
/// `mentions` is opt-in because it is the expensive half: it reads every
/// note's text, where the graph itself reads none.
pub fn read(store: &Store, mentions: bool) -> DbResult<LibraryGraph> {
    store.with(|connection| {
        let nodes = nodes(connection)?;
        let edges = edges(connection)?;
        let mentions = if mentions {
            all_mentions(connection, &edges)?
        } else {
            Vec::new()
        };
        Ok(LibraryGraph {
            nodes,
            edges,
            mentions,
        })
    })
}

fn nodes(connection: &Connection) -> DbResult<Vec<GraphNode>> {
    let mut statement = connection.prepare(
        "SELECT n.id, n.title, n.course_id, n.updated_at,
                (SELECT group_concat(t.tag_id, char(31)) FROM note_tags t WHERE t.note_id = n.id)
         FROM notes n
         WHERE n.trashed_at IS NULL AND n.archived = 0
         ORDER BY n.rowid",
    )?;
    let rows = statement
        .query_map([], |row| {
            let tags: Option<String> = row.get(4)?;
            Ok(GraphNode {
                id: row.get(0)?,
                title: row.get(1)?,
                course_id: row.get(2)?,
                updated_at: row.get(3)?,
                tag_ids: tags
                    .map(|joined| joined.split(TAG_SEPARATOR).map(str::to_owned).collect())
                    .unwrap_or_default(),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn edges(connection: &Connection) -> DbResult<Vec<GraphEdge>> {
    // DISTINCT: the table's key is (source, target *title*), so two spellings
    // of one target are two rows and one edge.
    let mut statement = connection.prepare(
        "SELECT DISTINCT l.source_id, l.target_id
         FROM note_links l
         JOIN notes s ON s.id = l.source_id
         JOIN notes t ON t.id = l.target_id
         WHERE l.source_id != l.target_id
           AND s.trashed_at IS NULL AND s.archived = 0
           AND t.trashed_at IS NULL AND t.archived = 0
         ORDER BY s.rowid, t.rowid",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok(GraphEdge {
                source_id: row.get(0)?,
                target_id: row.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// The titles worth looking for, as one automaton.
///
/// Aho-Corasick because the alternative is every title against every note: at
/// 3,000 notes that is nine million substring searches, and this is one pass
/// over each note's text whatever the number of titles.
struct TitleIndex {
    automaton: AhoCorasick,
    /// The note each pattern resolves to, by pattern index.
    targets: Vec<String>,
}

impl TitleIndex {
    fn build(titles: impl IntoIterator<Item = (String, String)>) -> DbResult<Option<Self>> {
        let mut seen = HashSet::new();
        let mut patterns = Vec::new();
        let mut targets = Vec::new();
        for (id, title) in titles {
            let folded = title.trim().to_lowercase();
            if folded.chars().count() < MIN_MENTION_TITLE_CHARS {
                continue;
            }
            // First row wins, as it does when a bare `[[Title]]` is resolved.
            if seen.insert(folded.clone()) {
                patterns.push(folded);
                targets.push(id);
            }
        }
        if patterns.is_empty() {
            return Ok(None);
        }
        // `Standard`, not leftmost: "Damping" and "Damping ratio" are both
        // mentioned by a sentence that contains the longer one.
        let automaton = AhoCorasick::builder()
            .match_kind(MatchKind::Standard)
            .build(&patterns)
            .map_err(|error| DbError::Other(format!("title index: {error}")))?;
        Ok(Some(Self { automaton, targets }))
    }

    /// Each target named in `folded`, with where its first mention starts.
    fn mentions_in<'a>(&'a self, folded: &'a str) -> impl Iterator<Item = (&'a str, usize)> + 'a {
        let mut seen = HashSet::new();
        self.automaton
            .find_overlapping_iter(folded)
            .filter(move |found| is_whole_word(folded, found.start(), found.end()))
            .filter_map(move |found| {
                let index = found.pattern().as_usize();
                seen.insert(index)
                    .then(|| (self.targets[index].as_str(), found.start()))
            })
    }
}

fn is_word_char(character: char) -> bool {
    character.is_alphanumeric() || character == '_'
}

fn is_whole_word(text: &str, start: usize, end: usize) -> bool {
    let before = text[..start].chars().next_back();
    let after = text[end..].chars().next();
    !before.is_some_and(is_word_char) && !after.is_some_and(is_word_char)
}

/// The text around a mention, cut from the original rather than the folded
/// copy so it reads as the student wrote it. Counted in characters: lowercasing
/// can change a string's byte length, and a byte offset from one would split a
/// character in the other.
fn snippet_at(text: &str, folded: &str, folded_start: usize) -> String {
    let position = folded[..folded_start].chars().count();
    let from = position.saturating_sub(SNIPPET_LEAD_CHARS);
    let cut: String = text
        .chars()
        .skip(from)
        .take(SNIPPET_CHARS)
        .map(|character| {
            if character.is_whitespace() {
                ' '
            } else {
                character
            }
        })
        .collect();
    let cut = cut.trim();
    if from > 0 {
        format!("… {cut}")
    } else {
        cut.to_owned()
    }
}

struct LiveText {
    id: String,
    title: String,
    plain_text: String,
    updated_at: String,
}

fn live_texts(connection: &Connection) -> DbResult<Vec<LiveText>> {
    let mut statement = connection.prepare(
        "SELECT id, title, plain_text, updated_at FROM notes
         WHERE trashed_at IS NULL AND archived = 0
         ORDER BY rowid",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok(LiveText {
                id: row.get(0)?,
                title: row.get(1)?,
                plain_text: row.get(2)?,
                updated_at: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn all_mentions(connection: &Connection, edges: &[GraphEdge]) -> DbResult<Vec<GraphEdge>> {
    // Every title, Trash included: a trashed note still captures a bare
    // `[[Title]]`, so it must capture the mention too or the two would disagree.
    let titles = {
        let mut statement = connection.prepare("SELECT id, title FROM notes ORDER BY rowid")?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let Some(index) = TitleIndex::build(titles)? else {
        return Ok(Vec::new());
    };

    let notes = live_texts(connection)?;
    let live: HashSet<&str> = notes.iter().map(|note| note.id.as_str()).collect();
    let linked: HashSet<(&str, &str)> = edges
        .iter()
        .map(|edge| (edge.source_id.as_str(), edge.target_id.as_str()))
        .collect();

    let mut mentions = Vec::new();
    for note in &notes {
        let folded = note.plain_text.to_lowercase();
        for (target, _) in index.mentions_in(&folded) {
            if target == note.id
                || !live.contains(target)
                || linked.contains(&(note.id.as_str(), target))
            {
                continue;
            }
            mentions.push(GraphEdge {
                source_id: note.id.clone(),
                target_id: target.to_owned(),
            });
        }
    }
    Ok(mentions)
}

/// The live notes that name `note_id` by title without linking to it.
pub fn list_unlinked_mentions(store: &Store, note_id: &str) -> DbResult<Vec<UnlinkedMention>> {
    store.with(|connection| {
        let target: Option<(String, Option<String>, bool)> = {
            use rusqlite::OptionalExtension;
            connection
                .query_row(
                    "SELECT title, trashed_at, archived FROM notes WHERE id = ?",
                    [note_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?
        };
        let Some((title, trashed_at, archived)) = target else {
            return Ok(Vec::new());
        };
        if trashed_at.is_some() || archived {
            return Ok(Vec::new());
        }
        // A duplicate title that another note holds first is that note's to be
        // mentioned by -- the same answer a bare `[[Title]]` would get.
        if resolve_wiki_title_in(connection, title.trim())?.as_deref() != Some(note_id) {
            return Ok(Vec::new());
        }
        let Some(index) = TitleIndex::build([(note_id.to_owned(), title)])? else {
            return Ok(Vec::new());
        };

        let linked: HashSet<String> = {
            let mut statement =
                connection.prepare("SELECT source_id FROM note_links WHERE target_id = ?")?;
            let rows = statement
                .query_map([note_id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<HashSet<_>>>()?;
            rows
        };

        let mut mentions = Vec::new();
        for note in live_texts(connection)? {
            if note.id == note_id || linked.contains(&note.id) {
                continue;
            }
            let folded = note.plain_text.to_lowercase();
            let first = index.mentions_in(&folded).next().map(|(_, start)| start);
            if let Some(start) = first {
                mentions.push(UnlinkedMention {
                    snippet: snippet_at(&note.plain_text, &folded, start),
                    source_id: note.id,
                    source_title: note.title,
                    updated_at: note.updated_at,
                });
            }
        }
        mentions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(mentions)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::model::{Note, Tag};
    use crate::db::{notes, organization};

    const WIRE_NOTE: &str = include_str!("../../../src/lib/schema/fixtures/wire-note.json");

    struct TempStore {
        store: Store,
        directory: std::path::PathBuf,
    }

    impl Drop for TempStore {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    fn temp_store() -> TempStore {
        // Counter and process id for the reason `notes::tests::temp_store`
        // gives: a timestamp alone is shared by tests starting in one tick.
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock before the epoch")
            .as_nanos();
        let sequence = SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "notabene-graph-test-{unique}-{}-{sequence}",
            std::process::id()
        ));
        let store = Store::open(
            &directory.join("notabene.sqlite3"),
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )
        .expect("failed to open the test store");
        TempStore { store, directory }
    }

    fn text(value: &str) -> serde_json::Value {
        serde_json::json!({ "type": "text", "text": value })
    }

    fn link(note_id: &str, title: &str) -> serde_json::Value {
        serde_json::json!({ "type": "wikiLink", "attrs": { "noteId": note_id, "title": title } })
    }

    /// A one-paragraph note. `plain_text` is derived the way the webview
    /// derives it: text nodes only, since a wiki link has none.
    fn note(id: &str, title: &str, inline: Vec<serde_json::Value>) -> Note {
        let mut note: Note = serde_json::from_str(WIRE_NOTE).expect("fixture");
        note.id = id.into();
        note.title = title.into();
        note.tag_ids.clear();
        note.plain_text = inline
            .iter()
            .filter_map(|node| node.get("text").and_then(|value| value.as_str()))
            .collect();
        note.doc = serde_json::json!({
            "type": "doc",
            "content": [{ "type": "paragraph", "content": inline }]
        });
        note
    }

    fn pairs(edges: &[GraphEdge]) -> Vec<(&str, &str)> {
        edges
            .iter()
            .map(|edge| (edge.source_id.as_str(), edge.target_id.as_str()))
            .collect()
    }

    #[test]
    fn the_graph_is_live_notes_and_the_resolved_links_between_them() {
        let temporary = temp_store();
        let store = &temporary.store;
        organization::upsert_tag(
            store,
            &Tag {
                id: "tag_exam".into(),
                namespace: None,
                name: "exam".into(),
                color: "#9b5c2f".into(),
            },
        )
        .unwrap();

        let mut waves = note("waves", "Waves", vec![text("Start here.")]);
        waves.tag_ids = vec!["tag_exam".into()];
        let damping = note(
            "damping",
            "Damping",
            // Two spellings of one target, a link to itself, and a link to a
            // note that does not exist: one edge between them.
            vec![
                link("waves", "Waves"),
                link("waves", "waves (week 3)"),
                link("damping", "Damping"),
                serde_json::json!({ "type": "wikiLink", "attrs": { "title": "Nowhere" } }),
            ],
        );
        let mut binned = note("binned", "Binned", vec![link("waves", "Waves")]);
        binned.trashed_at = Some("2026-10-01T00:00:00.000Z".into());
        let mut shelved = note("shelved", "Shelved", vec![link("waves", "Waves")]);
        shelved.archived = true;
        notes::upsert_many(store, &[waves, damping, binned, shelved]).unwrap();

        let graph = read(store, false).unwrap();
        let ids: Vec<&str> = graph.nodes.iter().map(|node| node.id.as_str()).collect();
        assert_eq!(ids, ["waves", "damping"]);
        assert_eq!(graph.nodes[0].tag_ids, ["tag_exam"]);
        assert!(graph.nodes[1].tag_ids.is_empty());
        assert_eq!(pairs(&graph.edges), [("damping", "waves")]);
        assert!(graph.mentions.is_empty());
    }

    #[test]
    fn a_mention_is_a_whole_title_that_is_not_already_a_link() {
        let temporary = temp_store();
        let store = &temporary.store;
        notes::upsert_many(
            store,
            &[
                note("damping", "Damping", vec![text("The target.")]),
                note("ratio", "Damping ratio", vec![text("A longer title.")]),
                note("lab", "Lab", vec![text("Too short to look for.")]),
                note(
                    "mentions",
                    "Week 4",
                    vec![text("We saw DAMPING today, in the lab.")],
                ),
                note(
                    "both",
                    "Week 5",
                    vec![text("The damping ratio decides it.")],
                ),
                note(
                    "inside",
                    "Week 6",
                    vec![text("Overdamping and damping_factor are other words.")],
                ),
                note(
                    "linked",
                    "Week 7",
                    vec![text("More on damping: "), link("damping", "Damping")],
                ),
            ],
        )
        .unwrap();

        let graph = read(store, true).unwrap();
        assert_eq!(
            pairs(&graph.mentions),
            [
                ("mentions", "damping"),
                ("both", "damping"),
                ("both", "ratio"),
            ]
        );

        let found = list_unlinked_mentions(store, "damping").unwrap();
        let sources: HashSet<&str> = found.iter().map(|m| m.source_id.as_str()).collect();
        assert_eq!(sources, HashSet::from(["mentions", "both"]));
        let week4 = found.iter().find(|m| m.source_id == "mentions").unwrap();
        assert_eq!(week4.source_title, "Week 4");
        assert!(week4.snippet.contains("DAMPING"), "{}", week4.snippet);

        assert!(list_unlinked_mentions(store, "lab").unwrap().is_empty());
        assert!(list_unlinked_mentions(store, "missing").unwrap().is_empty());
    }

    #[test]
    fn a_duplicate_title_is_mentioned_as_the_note_a_link_would_reach() {
        let temporary = temp_store();
        let store = &temporary.store;
        notes::upsert_many(
            store,
            &[
                note("first", "Entropy", vec![text("The original.")]),
                note("second", "entropy", vec![text("A later duplicate.")]),
                note("reader", "Week 9", vec![text("Entropy always rises.")]),
            ],
        )
        .unwrap();

        assert_eq!(
            notes::resolve_wiki_title(store, "Entropy")
                .unwrap()
                .as_deref(),
            Some("first")
        );
        assert_eq!(list_unlinked_mentions(store, "first").unwrap().len(), 1);
        assert!(list_unlinked_mentions(store, "second").unwrap().is_empty());
        assert_eq!(
            pairs(&read(store, true).unwrap().mentions),
            [("reader", "first")]
        );
    }

    #[test]
    fn a_snippet_survives_text_whose_lowercase_is_a_different_length() {
        // 'İ' lowercases to two characters; a byte offset carried from the
        // folded copy into the original would land inside one.
        let original = "İİİİ İstanbul trip — the Damping lecture";
        let folded = original.to_lowercase();
        let start = folded.find("damping").unwrap();
        assert!(snippet_at(original, &folded, start).contains("Damping"));
    }
}
