//! Courses, sections, and tags.

//! Every writer here comes in two halves: a `*_in` function that takes a bare
//! connection, and a thin wrapper that opens a transaction around it. The split
//! exists so `library_import` can call all of them inside *one* transaction —
//! the store's mutex is not reentrant, so a wrapper called from inside a
//! transaction would deadlock rather than nest.

use rusqlite::Connection;

use super::model::{Course, Section, Tag};
use super::{notes, tasks, DbResult, Store};

pub fn list_courses(store: &Store) -> DbResult<Vec<Course>> {
    store.with(|connection| {
        let mut statement = connection.prepare(
            "SELECT id, name, color, icon, professor, semester, credits, schedule, \
             \"order\", archived, created_at, updated_at, meetings_json, \
             lecture_recording, lecture_notify FROM courses ORDER BY \"order\"",
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
                    meetings: match row.get::<_, Option<String>>(12)? {
                        Some(json) => serde_json::from_str(&json).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                12,
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })?,
                        None => Vec::new(),
                    },
                    lecture_recording: row.get(13)?,
                    lecture_notify: row.get::<_, i64>(14)? != 0,
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
    // NULL rather than `[]` for a course without a timetable, so a v9 row and
    // an untouched v10 row look the same.
    let meetings_json = if course.meetings.is_empty() {
        None
    } else {
        Some(serde_json::to_string(&course.meetings)?)
    };
    connection.execute(
        "INSERT INTO courses (id, name, color, icon, professor, semester, credits, \
         schedule, \"order\", archived, created_at, updated_at, meetings_json, \
         lecture_recording, lecture_notify) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15) \
         ON CONFLICT(id) DO UPDATE SET \
         name = excluded.name, color = excluded.color, icon = excluded.icon, \
         professor = excluded.professor, semester = excluded.semester, \
         credits = excluded.credits, schedule = excluded.schedule, \
         \"order\" = excluded.\"order\", archived = excluded.archived, \
         updated_at = excluded.updated_at, meetings_json = excluded.meetings_json, \
         lecture_recording = excluded.lecture_recording, \
         lecture_notify = excluded.lecture_notify",
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
            meetings_json,
            course.lecture_recording,
            i64::from(course.lecture_notify),
        ],
    )?;
    let note_ids = ids_for(
        connection,
        "SELECT id FROM notes WHERE course_id = ?",
        &course.id,
    )?;
    for note_id in note_ids {
        notes::reindex_note(connection, &note_id)?;
    }
    // A task's search row carries its course name too, so a rename has to
    // reach both indexes or the old name keeps answering.
    let task_ids = ids_for(
        connection,
        "SELECT id FROM tasks WHERE course_id = ?",
        &course.id,
    )?;
    for task_id in task_ids {
        tasks::reindex_task(connection, &task_id)?;
    }
    Ok(())
}

/// Deleting a course does not delete its notes — the foreign key is
/// `ON DELETE SET NULL`, so they land back in the inbox. Its tasks are unfiled
/// the same way: an assignment outlives the course it was set for.
pub fn delete_course(store: &Store, course_id: &str) -> DbResult<()> {
    store.transact(|connection| {
        let note_ids = ids_for(
            connection,
            "SELECT id FROM notes WHERE course_id = ?",
            course_id,
        )?;
        let task_ids = ids_for(
            connection,
            "SELECT id FROM tasks WHERE course_id = ?",
            course_id,
        )?;
        connection.execute("DELETE FROM courses WHERE id = ?", [course_id])?;
        for note_id in note_ids {
            notes::reindex_note(connection, &note_id)?;
        }
        for task_id in task_ids {
            tasks::reindex_task(connection, &task_id)?;
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
    let note_ids = ids_for(
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
        let note_ids = ids_for(
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
        let affected = ids_for(
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

fn ids_for(connection: &rusqlite::Connection, sql: &str, value: &str) -> DbResult<Vec<String>> {
    let mut statement = connection.prepare(sql)?;
    let ids = statement
        .query_map([value], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use std::sync::{atomic::AtomicBool, Arc, Mutex};

    use rusqlite::Connection;

    use super::*;
    use crate::db::migrations;
    use crate::db::model::CourseMeeting;

    fn store() -> Store {
        let connection = Connection::open_in_memory().expect("failed to open database");
        let store = Store {
            connection: Arc::new(Mutex::new(connection)),
            read_only: Arc::new(AtomicBool::new(false)),
        };
        migrations::run(&store).expect("failed to migrate");
        store
    }

    fn course(meetings: Vec<CourseMeeting>) -> Course {
        Course {
            id: "droit".into(),
            name: "Droit constitutionnel".into(),
            color: "#3478c7".into(),
            icon: "📘".into(),
            professor: None,
            semester: None,
            credits: None,
            schedule: None,
            order: 0,
            archived: false,
            created_at: "2026-09-01T08:00:00Z".into(),
            updated_at: "2026-09-01T08:00:00Z".into(),
            meetings,
            lecture_recording: "always".into(),
            lecture_notify: true,
        }
    }

    #[test]
    fn a_course_keeps_its_timetable_and_lecture_preferences() {
        let store = store();
        let session = CourseMeeting {
            id: "m-1".into(),
            title: Some("Conférence « La corruption en France »".into()),
            weekdays: vec![1],
            start: 13 * 60 + 30,
            end: 14 * 60 + 30,
            location: Some("Auditorium".into()),
            from: "2026-11-30".into(),
            until: "2026-11-30".into(),
            skip: Vec::new(),
            template_id: None,
            import_key: Some("ics:edt-insp-1".into()),
        };
        upsert_course(&store, &course(vec![session])).expect("failed to write course");
        let read = list_courses(&store).expect("failed to read courses");
        let meeting = &read[0].meetings[0];
        assert_eq!(meeting.title.as_deref(), Some("Conférence « La corruption en France »"));
        assert_eq!(meeting.import_key.as_deref(), Some("ics:edt-insp-1"));
        assert_eq!(read[0].lecture_recording, "always");
        assert!(read[0].lecture_notify);
    }

    #[test]
    fn a_course_without_a_timetable_stores_null() {
        let store = store();
        upsert_course(&store, &course(Vec::new())).expect("failed to write course");
        let stored: Option<String> = store
            .with(|connection| {
                Ok(connection.query_row(
                    "SELECT meetings_json FROM courses WHERE id = 'droit'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .expect("failed to read row");
        assert_eq!(stored, None);
        assert!(list_courses(&store).expect("failed to read")[0].meetings.is_empty());
    }
}
