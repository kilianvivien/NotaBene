//! Local document extraction through AnyDoc.
//!
//! AnyDoc's model stays behind this module. The webview receives a small,
//! NotaBene-owned contract so a parser upgrade cannot become an IPC migration.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anydoc::{ConvertError, Format};
use base64::Engine;
use serde::Serialize;

use crate::ocr::OcrPageText;

mod render;

/// Per-asset and whole-document ceilings. Every embedded image crosses IPC as
/// base64, so a deck full of full-bleed photographs is a memory problem before
/// it is a note. Refusing one loudly beats importing nothing.
const MAX_ASSET_BYTES: usize = 16 * 1024 * 1024;
const MAX_ASSET_TOTAL_BYTES: usize = 64 * 1024 * 1024;

/// An image too big to carry on its own.
const W_ASSET_TOO_LARGE: &str = "assetTooLarge";
/// The document's images stopped fitting the whole-document ceiling.
const W_ASSET_BUDGET: &str = "assetBudget";
/// An embedded object that is not a picture -- `Asset` also covers OLE
/// payloads, and a spreadsheet welded into a slide is not an illustration.
const W_ASSET_NOT_IMAGE: &str = "assetNotImage";

/// A page was read and had no text on it. A blank scan is a real answer, not
/// a failure -- but the note is shorter than the PDF, so say why.
const W_OCR_PAGE_EMPTY: &str = "ocrPageEmpty";
/// A page needed reading and no recognised text arrived for it: the student
/// cancelled, or rasterising it failed. Its own text is unreliable by
/// definition, so it is left out rather than emitted as garbage.
const W_OCR_PAGE_MISSING: &str = "ocrPageMissing";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedDocument {
    source: ImportedSource,
    markdown: String,
    assets: Vec<ImportedAsset>,
    metadata: ImportedMetadata,
    diagnostics: ImportDiagnostics,
}

#[derive(Debug, Serialize)]
struct ImportedSource {
    filename: String,
    format: &'static str,
}

#[derive(Debug, Serialize)]
struct ImportedAsset {
    id: String,
    name: String,
    mime: String,
    data: String,
}

#[derive(Debug, Serialize)]
struct ImportedMetadata {
    title: String,
}

