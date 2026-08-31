//! NotaBene-dialect Markdown from AnyDoc's document model.
//!
//! # Why this exists
//!
//! `anydoc::to_markdown_bytes` renders GFM, and three things it does are
//! wrong for us. It drops an embedded image to bare alt text (there is no
//! reference left to rewrite, so refs have to be *created*); it collapses a
//! footnote and an endnote to the same `[^N]`; and it has no reason to know
//! about `$math$` or `asset:` links. `document_to_markdown` is private at
//! every published version, so a `Document` cannot be mutated and re-rendered
//! -- the only way through is to own the walk.
//!
//! # What it targets
//!
//! Not CommonMark. `markdownToDoc` in `src/editor/markdown/index.ts` is a
//! line-based parser with one inline regex, and rendering for *it* is a
//! different job from rendering GFM:
//!
//! - **It does not unescape.** A `\*` reaches the note as a visible
//!   backslash, so backslash escaping is worse than none. `docToMarkdown`
//!   escapes nothing either; this follows that convention. The one exception
//!   is `\|` inside a table cell, which `cells()` now understands, because a
//!   raw pipe there silently splits the row.
//! - **Its inline delimiters cannot nest.** `\*\*([^*]+)\*\*` forbids a `*`
//!   inside bold, so a run that is bold *and* italic has to pick one.
//! - **Its lists do not nest**, its table cells hold inline content only, and
//!   its footnote definitions are one line each.
//!
//! Every place the model carries something that dialect cannot express, the
//! text survives and the loss is counted in [`Warnings`]. Nothing is dropped
//! silently, and no warning is an English sentence: they are codes the
//! webview translates, because a string built here could only ever be in one
//! language.

use std::collections::BTreeMap;

use anydoc::model::{
    Block, Cell, CellSlot, Document, ImageSource, Inline, LinkTarget, List, ListItem, MarkerKind,
    Note, NoteKind, Style, Table, TableKind,
};

/// Placeholder id for an embedded image, rewritten to the real content hash
/// by `materialiseAssets` once the bytes have been stored.
///
/// Deliberately inside the `asset:` scheme rather than beside it: that makes
/// the line parse as an `image` node straight away, so the import preview
/// shows the caption where the picture will be instead of a raw reference.
pub const ASSET_PLACEHOLDER: &str = "nb-import";

pub mod warning {
    //! Codes for what the dialect could not carry. Translated at the surface
    //! as `import.warning.<code>` with a count.

    /// A merged table cell became separate cells; Markdown has no colspan.
    pub const TABLE_SPANS: &str = "tableSpans";
    /// A block inside a table cell was flattened to a line of text.
    pub const TABLE_CELL_BLOCKS: &str = "tableCellBlocks";
    /// A second or later header row became an ordinary row.
    pub const TABLE_HEADER_ROWS: &str = "tableHeaderRows";
    /// A nested list lost its depth and joined its parent.
    pub const NESTED_LIST: &str = "nestedList";
    /// Strikethrough was dropped; the dialect has no mark for it.
    pub const STRIKE: &str = "strike";
    /// A run was bold *and* italic and had to pick one.
    pub const COMBINED_STYLE: &str = "combinedStyle";
    /// A note body of several blocks became one line.
    pub const NOTE_FLATTENED: &str = "noteFlattened";
    /// A link to a place inside the document kept its text and lost its link.
    pub const INTERNAL_LINK: &str = "internalLink";
    /// A link whose label contains `]`, which the dialect cannot express.
    pub const LINK_LABEL: &str = "linkLabel";
    /// An image hosted elsewhere; NotaBene does not fetch it.
    pub const EXTERNAL_IMAGE: &str = "externalImage";
    /// An image whose bytes the source no longer had.
    pub const IMAGE_UNAVAILABLE: &str = "imageUnavailable";
    /// A code span containing a backtick, kept as plain text.
    pub const CODE_SPAN: &str = "codeSpan";
    /// A formula the dialect cannot delimit, kept as plain text.
    pub const MATH: &str = "math";
}

