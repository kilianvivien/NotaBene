//! Text recognition through Apple's Vision framework.
//!
//! Vision ships with macOS, runs on the Neural Engine, and needs no model
//! download, no entitlement and no network. That is the whole reason it is
//! here rather than a bundled OCR engine: a student importing a scanned
//! lecture handout should not be told to download 200 MB first, and nothing
//! about reading their handout should leave the Mac.
//!
//! The alternative was a Swift helper binary, which would have to be built,
//! bundled and signed -- and signing is parked (plan §12). `objc2` costs an
//! Objective-C bridge in a codebase that otherwise has none; it buys not
//! shipping a second binary.
//!
//! Vision returns *lines* with normalised bounding boxes, not paragraphs. We
//! sort them into reading order and join them; we deliberately do not attempt
//! column detection (see `sort_reading_order`).
//!
//! One trap, found the hard way and guarded below: an image with an alpha
//! channel makes `VNImageRequestHandler`'s data initialiser return *no
//! observations and no error*. A legible page reads as blank. That is the
//! default output of a `<canvas>`, so the rasteriser sends JPEG and
//! `reject_alpha` refuses anything else -- a wrong answer this quiet has to
//! become a loud one.

use objc2::rc::Retained;
use objc2::AnyThread;
use objc2_foundation::{NSArray, NSData, NSDictionary, NSString};
use objc2_vision::{
    VNImageRequestHandler, VNRecognizeTextRequest, VNRecognizedTextObservation, VNRequest,
    VNRequestTextRecognitionLevel,
};

use super::{OcrLine, OcrPage};

/// Candidates to ask Vision for per line. We keep only the best one; asking
/// for one is what tells Vision it may stop ranking the rest.
const TOP_CANDIDATES: usize = 1;

/// Vision is available whenever the framework loads, which on any macOS
/// NotaBene supports is always. The check exists so the webview can disable
/// the offer rather than fail at the moment the student presses it.
pub fn available() -> bool {
    // Constructing the request is the honest probe: it exercises the same
    // class loading a real run does, and costs nothing.
    let request = VNRecognizeTextRequest::new();
    drop(request);
    true
}

/// The language identifiers this machine can recognise, best first.
///
/// Surfaced rather than assumed: Vision reads a French page badly under an
/// English-only configuration, and the recognition languages are the only
/// thing that fixes it.
pub fn languages() -> Result<Vec<String>, String> {
    let request = VNRecognizeTextRequest::new();
    request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
    let supported = unsafe { request.supportedRecognitionLanguagesAndReturnError() }
        .map_err(|error| format!("ocr_failed:Vision could not list its languages: {error}"))?;
    Ok(supported.iter().map(|value| value.to_string()).collect())
}

/// Refuse an image Vision would silently read as blank.
///
/// Only PNG is checked, because only PNG can carry alpha among the formats a
/// canvas produces. Byte 25 of a PNG is the IHDR colour type: 4 is
/// grey+alpha and 6 is RGBA. Anything shorter than a header is left to Vision
/// to reject, which it does properly.
fn reject_alpha(image: &[u8]) -> Result<(), String> {
    const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    const COLOUR_TYPE: usize = 25;
    if image.starts_with(PNG_SIGNATURE)
        && matches!(image.get(COLOUR_TYPE), Some(4) | Some(6))
    {
        return Err(
            "ocr_failed:the page image has an alpha channel, which Vision reads as blank"
                .to_string(),
        );
    }
    Ok(())
}

/// Read one rasterised page.
///
/// `image` is encoded image bytes (PNG, from the webview's canvas). Vision
/// decodes it through Core Image, so the format list is Core Image's rather
/// than ours.
pub fn recognize(image: &[u8], languages: &[String]) -> Result<OcrPage, String> {
    reject_alpha(image)?;
    let request = VNRecognizeTextRequest::new();

    // Accurate rather than Fast: this runs once per page on a document the
    // student is waiting for, and a misread word costs them more than the
    // second it saves. `usesLanguageCorrection` is what turns Vision's
    // per-glyph guesses into words.
    request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
    request.setUsesLanguageCorrection(true);

    if languages.is_empty() {
        // No explicit choice: let Vision decide from the page itself rather
        // than silently imposing the system language on a foreign document.
        request.setAutomaticallyDetectsLanguage(true);
    } else {
        let identifiers: Vec<Retained<NSString>> =
            languages.iter().map(|value| NSString::from_str(value)).collect();
        request.setRecognitionLanguages(&NSArray::from_retained_slice(&identifiers));
    }

    let data = NSData::with_bytes(image);
    let options: Retained<NSDictionary<_, _>> = NSDictionary::new();
    let handler =
        VNImageRequestHandler::initWithData_options(VNImageRequestHandler::alloc(), &data, &options);

    // Two steps up the hierarchy: VNRecognizeTextRequest -> VNImageBasedRequest
    // -> VNRequest, which is what `performRequests:` takes.
    let requests: Vec<Retained<VNRequest>> =
        vec![Retained::into_super(Retained::into_super(request.clone()))];
    handler
        .performRequests_error(&NSArray::from_retained_slice(&requests))
        .map_err(|error| format!("ocr_failed:{error}"))?;

    let Some(results) = request.results() else {
        return Ok(OcrPage::default());
    };

    let mut lines: Vec<OcrLine> = Vec::with_capacity(results.len());
    for observation in results.iter() {
        if let Some(line) = read_line(&observation) {
            lines.push(line);
        }
    }
    Ok(assemble(lines))
}

