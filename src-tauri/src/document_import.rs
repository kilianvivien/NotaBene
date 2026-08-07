//! Local document extraction through AnyDoc.
//!
//! AnyDoc's model stays behind this module. The webview receives a small,
//! NotaBene-owned contract so a parser upgrade cannot become an IPC migration.

use std::path::{Path, PathBuf};

use anydoc::{ConvertError, Format};
use base64::Engine;
use serde::Serialize;

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportDiagnostics {
    parser: &'static str,
    warnings: Vec<String>,
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

fn conversion_error(error: ConvertError) -> String {
    let message = error.to_string();
    if message.to_ascii_lowercase().contains("ocr is required") {
        format!("ocr_required:{message}")
    } else {
        format!("conversion_failed:{message}")
    }
}

fn convert(bytes: Vec<u8>, source_path: PathBuf) -> Result<ImportedDocument, String> {
    let ext = extension(&source_path);
    let (markdown, format, parser) = if matches!(ext.as_str(), "txt" | "md" | "markdown") {
        let text = String::from_utf8(bytes)
            .map_err(|_| "conversion_failed:the selected text file is not UTF-8".to_string())?;
        let format = if ext == "txt" { "text" } else { "markdown" };
        (text, format, "plain-text")
    } else {
        let detected = Format::from_bytes(&bytes)
            .or_else(|| Format::from_path(&source_path))
            .ok_or_else(|| "unsupported_format:AnyDoc does not support this file".to_string())?;
        let markdown = anydoc::to_markdown_bytes(&bytes, detected).map_err(conversion_error)?;
        (markdown, format_name(detected, &ext), "anydoc")
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
        // AnyDoc 0.1.7 keeps assets in `Document`, but its public Markdown API
        // does not expose the serializer for that model. Keep the stable field
        // now; asset extraction can fill it without changing this IPC shape.
        assets: Vec::new(),
        metadata: ImportedMetadata {
            title: title(&source_path),
        },
        diagnostics: ImportDiagnostics {
            parser,
            warnings: Vec::new(),
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
}