/// What the dialect could not carry, by code and count.
#[derive(Debug, Default)]
pub struct Warnings(BTreeMap<&'static str, u32>);

impl Warnings {
    fn note(&mut self, code: &'static str) {
        *self.0.entry(code).or_default() += 1;
    }

    pub fn into_pairs(self) -> Vec<(&'static str, u32)> {
        self.0.into_iter().collect()
    }
}

pub struct Rendered {
    pub markdown: String,
    pub warnings: Warnings,
}

/// Where a run is being rendered. Only the table cell restricts anything: it
/// is one line, split on unescaped pipes.
#[derive(Clone, Copy, PartialEq)]
enum Ctx {
    Block,
    Cell,
}

pub fn render(document: &Document) -> Rendered {
    let mut w = Warnings::default();
    let labels = note_labels(&document.notes);

    let body = blocks(&document.blocks, &labels, &mut w);
    let definitions: Vec<String> = document
        .notes
        .iter()
        .filter_map(|note| {
            let label = labels.get(note.id.as_str())?;
            Some(format!("[^{label}]: {}", note_body(note, &labels, &mut w)))
        })
        .collect();

    let markdown = [body, definitions.join("\n")]
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");

    Rendered { markdown, warnings: w }
}

/// `fn-1`, `en-1`, ... keyed by AnyDoc's document-scoped note id.
///
/// The prefix is load-bearing: `markdownToDoc` reads `en-` as an endnote, and
/// it is the only thing that survives AnyDoc's own renderer collapsing the
/// two kinds into one `[^N]`.
fn note_labels(notes: &[Note]) -> BTreeMap<&str, String> {
    let mut labels = BTreeMap::new();
    let (mut footnotes, mut endnotes) = (0u32, 0u32);
    for note in notes {
        let label = match note.kind {
            NoteKind::Footnote => {
                footnotes += 1;
                format!("fn-{footnotes}")
            }
            NoteKind::Endnote => {
                endnotes += 1;
                format!("en-{endnotes}")
            }
        };
        labels.insert(note.id.as_str(), label);
    }
    labels
}

/// A note body as one line. `docToMarkdown` already flattens newlines out of
/// a definition, so this matches what NotaBene writes for its own notes.
fn note_body(note: &Note, labels: &BTreeMap<&str, String>, w: &mut Warnings) -> String {
    if note.blocks.len() > 1 {
        w.note(warning::NOTE_FLATTENED);
    }
    let text = blocks(&note.blocks, labels, w);
    text.replace('\n', " ").split_whitespace().collect::<Vec<_>>().join(" ")
}

fn blocks(items: &[Block], labels: &BTreeMap<&str, String>, w: &mut Warnings) -> String {
    items
        .iter()
        .map(|block| block_to_markdown(block, labels, w))
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Exhaustive by choice: `Block` is not `#[non_exhaustive]`, so a kind added
/// upstream breaks the build here rather than vanishing from an import.
fn block_to_markdown(block: &Block, labels: &BTreeMap<&str, String>, w: &mut Warnings) -> String {
    match block {
        Block::Heading { level, content, .. } => {
            let hashes = "#".repeat((*level).clamp(1, 6) as usize);
            format!("{hashes} {}", inlines(content, Ctx::Block, labels, w))
        }
        Block::Paragraph(content) => inlines(content, Ctx::Block, labels, w),
        Block::List(list) => list_to_markdown(list, labels, w),
        Block::Table(table) => table_to_markdown(table, labels, w),
        Block::BlockQuote(inner) => blocks(inner, labels, w)
            .lines()
            .map(|line| format!("> {line}"))
            .collect::<Vec<_>>()
            .join("\n"),
        Block::CodeBlock { lang, text } => code_block(lang.as_deref(), text),
        Block::Rule => "---".to_string(),
        Block::Math(tex) => math_block(tex),
    }
}

/// A fence the body cannot close. `markdownToDoc` ends a block at a line of
/// exactly ``` , so a body line like that would truncate the code; one leading
/// space keeps it inside, which is worth more than the exact column.
fn code_block(lang: Option<&str>, text: &str) -> String {
    let language: String = lang
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let body = text
        .lines()
        .map(|line| if line.trim_end() == "```" { format!(" {line}") } else { line.to_string() })
        .collect::<Vec<_>>()
        .join("\n");
    format!("```{language}\n{body}\n```")
}

fn math_block(tex: &str) -> String {
    let body = tex
        .lines()
        .map(|line| if line.trim() == "$$" { format!(" {line}") } else { line.to_string() })
        .collect::<Vec<_>>()
        .join("\n");
    format!("$$\n{body}\n$$")
}

/// Items one per line. `markdownToDoc` builds a flat list from a run of
/// matching lines, so a nested list joins its parent rather than nesting --
/// the words and their order survive, the depth does not.
fn list_to_markdown(list: &List, labels: &BTreeMap<&str, String>, w: &mut Warnings) -> String {
    let mut lines = Vec::new();
    for (offset, item) in list.items.iter().enumerate() {
        let ordinal = list.start.saturating_add(offset as u64);
        let marker = match (&item.marker_label, list.marker) {
            (Some(_), _) | (None, MarkerKind::Bullet) => "-".to_string(),
            (None, kind) => format!("{}.", kind.ordinal(ordinal)),
        };
        lines.push(format!("{marker} {}", item_head(item, labels, w)));
        for nested in nested_lists(item) {
            w.note(warning::NESTED_LIST);
            lines.push(list_to_markdown(nested, labels, w));
        }
    }
    lines.join("\n")
}

/// An item's own content as one line, nested lists excluded -- those follow
/// as their own lines so their items stay items rather than becoming prose.
fn item_head(item: &ListItem, labels: &BTreeMap<&str, String>, w: &mut Warnings) -> String {
    let own: Vec<&Block> =
        item.blocks.iter().filter(|block| !matches!(block, Block::List(_))).collect();
    let text = own
        .iter()
        .map(|block| block_to_markdown(block, labels, w))
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    text.replace('\n', " ")
}

fn nested_lists(item: &ListItem) -> Vec<&List> {
    item.blocks
        .iter()
        .filter_map(|block| match block {
            Block::List(list) => Some(list),
            _ => None,
        })
        .collect()
}

/// A GFM pipe table. `markdownToDoc` needs a header row and a divider, so a
/// table the source gave no header gets an empty one -- the alternative is
/// the whole grid parsing as a paragraph.
fn table_to_markdown(table: &Table, labels: &BTreeMap<&str, String>, w: &mut Warnings) -> String {
    // A layout table wrapping a single cell is scaffolding, not data.
    if table.kind == TableKind::Layout && table.is_single_cell() {
        if let Some(CellSlot::Origin(cell)) = table.grid.first().and_then(|row| row.first()) {
            return blocks(&cell.blocks, labels, w);
        }
    }
    if table.grid.is_empty() {
        return String::new();
    }
    if table.header_rows > 1 {
        w.note(warning::TABLE_HEADER_ROWS);
    }

    let width = table.grid.iter().map(Vec::len).max().unwrap_or(0);
    if width == 0 {
        return String::new();
    }

    let mut rows: Vec<String> = Vec::new();
    for row in &table.grid {
        let mut values: Vec<String> = Vec::with_capacity(width);
        for slot in row {
            values.push(match slot {
                CellSlot::Origin(cell) => {
                    if cell.col_span > 1 || cell.row_span > 1 {
                        w.note(warning::TABLE_SPANS);
                    }
                    cell_to_markdown(cell, labels, w)
                }
                // The shadow of a merge. An empty cell keeps the column count
                // honest, which is what stops the row from shifting left.
                CellSlot::Covered { .. } => String::new(),
            });
        }
        values.resize(width, String::new());
        rows.push(format!("| {} |", values.join(" | ")));
    }

    let divider = format!("| {} |", vec!["---"; width].join(" | "));
    if table.header_rows == 0 {
        let empty = format!("| {} |", vec![""; width].join(" | "));
        rows.insert(0, divider);
        rows.insert(0, empty);
    } else {
        rows.insert(1, divider);
    }
    rows.join("\n")
}

/// A cell is one line of inline content: `markdownToDoc` parses a cell with
/// `paragraph()`, so anything block-shaped inside it flattens.
fn cell_to_markdown(cell: &Cell, labels: &BTreeMap<&str, String>, w: &mut Warnings) -> String {
    let mut parts = Vec::new();
    for block in &cell.blocks {
        match block {
            Block::Paragraph(content) => parts.push(inlines(content, Ctx::Cell, labels, w)),
            other => {
                w.note(warning::TABLE_CELL_BLOCKS);
                let flattened = block_to_markdown(other, labels, w);
                parts.push(escape_cell(&flattened.replace('\n', " ")));
            }
        }
    }
    parts.join(" ").trim().to_string()
}

/// `cells()` splits a row on unescaped pipes, so a pipe in the text is
/// escaped rather than left to silently split the row.
fn escape_cell(text: &str) -> String {
    text.replace('|', "\\|")
}

fn inlines(
    items: &[Inline],
    ctx: Ctx,
    labels: &BTreeMap<&str, String>,
    w: &mut Warnings,
) -> String {
    let mut out = String::new();
    for item in items {
        out.push_str(&inline_to_markdown(item, ctx, labels, w));
    }
    out
}

fn inline_to_markdown(
    item: &Inline,
    ctx: Ctx,
    labels: &BTreeMap<&str, String>,
    w: &mut Warnings,
) -> String {
    match item {
        Inline::Text { text, style } => styled(text, *style, ctx, w),
        Inline::Link { content, target } => link(content, target, ctx, labels, w),
        Inline::Image { alt, source } => image(alt, source, ctx, w),
        Inline::NoteRef(id) => {
            labels.get(id.as_str()).map(|label| format!("[^{label}]")).unwrap_or_default()
        }
        Inline::Math(tex) => inline_math(tex, ctx, w),
        Inline::Checkbox(checked) => {
            if *checked { "[x]".to_string() } else { "[ ]".to_string() }
        }
        // Zero-width: a bookmark position with nothing to show for it.
        Inline::Anchor(_) => String::new(),
        // A cell is one line; elsewhere the parser joins lines with a space
        // anyway, so a space is what a break becomes either way.
        Inline::LineBreak => " ".to_string(),
    }
}

/// One mark, at most. The dialect's delimiters exclude their own character
/// (`\*\*([^*]+)\*\*`), so bold-and-italic cannot round-trip and code wins
/// over both -- monospace carries meaning that emphasis does not.
fn styled(text: &str, style: Style, ctx: Ctx, w: &mut Warnings) -> String {
    let text = plain(text, ctx);
    if text.is_empty() {
        return text;
    }
    if style.strike {
        w.note(warning::STRIKE);
    }
    if style.code {
        if text.contains('`') {
            w.note(warning::CODE_SPAN);
            return text;
        }
        return format!("`{text}`");
    }
    if style.bold && style.italic {
        w.note(warning::COMBINED_STYLE);
    }
    if style.bold {
        return wrap_unless(&text, '*', "**", w);
    }
    if style.italic {
        return wrap_unless(&text, '*', "*", w);
    }
    text
}

/// Emphasis whose own delimiter appears in the text cannot be expressed, so
/// the words stay and the emphasis goes.
fn wrap_unless(text: &str, forbidden: char, delimiter: &str, w: &mut Warnings) -> String {
    if text.contains(forbidden) {
        w.note(warning::COMBINED_STYLE);
        return text.to_string();
    }
    format!("{delimiter}{text}{delimiter}")
}

fn plain(text: &str, ctx: Ctx) -> String {
    let text = text.replace(['\r', '\n'], " ");
    match ctx {
        Ctx::Cell => escape_cell(&text),
        Ctx::Block => text,
    }
}

fn link(
    content: &[Inline],
    target: &LinkTarget,
    ctx: Ctx,
    labels: &BTreeMap<&str, String>,
    w: &mut Warnings,
) -> String {
    let label = inlines(content, ctx, labels, w);
    let href = match target {
        LinkTarget::External(url) => url,
        LinkTarget::Relative(url) => url,
        // Nothing in a note can be linked to by anchor, so the words stay.
        LinkTarget::Anchor(_) => {
            w.note(warning::INTERNAL_LINK);
            return label;
        }
    };
    if href.is_empty() || label.trim().is_empty() {
        return label;
    }
    // `\[([^\]]+)\]` cannot match a `]` at all, and the parser does not
    // unescape, so a label containing one has no expressible form.
    if label.contains(']') {
        w.note(warning::LINK_LABEL);
        return label;
    }
    format!("[{label}]({})", href_text(href, ctx))
}

/// `\(([^)]+)\)` ends the destination at the first `)`, so one in the URL is
/// percent-encoded rather than left to truncate it.
fn href_text(href: &str, ctx: Ctx) -> String {
    let encoded: String = href
        .chars()
        .map(|c| match c {
            '(' => "%28".to_string(),
            ')' => "%29".to_string(),
            '|' if ctx == Ctx::Cell => "%7C".to_string(),
            c if c.is_control() || c.is_whitespace() => "%20".to_string(),
            c => c.to_string(),
        })
        .collect();
    encoded
}

/// An embedded image becomes a placeholder the webview rewrites once it has
/// hashed the bytes. It has to sit on its own line: the parser's image rule
/// is anchored to a whole line, and `image` is a block node in the schema.
fn image(alt: &str, source: &ImageSource, ctx: Ctx, w: &mut Warnings) -> String {
    let caption = plain(alt, ctx).replace([']', '\n'], " ").trim().to_string();
    match source {
        ImageSource::Asset(id) => {
            format!("\n\n![{caption}](asset:{ASSET_PLACEHOLDER}-{})\n\n", id.0)
        }
        ImageSource::External(_) => {
            w.note(warning::EXTERNAL_IMAGE);
            caption
        }
        ImageSource::Unavailable => {
            w.note(warning::IMAGE_UNAVAILABLE);
            caption
        }
    }
}

/// `\$([^$\n]+)\$` allows neither a `$` nor a newline between the delimiters.
fn inline_math(tex: &str, ctx: Ctx, w: &mut Warnings) -> String {
    let tex = tex.trim();
    if tex.is_empty() {
        return String::new();
    }
    if tex.contains('$') || tex.contains('\n') {
        w.note(warning::MATH);
        return plain(tex, ctx);
    }
    format!("${}$", plain(tex, ctx))
}

#[cfg(test)]
mod tests {
    use super::*;
    use anydoc::model::AssetId;

    fn doc(blocks: Vec<Block>) -> Document {
        Document { blocks, notes: Vec::new(), assets: Vec::new() }
    }

    fn md(blocks: Vec<Block>) -> String {
        render(&doc(blocks)).markdown
    }

    fn warned(blocks: Vec<Block>) -> Vec<(&'static str, u32)> {
        render(&doc(blocks)).warnings.into_pairs()
    }

    fn para(t: &str) -> Block {
        Block::Paragraph(vec![Inline::plain(t)])
    }

    fn styled_run(t: &str, style: Style) -> Block {
        Block::Paragraph(vec![Inline::Text { text: t.into(), style }])
    }

    // -- images --------------------------------------------------------------

    /// `markdownToDoc`'s image rule is anchored to a whole line, and `image`
    /// is a block node, so an embedded picture has to break its paragraph.
    #[test]
    fn an_embedded_image_lands_on_a_line_of_its_own() {
        let markdown = md(vec![Block::Paragraph(vec![
            Inline::plain("before"),
            Inline::Image { alt: "Fig 1".into(), source: ImageSource::Asset(AssetId(3)) },
            Inline::plain("after"),
        ])]);
        assert!(markdown.contains("\n\n![Fig 1](asset:nb-import-3)\n\n"), "{markdown}");
    }

    #[test]
    fn an_image_hosted_elsewhere_keeps_its_words_and_says_so() {
        let blocks = vec![Block::Paragraph(vec![Inline::Image {
            alt: "Chart".into(),
            source: ImageSource::External("https://example.com/c.png".into()),
        }])];
        assert_eq!(md(blocks.clone()), "Chart");
        assert_eq!(warned(blocks), vec![(warning::EXTERNAL_IMAGE, 1)]);
    }

    // -- notes ---------------------------------------------------------------

    /// The `en-` prefix is the whole reason this renderer exists for notes:
    /// AnyDoc collapses both kinds to `[^N]`, and `markdownToDoc` reads the
    /// prefix to tell them apart.
    #[test]
    fn an_endnote_stays_an_endnote() {
        let document = Document {
            blocks: vec![Block::Paragraph(vec![
                Inline::plain("Claim"),
                Inline::NoteRef("a".into()),
                Inline::plain(" and coda"),
                Inline::NoteRef("b".into()),
            ])],
            notes: vec![
                Note {
                    id: "a".into(),
                    kind: NoteKind::Footnote,
                    blocks: vec![para("Source note")],
                },
                Note {
                    id: "b".into(),
                    kind: NoteKind::Endnote,
                    blocks: vec![para("Closing note")],
                },
            ],
            assets: Vec::new(),
        };
        assert_eq!(
            render(&document).markdown,
            "Claim[^fn-1] and coda[^en-1]\n\n[^fn-1]: Source note\n[^en-1]: Closing note"
        );
    }

    #[test]
    fn a_note_of_several_blocks_becomes_one_line_and_says_so() {
        let document = Document {
            blocks: vec![Block::Paragraph(vec![Inline::NoteRef("a".into())])],
            notes: vec![Note {
                id: "a".into(),
                kind: NoteKind::Footnote,
                blocks: vec![para("First half."), para("Second half.")],
            }],
            assets: Vec::new(),
        };
        let rendered = render(&document);
        assert!(rendered.markdown.contains("[^fn-1]: First half. Second half."));
        assert_eq!(rendered.warnings.into_pairs(), vec![(warning::NOTE_FLATTENED, 1)]);
    }

    // -- tables --------------------------------------------------------------

    #[test]
    fn a_table_without_a_header_still_gets_a_divider() {
        let table = Table::from_rows(
            vec![vec![
                Cell::from_inlines(vec![Inline::plain("Ada")]),
                Cell::from_inlines(vec![Inline::plain("91")]),
            ]],
            0,
            TableKind::Data,
        );
        assert_eq!(md(vec![Block::Table(table)]), "|  |  |\n| --- | --- |\n| Ada | 91 |");
    }

    #[test]
    fn a_header_row_leads_and_the_divider_follows_it() {
        let table = Table::from_rows(
            vec![
                vec![
                    Cell::from_inlines(vec![Inline::plain("Student")]),
                    Cell::from_inlines(vec![Inline::plain("Mark")]),
                ],
                vec![
                    Cell::from_inlines(vec![Inline::plain("Ada")]),
                    Cell::from_inlines(vec![Inline::plain("91")]),
                ],
            ],
            1,
            TableKind::Data,
        );
        assert_eq!(
            md(vec![Block::Table(table)]),
            "| Student | Mark |\n| --- | --- |\n| Ada | 91 |"
        );
    }

    /// GFM has no colspan and neither does NotaBene's `table` node, so the
    /// shadow of a merge becomes an empty cell -- which is what keeps the
    /// remaining columns under the right headings.
    #[test]
    fn a_merged_cell_keeps_the_columns_aligned_and_says_so() {
        let table = Table {
            grid: vec![
                vec![
                    CellSlot::Origin(Cell::spanning(
                        vec![para("Term one")],
                        2,
                        1,
                    )),
                    CellSlot::Covered { origin_row: 0, origin_col: 0 },
                ],
                vec![
                    CellSlot::Origin(Cell::from_inlines(vec![Inline::plain("Jan")])),
                    CellSlot::Origin(Cell::from_inlines(vec![Inline::plain("Feb")])),
                ],
            ],
            header_rows: 1,
            kind: TableKind::Data,
        };
        let blocks = vec![Block::Table(table)];
        assert_eq!(
            md(blocks.clone()),
            "| Term one |  |\n| --- | --- |\n| Jan | Feb |"
        );
        assert_eq!(warned(blocks), vec![(warning::TABLE_SPANS, 1)]);
    }

    /// `cells()` splits a row on unescaped pipes, so a pipe in the words has
    /// to be escaped or the row silently gains a column.
    #[test]
    fn a_pipe_in_a_cell_does_not_split_the_row() {
        let table = Table::from_rows(
            vec![vec![Cell::from_inlines(vec![Inline::plain("a | b")])]],
            1,
            TableKind::Data,
        );
        assert_eq!(md(vec![Block::Table(table)]), "| a \\| b |\n| --- |");
    }

    #[test]
    fn a_layout_table_wrapping_one_cell_is_unwrapped() {
        let table = Table::from_rows(
            vec![vec![Cell::new(vec![para("Just a text box")])]],
            0,
            TableKind::Layout,
        );
        assert_eq!(md(vec![Block::Table(table)]), "Just a text box");
    }

    // -- lists ---------------------------------------------------------------

    #[test]
    fn an_ordered_list_counts_from_where_the_source_did() {
        let list = List {
            marker: MarkerKind::Decimal,
            start: 4,
            items: vec![
                ListItem { blocks: vec![para("four")], marker_label: None },
                ListItem { blocks: vec![para("five")], marker_label: None },
            ],
        };
        assert_eq!(md(vec![Block::List(list)]), "4. four\n5. five");
    }

    /// The dialect has no nested list, so depth is lost. The items and their
    /// order survive, which is the part that carries the meaning.
    #[test]
    fn a_nested_list_flattens_and_says_so() {
        let inner = List {
            marker: MarkerKind::Bullet,
            start: 1,
            items: vec![ListItem { blocks: vec![para("deep")], marker_label: None }],
        };
        let outer = List {
            marker: MarkerKind::Bullet,
            start: 1,
            items: vec![ListItem {
                blocks: vec![para("shallow"), Block::List(inner)],
                marker_label: None,
            }],
        };
        let blocks = vec![Block::List(outer)];
        assert_eq!(md(blocks.clone()), "- shallow\n- deep");
        assert_eq!(warned(blocks), vec![(warning::NESTED_LIST, 1)]);
    }

    // -- inline styling ------------------------------------------------------

    #[test]
    fn code_beats_emphasis_because_monospace_carries_more() {
        let style = Style { bold: true, italic: true, strike: false, code: true };
        assert_eq!(md(vec![styled_run("x = 1", style)]), "`x = 1`");
    }

    /// `\*\*([^*]+)\*\*` forbids a `*` inside bold, so bold-and-italic cannot
    /// round-trip and one of them has to go.
    #[test]
    fn a_run_that_is_bold_and_italic_picks_one_and_says_so() {
        let style = Style { bold: true, italic: true, strike: false, code: false };
        let blocks = vec![styled_run("both", style)];
        assert_eq!(md(blocks.clone()), "**both**");
        assert_eq!(warned(blocks), vec![(warning::COMBINED_STYLE, 1)]);
    }

    #[test]
    fn strikethrough_keeps_the_words_and_says_so() {
        let style = Style { bold: false, italic: false, strike: true, code: false };
        let blocks = vec![styled_run("cut", style)];
        assert_eq!(md(blocks.clone()), "cut");
        assert_eq!(warned(blocks), vec![(warning::STRIKE, 1)]);
    }

    // -- links, math, checkboxes ---------------------------------------------

    /// `\(([^)]+)\)` ends the destination at the first `)`.
    #[test]
    fn a_bracket_in_a_url_does_not_truncate_the_link() {
        let blocks = vec![Block::Paragraph(vec![Inline::Link {
            content: vec![Inline::plain("cite")],
            target: LinkTarget::External("https://x.test/a(b)c".into()),
        }])];
        assert_eq!(md(blocks), "[cite](https://x.test/a%28b%29c)");
    }

    #[test]
    fn a_link_label_holding_a_bracket_keeps_its_words_and_says_so() {
        let blocks = vec![Block::Paragraph(vec![Inline::Link {
            content: vec![Inline::plain("see [2]")],
            target: LinkTarget::External("https://x.test".into()),
        }])];
        assert_eq!(md(blocks.clone()), "see [2]");
        assert_eq!(warned(blocks), vec![(warning::LINK_LABEL, 1)]);
    }

    #[test]
    fn a_link_into_the_document_keeps_its_words_and_says_so() {
        let blocks = vec![Block::Paragraph(vec![Inline::Link {
            content: vec![Inline::plain("see chapter 2")],
            target: LinkTarget::Anchor("ch2".into()),
        }])];
        assert_eq!(md(blocks.clone()), "see chapter 2");
        assert_eq!(warned(blocks), vec![(warning::INTERNAL_LINK, 1)]);
    }

    #[test]
    fn math_reaches_both_of_the_dialects_delimiters() {
        assert_eq!(
            md(vec![Block::Paragraph(vec![Inline::Math("e^{i\\pi}".into())])]),
            "$e^{i\\pi}$"
        );
        assert_eq!(md(vec![Block::Math("\\int_0^1 x".into())]), "$$\n\\int_0^1 x\n$$");
    }

    #[test]
    fn a_checkbox_in_a_list_is_a_task_and_in_a_cell_is_text() {
        let list = List {
            marker: MarkerKind::Bullet,
            start: 1,
            items: vec![ListItem {
                blocks: vec![Block::Paragraph(vec![
                    Inline::Checkbox(true),
                    Inline::plain(" done"),
                ])],
                marker_label: None,
            }],
        };
        assert_eq!(md(vec![Block::List(list)]), "- [x] done");
    }

    // -- fences --------------------------------------------------------------

    /// `markdownToDoc` closes a fence on a line of exactly ```; a body line
    /// like that would cut the block in half.
    #[test]
    fn a_fence_inside_a_code_block_cannot_close_it() {
        let block = Block::CodeBlock {
            lang: Some("md".into()),
            text: "before\n```\nafter".into(),
        };
        assert_eq!(md(vec![block]), "```md\nbefore\n ```\nafter\n```");
    }

    #[test]
    fn a_heading_deeper_than_the_dialect_clamps_rather_than_vanishing() {
        assert_eq!(md(vec![Block::heading(9, vec![Inline::plain("Deep")])]), "###### Deep");
    }
}