/// What the conversion could not carry, as a code and a count.
///
/// Not a sentence: a message built here could only ever be in one language,
/// and every user-facing string has to exist in both. The webview renders
/// these as `import.warning.<code>` with the count.
#[derive(Debug, Serialize)]
struct ImportWarning {
    code: String,
    count: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportDiagnostics {
    parser: &'static str,
    warnings: Vec<ImportWarning>,
    requires_ocr: bool,
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn title(path: &Path) -> String {
    path.file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Imported document")
        .to_string()
}

fn filename(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("document")
        .to_string()
}

fn format_name(format: Format, ext: &str) -> &'static str {
    match format {
        Format::Pdf => "pdf",
        Format::Doc => "doc",
        Format::Docx => "docx",
        Format::Odt => "odt",
        Format::Ppt => "ppt",
        Format::Pptx => "pptx",
        Format::Rtf => "rtf",
        Format::Epub => "epub",
        Format::Excel if matches!(ext, "xls" | "xlsb" | "xlsm") => "xls",
        Format::Excel => "xlsx",
        Format::Ods => "ods",
        Format::Odp => "odp",
        Format::Csv => "csv",
    }
}

/// AnyDoc's typed error, flattened into NotaBene's `code:message` IPC
/// protocol.
///
/// `NeedsOcr` additionally carries its page list as `[1,5,7]/12` before the
/// message, so the webview can offer to read exactly the scanned pages
/// rather than the whole document. Pages are digits, so the prefix stays
/// unambiguous however the human message is punctuated.
fn conversion_error(error: ConvertError) -> String {
    let message = error.to_string();
    match error {
        ConvertError::NeedsOcr { pages, page_count } => {
            let list: Vec<String> = pages.iter().map(u32::to_string).collect();
            format!("ocr_required:[{}]/{page_count}:{message}", list.join(","))
        }
        ConvertError::Unsupported(_) => format!("unsupported_format:{message}"),
        ConvertError::Encrypted => format!("encrypted:{message}"),
        ConvertError::ResourceLimit { .. } => format!("too_large:{message}"),
        ConvertError::MissingPart { .. } => format!("missing_part:{message}"),
        ConvertError::Malformed { .. } => format!("malformed:{message}"),
        ConvertError::Io(_) => format!("read_failed:{message}"),
        // `ConvertError` is #[non_exhaustive]. A variant added upstream must
        // arrive as a plain conversion failure rather than be guessed at.
        _ => format!("conversion_failed:{message}"),
    }
}

/// The embedded images, as far as the byte ceilings allow.
///
/// `id` is the `AssetId` index, which is what `render` writes into the
/// `nb-import-asset:` placeholder; the webview pairs them up, stores the
/// bytes content-addressed, and rewrites the reference to the hash.
fn collect_assets(document: &anydoc::model::Document) -> (Vec<ImportedAsset>, Vec<(&'static str, u32)>) {
    let mut assets = Vec::new();
    let mut too_large = 0u32;
    let mut not_image = 0u32;
    let mut over_budget = 0u32;
    let mut total = 0usize;

    for asset in &document.assets {
        if !asset.media_type.starts_with("image/") {
            not_image += 1;
            continue;
        }
        if asset.bytes.len() > MAX_ASSET_BYTES {
            too_large += 1;
            continue;
        }
        if total.saturating_add(asset.bytes.len()) > MAX_ASSET_TOTAL_BYTES {
            over_budget += 1;
            continue;
        }
        total += asset.bytes.len();
        assets.push(ImportedAsset {
            id: asset.id.0.to_string(),
            name: asset_name(asset),
            mime: asset.media_type.clone(),
            data: base64::engine::general_purpose::STANDARD.encode(&asset.bytes),
        });
    }

    let warnings = [
        (W_ASSET_TOO_LARGE, too_large),
        (W_ASSET_NOT_IMAGE, not_image),
        (W_ASSET_BUDGET, over_budget),
    ]
    .into_iter()
    .filter(|(_, count)| *count > 0)
    .collect();
    (assets, warnings)
}

/// A filename for the attachment list, from the package part the asset came
/// from. `origin_part` is provenance, not a path we resolve.
fn asset_name(asset: &anydoc::model::Asset) -> String {
    asset
        .origin_part
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("image-{}", asset.id.0))
}

fn convert(bytes: Vec<u8>, source_path: PathBuf) -> Result<ImportedDocument, String> {
    let ext = extension(&source_path);
    let mut assets = Vec::new();
    let mut warnings: Vec<(&'static str, u32)> = Vec::new();

    let (markdown, format, parser) = if matches!(ext.as_str(), "txt" | "md" | "markdown") {
        let text = String::from_utf8(bytes)
            .map_err(|_| "conversion_failed:the selected text file is not UTF-8".to_string())?;
        let format = if ext == "txt" { "text" } else { "markdown" };
        (text, format, "plain-text")
    } else {
        let detected = Format::from_bytes(&bytes)
            .or_else(|| Format::from_path(&source_path))
            .ok_or_else(|| "unsupported_format:AnyDoc does not support this file".to_string())?;
        if detected == Format::Pdf {
            // A PDF has no document-model form: AnyDoc converts it straight to
            // Markdown, so there is nothing for `render` to walk and no
            // embedded asset to recover.
            let markdown = anydoc::to_markdown_bytes(&bytes, detected).map_err(conversion_error)?;
            (markdown, format_name(detected, &ext), "anydoc")
        } else {
            let document = anydoc::to_document(&bytes, detected).map_err(conversion_error)?;
            let rendered = render::render(&document);
            let (collected, asset_warnings) = collect_assets(&document);
            assets = collected;
            warnings.extend(rendered.warnings.into_pairs());
            warnings.extend(asset_warnings);
            (rendered.markdown, format_name(detected, &ext), "anydoc")
        }
    };

    if markdown.trim().is_empty() {
        return Err("conversion_failed:the document did not contain extractable text".into());
    }

    Ok(ImportedDocument {
        source: ImportedSource {
            filename: filename(&source_path),
            format,
        },
        markdown,
        assets,
        metadata: ImportedMetadata {
            title: title(&source_path),
        },
        diagnostics: ImportDiagnostics {
            parser,
            warnings: warnings
                .into_iter()
                .map(|(code, count)| ImportWarning { code: code.to_string(), count })
                .collect(),
            requires_ocr: false,
        },
    })
}

/// The result of interleaving read pages with recognised ones.
struct AssembledPages {
    markdown: String,
    /// Pages that were read and had nothing on them.
    empty: u32,
    /// Pages that needed reading and were never read.
    missing: u32,
}

/// Put the recognised text back among the pages that did not need it.
///
/// Pure, and split out from the conversion for one reason: the page numbering
/// is the only place this can go wrong, and it cannot go wrong quietly. A
/// `PageMarkdown` counts from zero while every page number crossing IPC counts
/// from one, so an off-by-one here would silently attach each page's OCR text
/// to its neighbour -- output that still looks like a document.
fn assemble_pages(
    pages: &[pdf_inspector::PageMarkdown],
    recognised: &[OcrPageText],
) -> AssembledPages {
    let text_by_page: BTreeMap<u32, &str> = recognised
        .iter()
        .map(|page| (page.page, page.text.trim()))
        .collect();

    let mut parts: Vec<&str> = Vec::with_capacity(pages.len());
    let mut empty = 0u32;
    let mut missing = 0u32;

    for page in pages {
        match text_by_page.get(&(page.page + 1)) {
            Some(text) if !text.is_empty() => parts.push(text),
            Some(_) => empty += 1,
            // A page AnyDoc flagged and nobody read: the student cancelled, or
            // rasterising it failed. Its own extracted text is unreliable by
            // definition -- that is what flagged it -- so it is left out
            // rather than emitted as garbage that reads like content.
            None if page.needs_ocr => missing += 1,
            None => {
                let markdown = page.markdown.trim();
                if !markdown.is_empty() {
                    parts.push(markdown);
                }
            }
        }
    }

    AssembledPages {
        markdown: parts.join("\n\n"),
        empty,
        missing,
    }
}

/// A PDF the webview has since read the scanned pages of.
///
/// AnyDoc cannot help here: a PDF has no document-model form, and one scanned
/// page makes it refuse the whole file rather than return text with a silent
/// hole in it. So this goes to the same parser AnyDoc uses, one page at a
/// time, and puts the recognised text back where those pages were.
///
/// Page numbering is the trap. `ConvertError::NeedsOcr` and
/// `PagesExtractionResult::pages_needing_ocr` are 1-indexed; `PageMarkdown.page`
/// and the extraction filter are 0-indexed. The conversion happens here, once.
fn convert_pdf_with_ocr(
    bytes: Vec<u8>,
    source_path: PathBuf,
    recognised: Vec<OcrPageText>,
) -> Result<ImportedDocument, String> {
    let extraction = pdf_inspector::extract_pages_markdown_mem(&bytes, None)
        .map_err(|error| format!("malformed:the PDF could not be read page by page: {error}"))?;

    let assembled = assemble_pages(&extraction.pages, &recognised);
    let markdown = assembled.markdown;
    let (empty, missing) = (assembled.empty, assembled.missing);
    if markdown.trim().is_empty() {
        return Err("conversion_failed:no text could be read from this PDF".into());
    }

    let warnings = [(W_OCR_PAGE_EMPTY, empty), (W_OCR_PAGE_MISSING, missing)]
        .into_iter()
        .filter(|(_, count)| *count > 0)
        .map(|(code, count)| ImportWarning {
            code: code.to_string(),
            count,
        })
        .collect();

    Ok(ImportedDocument {
        source: ImportedSource {
            filename: filename(&source_path),
            format: "pdf",
        },
        markdown,
        assets: Vec::new(),
        metadata: ImportedMetadata {
            title: title(&source_path),
        },
        diagnostics: ImportDiagnostics {
            parser: "ocr",
            warnings,
            requires_ocr: false,
        },
    })
}

#[tauri::command]
pub async fn document_import_bytes(
    data: String,
    filename: String,
) -> Result<ImportedDocument, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|error| format!("read_failed:invalid document data: {error}"))?;
        convert(bytes, PathBuf::from(filename))
    })
    .await
    .map_err(|error| format!("conversion_failed:{error}"))?
}

