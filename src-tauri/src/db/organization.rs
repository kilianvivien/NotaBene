//! Courses, sections, and tags.

use super::model::{Course, Section, Tag};
use super::{DbResult, Store};

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
    store.with(|connection| {
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
        Ok(())
    })
}

/// Deleting a course does not delete its notes — the foreign key is
/// `ON DELETE SET NULL`, so they land back in the inbox.
pub fn delete_course(store: &Store, course_id: &str) -> DbResult<()> {
    store.with(|connection| {
        connection.execute("DELETE FROM courses WHERE id = ?", [course_id])?;
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

pub fn upsert_section(store: &Store, section: &Section) -> DbResult<()> {
    store.with(|connection| {
        connection.execute(
            "INSERT INTO sections (id, course_id, name, \"order\") VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(id) DO UPDATE SET course_id = excluded.course_id, \
             name = excluded.name, \"order\" = excluded.\"order\"",
            rusqlite::params![section.id, section.course_id, section.name, section.order],
        )?;
        Ok(())
    })
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
            connection.prepare("SELECT id, namespace, name FROM tags ORDER BY name")?;
        let rows = statement
            .query_map([], |row| {
                Ok(Tag {
                    id: row.get(0)?,
                    namespace: row.get(1)?,
                    name: row.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

pub fn upsert_tag(store: &Store, tag: &Tag) -> DbResult<()> {
    store.with(|connection| {
        connection.execute(
            "INSERT INTO tags (id, namespace, name) VALUES (?1, ?2, ?3) \
             ON CONFLICT(id) DO UPDATE SET namespace = excluded.namespace, name = excluded.name",
            rusqlite::params![tag.id, tag.namespace, tag.name],
        )?;
        Ok(())
    })
}

pub fn delete_tag(store: &Store, tag_id: &str) -> DbResult<()> {
    store.with(|connection| {
        connection.execute("DELETE FROM tags WHERE id = ?", [tag_id])?;
        Ok(())
    })
}

pub fn merge_tags(store: &Store, from_tag_id: &str, into_tag_id: &str) -> DbResult<()> {
    store.transact(|transaction| {
        // `OR IGNORE`: a note already carrying both tags must not fail the
        // merge on the primary-key conflict.
        transaction.execute(
            "INSERT OR IGNORE INTO note_tags (note_id, tag_id) \
             SELECT note_id, ?1 FROM note_tags WHERE tag_id = ?2",
            rusqlite::params![into_tag_id, from_tag_id],
        )?;
        transaction.execute("DELETE FROM tags WHERE id = ?", [from_tag_id])?;
        Ok(())
    })
}
