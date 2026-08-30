//! Local document extraction through AnyDoc.
//!
//! AnyDoc's model stays behind this module. The webview receives a small,
//! NotaBene-owned contract so a parser upgrade cannot become an IPC migration.

use std::path::{Path, PathBuf};

use anydoc::{ConvertError, Format};
use base64::Engine;
use serde::Serialize;

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

    #[test]
    fn keeps_the_human_message_after_the_code() {
        let error = conversion_error(ConvertError::Encrypted);
        assert!(error.contains("document is encrypted"), "{error}");
    }
}