/// Re-convert a PDF with the scanned pages already read.
///
/// Separate from `document_import_bytes` rather than a flag on it: this one
/// can only be reached after an `ocr_required` failure the student answered,
/// and folding it in would put an optional page list on every import.
#[tauri::command]
pub async fn document_import_pdf_ocr(
    data: String,
    filename: String,
    pages: Vec<OcrPageText>,
) -> Result<ImportedDocument, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|error| format!("read_failed:invalid document data: {error}"))?;
        convert_pdf_with_ocr(bytes, PathBuf::from(filename), pages)
    })
    .await
    .map_err(|error| format!("conversion_failed:{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_plain_markdown_without_anydoc() {
        let imported = convert(b"# Week four\n\nNotes".to_vec(), "week-four.md".into()).unwrap();
        assert_eq!(imported.source.format, "markdown");
        assert_eq!(imported.metadata.title, "week-four");
        assert_eq!(imported.diagnostics.parser, "plain-text");
    }

    #[test]
    fn imports_signatureless_csv_by_extension() {
        let imported =
            convert(b"year,event\n1789,revolution".to_vec(), "dates.csv".into()).unwrap();
        assert_eq!(imported.source.format, "csv");
        assert!(imported.markdown.contains("1789"));
        assert_eq!(imported.diagnostics.parser, "anydoc");
    }

    #[test]
    fn names_the_scanned_pages_so_only_those_are_read() {
        let error = conversion_error(ConvertError::NeedsOcr {
            pages: vec![1, 5, 7],
            page_count: 12,
        });
        assert!(error.starts_with("ocr_required:[1,5,7]/12:"), "{error}");
    }

    #[test]
    fn names_an_empty_page_list_without_collapsing_the_shape() {
        // The webview parses the brackets before the count; an empty list must
        // still parse rather than fall through to the untyped branch.
        let error = conversion_error(ConvertError::NeedsOcr {
            pages: Vec::new(),
            page_count: 3,
        });
        assert!(error.starts_with("ocr_required:[]/3:"), "{error}");
    }

    #[test]
    fn separates_the_failures_that_used_to_be_one_message() {
        assert!(conversion_error(ConvertError::Encrypted).starts_with("encrypted:"));
        assert!(
            conversion_error(ConvertError::ResourceLimit {
                limit: "asset_total_bytes",
                detail: "exceeded".into(),
            })
            .starts_with("too_large:")
        );
        assert!(
            conversion_error(ConvertError::MissingPart { part: "word/document.xml".into() })
                .starts_with("missing_part:")
        );
        assert!(
            conversion_error(ConvertError::Malformed { part: None, detail: "torn".into() })
                .starts_with("malformed:")
        );
        assert!(
            conversion_error(ConvertError::Unsupported("nope".into()))
                .starts_with("unsupported_format:")
        );
    }

    fn page(index: u32, markdown: &str, needs_ocr: bool) -> pdf_inspector::PageMarkdown {
        pdf_inspector::PageMarkdown {
            page: index,
            markdown: markdown.into(),
            needs_ocr,
            ocr_reason: None,
        }
    }

    fn read(page: u32, text: &str) -> OcrPageText {
        OcrPageText {
            page,
            text: text.into(),
        }
    }

    #[test]
    fn puts_a_recognised_page_back_where_it_came_from() {
        // The one number that matters: pdf-inspector counts pages from zero,
        // the OCR payload counts from one. Page index 1 is page number 2.
        let assembled = assemble_pages(
            &[
                page(0, "First page", false),
                page(1, "", true),
                page(2, "Third page", false),
            ],
            &[read(2, "Scanned middle")],
        );
        assert_eq!(assembled.markdown, "First page\n\nScanned middle\n\nThird page");
        assert_eq!(assembled.empty, 0);
        assert_eq!(assembled.missing, 0);
    }

    #[test]
    fn never_shifts_recognised_text_onto_a_neighbouring_page() {
        // The failure this guards is an off-by-one that still produces a
        // plausible-looking document, so assert the whole order rather than
        // that the text is merely present somewhere.
        let assembled = assemble_pages(
            &[page(0, "", true), page(1, "Readable", false)],
            &[read(1, "Scanned first")],
        );
        assert_eq!(assembled.markdown, "Scanned first\n\nReadable");
    }

    #[test]
    fn counts_a_page_that_was_read_and_had_nothing_on_it() {
        let assembled = assemble_pages(
            &[page(0, "Text", false), page(1, "", true)],
            &[read(2, "   ")],
        );
        assert_eq!(assembled.markdown, "Text");
        assert_eq!(assembled.empty, 1);
        assert_eq!(assembled.missing, 0);
    }

    #[test]
    fn leaves_out_an_unread_scanned_page_rather_than_emitting_its_garbage() {
        // A flagged page's own extraction is unreliable by definition -- that
        // is what flagged it. Cancelling halfway must shorten the note, not
        // fill it with mojibake.
        let assembled = assemble_pages(
            &[page(0, "Real text", false), page(1, "\u{fffd}\u{fffd}\u{fffd}", true)],
            &[],
        );
        assert_eq!(assembled.markdown, "Real text");
        assert_eq!(assembled.missing, 1);
    }

    #[test]
    fn keeps_the_readable_pages_a_scanned_one_would_otherwise_have_cost() {
        // The reason this path exists at all: AnyDoc refuses the whole PDF
        // over one scanned page, so without this the other pages are lost.
        let pages: Vec<_> = (0..10)
            .map(|index| page(index, &format!("Page {}", index + 1), index == 4))
            .collect();
        let assembled = assemble_pages(&pages, &[read(5, "Scanned")]);
        assert_eq!(assembled.markdown.matches("Page ").count(), 9);
        assert!(assembled.markdown.contains("Page 4\n\nScanned\n\nPage 6"));
    }

    /// The whole seam, against a real PDF: refusal names the scanned page,
    /// and converting again with that page's text keeps the readable one.
    /// `NB_PDF_PROBE=/path/to/mixed.pdf cargo test -- --ignored --nocapture`
    #[test]
    #[ignore = "needs NB_PDF_PROBE pointing at a mixed text/scanned PDF"]
    fn probe_reads_a_mixed_pdf() {
        let path = std::env::var("NB_PDF_PROBE").expect("NB_PDF_PROBE");
        let bytes = std::fs::read(&path).expect("fixture");

        let refusal = convert(bytes.clone(), path.clone().into()).unwrap_err();
        println!("refusal: {refusal}");
        assert!(refusal.starts_with("ocr_required:"), "{refusal}");

        let imported = convert_pdf_with_ocr(
            bytes,
            path.into(),
            vec![OcrPageText {
                page: 2,
                text: "Damping and Resonance".into(),
            }],
        )
        .unwrap();
        println!("parser={} markdown:\n{}", imported.diagnostics.parser, imported.markdown);
        assert!(imported.markdown.contains("Oscillations"), "lost the readable page");
        assert!(imported.markdown.contains("Damping"), "lost the scanned page");
    }

    #[test]
    fn keeps_the_human_message_after_the_code() {
        let error = conversion_error(ConvertError::Encrypted);
        assert!(error.contains("document is encrypted"), "{error}");
    }
}

