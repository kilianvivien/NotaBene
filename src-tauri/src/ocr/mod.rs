//! On-device text recognition, exposed to the webview.
//!
//! This is the second half of importing a scanned PDF. AnyDoc refuses a
//! document with scanned pages outright -- naming them, but returning no text
//! at all, because "output missing those pages would read as complete". So the
//! webview rasterises the named pages, sends them here one at a time, and
//! `document_import::document_import_pdf_ocr` puts the recognised text back
//! among the pages AnyDoc could read.
//!
//! One page per call, on purpose. Recognition is N short operations rather
//! than one long opaque one, so a plain loop in the webview gives an exact
//! `page of total` count and cancellation for free -- it just stops calling.
//! Nothing here holds state between pages.
//!
//! Every command is `async` over `spawn_blocking`. A synchronous Tauri command
//! runs on the main thread, and Vision on a full page takes long enough that
//! the window would stop drawing (the same lesson as `tts/system.rs`).

use serde::{Deserialize, Serialize};

#[cfg(target_os = "macos")]
mod vision;

/// One recognised line, before it is joined into a page. Internal to the
/// backend: the webview receives assembled page text, not line geometry.
#[cfg(target_os = "macos")]
#[derive(Debug, Clone)]
struct OcrLine {
    text: String,
    confidence: f32,
    /// Normalised to the page, origin at the lower left.
    x: f64,
    y: f64,
}

/// What one page came back as.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrPage {
    text: String,
    /// How many lines were recognised. Zero is a real answer -- a blank scan
    /// or a photograph of something that is not text -- and the webview says
    /// so rather than reporting a failure that did not happen.
    lines: u32,
    /// Mean confidence across the lines, 0..1.
    confidence: f32,
}

/// Recognised text for one page, on its way back to the PDF assembler.
///
/// `page` is 1-indexed, matching how `ConvertError::NeedsOcr` names pages.
/// The conversion to pdf-inspector's 0-indexed pages happens once, in
/// `document_import`, rather than at every boundary that touches a page
/// number.
#[derive(Debug, Clone, Deserialize)]
pub struct OcrPageText {
    pub page: u32,
    pub text: String,
}

#[tauri::command]
pub async fn ocr_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(vision::available)
            .await
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[tauri::command]
pub async fn ocr_languages() -> Result<Vec<String>, String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(vision::languages)
            .await
            .map_err(|error| format!("ocr_failed:{error}"))?
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(unsupported())
    }
}

#[tauri::command]
pub async fn ocr_recognize_page(
    #[allow(unused_variables)] data: String,
    #[allow(unused_variables)] languages: Vec<String>,
) -> Result<OcrPage, String> {
    #[cfg(target_os = "macos")]
    {
        use base64::Engine;
        tauri::async_runtime::spawn_blocking(move || {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|error| format!("read_failed:invalid page image: {error}"))?;
            vision::recognize(&bytes, &languages)
        })
        .await
        .map_err(|error| format!("ocr_failed:{error}"))?
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(unsupported())
    }
}

/// Fail loudly rather than returning empty text: an empty page and a platform
/// that cannot read pages are different answers, and only one of them means
/// the document had nothing on it.
#[cfg(not(target_os = "macos"))]
fn unsupported() -> String {
    "not_supported:text recognition needs macOS".to_string()
}