/// One observation, as text plus where it sat on the page.
fn read_line(observation: &VNRecognizedTextObservation) -> Option<OcrLine> {
    let candidates = observation.topCandidates(TOP_CANDIDATES);
    let best = candidates.firstObject()?;
    let text = best.string().to_string();
    if text.trim().is_empty() {
        return None;
    }
    // Normalised, origin at the *lower* left -- so a larger `y` is higher up
    // the page, which is why reading order sorts on it descending.
    let box_ = unsafe { observation.boundingBox() };
    Some(OcrLine {
        text,
        confidence: best.confidence(),
        x: box_.origin.x,
        y: box_.origin.y,
    })
}

/// Lines into reading order and then into one page of text.
fn assemble(mut lines: Vec<OcrLine>) -> OcrPage {
    sort_reading_order(&mut lines);
    let confidence = if lines.is_empty() {
        0.0
    } else {
        lines.iter().map(|line| line.confidence).sum::<f32>() / lines.len() as f32
    };
    let text = lines
        .iter()
        .map(|line| line.text.trim())
        .collect::<Vec<_>>()
        .join("\n");
    OcrPage {
        text,
        lines: lines.len() as u32,
        confidence,
    }
}

/// Top-to-bottom, then left-to-right.
///
/// Deliberately *not* column detection. A two-column page will interleave its
/// columns under this rule, and that is a known limitation rather than an
/// oversight: guessing column boundaries from line boxes is its own project,
/// and guessing wrong scrambles a page that would otherwise merely be in an
/// odd order. Reading order for the single-column scans this feature exists
/// for is exactly this.
fn sort_reading_order(lines: &mut [OcrLine]) {
    lines.sort_by(|a, b| {
        b.y.partial_cmp(&a.y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(text: &str, x: f64, y: f64) -> OcrLine {
        OcrLine {
            text: text.into(),
            confidence: 1.0,
            x,
            y,
        }
    }

    #[test]
    fn reads_down_the_page_not_up_it() {
        // Vision's origin is the lower left, so the *largest* y is the first
        // line. Getting this backwards reverses every page it reads.
        let page = assemble(vec![
            line("second", 0.1, 0.5),
            line("first", 0.1, 0.9),
            line("third", 0.1, 0.1),
        ]);
        assert_eq!(page.text, "first\nsecond\nthird");
        assert_eq!(page.lines, 3);
    }

    #[test]
    fn orders_a_shared_baseline_left_to_right() {
        let page = assemble(vec![line("right", 0.8, 0.5), line("left", 0.1, 0.5)]);
        assert_eq!(page.text, "left\nright");
    }

    #[test]
    fn reports_an_empty_page_rather_than_inventing_confidence() {
        let page = assemble(Vec::new());
        assert_eq!(page.text, "");
        assert_eq!(page.lines, 0);
        assert_eq!(page.confidence, 0.0);
    }

    #[test]
    fn refuses_an_image_vision_would_read_as_blank() {
        // Colour type 6 is RGBA. Vision returns zero observations for it and
        // reports no error, so a legible page arrives as an empty one -- the
        // exact failure this guard exists to make loud.
        let mut rgba = b"\x89PNG\r\n\x1a\n".to_vec();
        rgba.resize(26, 0);
        rgba[25] = 6;
        assert!(reject_alpha(&rgba).is_err());

        let mut grey_alpha = rgba.clone();
        grey_alpha[25] = 4;
        assert!(reject_alpha(&grey_alpha).is_err());
    }

    #[test]
    fn passes_the_formats_vision_actually_reads() {
        let mut rgb = b"\x89PNG\r\n\x1a\n".to_vec();
        rgb.resize(26, 0);
        rgb[25] = 2;
        assert!(reject_alpha(&rgb).is_ok());
        // JPEG carries no alpha at all, and is what the rasteriser sends.
        assert!(reject_alpha(b"\xff\xd8\xff\xe0").is_ok());
        // Too short to classify: Vision rejects it properly on its own.
        assert!(reject_alpha(b"\x89PNG").is_ok());
    }

    /// Vision itself, against a real rendered page. Ignored by default: it
    /// needs the framework and a fixture, so it is a probe you run rather
    /// than a unit test. `NB_OCR_PROBE=/path/to/page.png cargo test -- --ignored`
    #[test]
    #[ignore = "needs NB_OCR_PROBE pointing at a rendered page image"]
    fn reads_a_rendered_page() {
        let path = std::env::var("NB_OCR_PROBE").expect("NB_OCR_PROBE");
        let bytes = std::fs::read(path).expect("fixture");
        let langs: Vec<String> = std::env::var("NB_OCR_LANG")
            .map(|v| v.split(',').map(str::to_string).collect())
            .unwrap_or_default();
        let page = recognize(&bytes, &langs).expect("recognition");
        println!("lines={} confidence={:.3}", page.lines, page.confidence);
        println!("---\n{}\n---", page.text);
        assert!(page.lines > 0);
    }

    #[test]
    fn averages_confidence_across_lines() {
        let mut lines = vec![line("a", 0.0, 0.9), line("b", 0.0, 0.1)];
        lines[0].confidence = 0.5;
        lines[1].confidence = 1.0;
        assert!((assemble(lines).confidence - 0.75).abs() < f32::EPSILON);
    }
}
