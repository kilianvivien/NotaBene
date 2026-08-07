//! Courses, sections, and tags.

//! Every writer here comes in two halves: a `*_in` function that takes a bare
//! connection, and a thin wrapper that opens a transaction around it. The split
//! exists so `library_import` can call all of them inside *one* transaction —
//! the store's mutex is not reentrant, so a wrapper called from inside a
//! transaction would deadlock rather than nest.

use rusqlite::Connection;

use super::model::{Course, Section, Tag};
use super::{notes, DbResult, Store};

pub fn list_courses(store: &Store) -> DbResult<Vec<Course>> {
    store.with(|connection| {
        let mut statement = connection.prepare(
            "SELECT id, name, color, icon, professor, semester, credits, schedule, \
             \"order\", archived, created_at, updated_at FROM courses ORDER BY \"order\"",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok(Course {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                    icon: row.get(3)?,
                    professor: row.get(4)?,
                    semester: row.get(5)?,
                    credits: row.get(6)?,
                    schedule: row.get(7)?,
                    order: row.get(8)?,
                    archived: row.get::<_, i64>(9)? != 0,
                    created_at: row.get(10)?,
                    updated_at: row.get(11)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

pub fn upsert_course(store: &Store, course: &Course) -> DbResult<()> {
    store.transact(|transaction| upsert_course_in(transaction, course))
}

pub(crate) fn upsert_course_in(connection: &Connection, course: &Course) -> DbResult<()> {
    connection.execute(
        "INSERT INTO courses (id, name, color, icon, professor, semester, credits, \
         schedule, \"order\", archived, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) \
         ON CONFLICT(id) DO UPDATE SET \
         name = excluded.name, color = excluded.color, icon = excluded.icon, \
         professor = excluded.professor, semester = excluded.semester, \
         credits = excluded.credits, schedule = excluded.schedule, \
         \"order\" = excluded.\"order\", archived = excluded.archived, \
         updated_at = excluded.updated_at",
        rusqlite::params![
            course.id,
            course.name,
            course.color,
            course.icon,
            course.professor,
            course.semester,
            course.credits,
            course.schedule,
            course.order,
            i64::from(course.archived),
            course.created_at,
            course.updated_at,
        ],
    )?;
    let note_ids = note_ids(
        connection,
        "SELECT id FROM notes WHERE course_id = ?",
        &course.id,
    )?;
    for note_id in note_ids {
        notes::reindex_note(connection, &note_id)?;
    }
    Ok(())
}

/// Deleting a course does not delete its notes — the foreign key is
/// `ON DELETE SET NULL`, so they land back in the inbox.
pub fn delete_course(store: &Store, course_id: &str) -> DbResult<()> {
    store.transact(|connection| {
        let note_ids = note_ids(
            connection,
            "SELECT id FROM notes WHERE course_id = ?",
            course_id,
        )?;
        connection.execute("DELETE FROM courses WHERE id = ?", [course_id])?;
        for note_id in note_ids {
            notes::reindex_note(connection, &note_id)?;
        }
        Ok(())
    })
}

pub fn list_sections(store: &Store, course_id: &str) -> DbResult<Vec<Section>> {
    store.with(|connection| {
        let mut statement = connection.prepare(
            "SELECT id, course_id, name, \"order\" FROM sections \
             WHERE course_id = ? ORDER BY \"order\"",
        )?;
        let rows = statement
            .query_map([course_id], |row| {
                Ok(Section {
                    id: row.get(0)?,
                    course_id: row.get(1)?,
                    name: row.get(2)?,
                    order: row.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

pub(crate) fn list_all_sections(store: &Store) -> DbResult<Vec<Section>> {
    store.with(|connection| {
        let mut statement = connection.prepare(
            "SELECT id, course_id, name, \"order\" FROM sections
             ORDER BY course_id, \"order\"",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok(Section {
                    id: row.get(0)?,
                    course_id: row.get(1)?,
                    name: row.get(2)?,
                    order: row.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

pub fn upsert_section(store: &Store, section: &Section) -> DbResult<()> {
    store.with(|connection| upsert_section_in(connection, section))
}

pub(crate) fn upsert_section_in(connection: &Connection, section: &Section) -> DbResult<()> {
    connection.execute(
        "INSERT INTO sections (id, course_id, name, \"order\") VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT(id) DO UPDATE SET course_id = excluded.course_id, \
         name = excluded.name, \"order\" = excluded.\"order\"",
        rusqlite::params![section.id, section.course_id, section.name, section.order],
    )?;
    Ok(())
}

pub fn delete_section(store: &Store, section_id: &str) -> DbResult<()> {
    store.with(|connection| {
        connection.execute("DELETE FROM sections WHERE id = ?", [section_id])?;
        Ok(())
    })
}

pub fn list_tags(store: &Store) -> DbResult<Vec<Tag>> {
    store.with(|connection| {
        let mut statement =
            connection.prepare("SELECT id, namespace, name, color FROM tags ORDER BY name")?;
        let rows = statement
            .query_map([], |row| {
                Ok(Tag {
                    id: row.get(0)?,
                    namespace: row.get(1)?,
                    name: row.get(2)?,
                    color: row.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

pub fn upsert_tag(store: &Store, tag: &Tag) -> DbResult<()> {
    store.transact(|transaction| upsert_tag_in(transaction, tag))
}

pub(crate) fn upsert_tag_in(connection: &Connection, tag: &Tag) -> DbResult<()> {
    connection.execute(
        "INSERT INTO tags (id, namespace, name, color) VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT(id) DO UPDATE SET namespace = excluded.namespace, \
         name = excluded.name, color = excluded.color",
        rusqlite::params![tag.id, tag.namespace, tag.name, tag.color],
    )?;
    let note_ids = note_ids(
        connection,
        "SELECT note_id FROM note_tags WHERE tag_id = ?",
        &tag.id,
    )?;
    for note_id in note_ids {
        notes::reindex_note(connection, &note_id)?;
    }
    Ok(())
}

pub fn delete_tag(store: &Store, tag_id: &str) -> DbResult<()> {
    store.transact(|connection| {
        let note_ids = note_ids(
            connection,
            "SELECT note_id FROM note_tags WHERE tag_id = ?",
            tag_id,
        )?;
        connection.execute("DELETE FROM tags WHERE id = ?", [tag_id])?;
        for note_id in note_ids {
            notes::reindex_note(connection, &note_id)?;
        }
        Ok(())
    })
}

pub fn merge_tags(store: &Store, from_tag_id: &str, into_tag_id: &str) -> DbResult<()> {
    store.transact(|transaction| {
        let affected = note_ids(
            transaction,
            "SELECT note_id FROM note_tags WHERE tag_id = ?",
            from_tag_id,
        )?;
        // `OR IGNORE`: a note already carrying both tags must not fail the
        // merge on the primary-key conflict.
        transaction.execute(
            "INSERT OR IGNORE INTO note_tags (note_id, tag_id) \
             SELECT note_id, ?1 FROM note_tags WHERE tag_id = ?2",
            rusqlite::params![into_tag_id, from_tag_id],
        )?;
        transaction.execute("DELETE FROM tags WHERE id = ?", [from_tag_id])?;
        for note_id in affected {
            notes::reindex_note(transaction, &note_id)?;
        }
        Ok(())
    })
}

fn note_ids(connection: &rusqlite::Connection, sql: &str, value: &str) -> DbResult<Vec<String>> {
    let mut statement = connection.prepare(sql)?;
    let ids = statement
        .query_map([value], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids)
}
