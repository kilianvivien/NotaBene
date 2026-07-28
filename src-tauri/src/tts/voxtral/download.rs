use super::manifest::{ModelFile, ModelManifest};
use futures_util::StreamExt;
use reqwest::header::{CONTENT_RANGE, RANGE};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::io::AsyncWriteExt;

const REQUIRED_FREE_BYTES: u64 = 6 * 1024 * 1024 * 1024;

pub async fn install(
    manifest: &ModelManifest,
    root: &Path,
    cancelled: &AtomicBool,
    progress: impl Fn(u64, u64),
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(root).map_err(|error| format!("TTS_MODEL_CORRUPT: {error}"))?;
    let free =
        fs2::available_space(root).map_err(|error| format!("TTS_INSUFFICIENT_DISK: {error}"))?;
    if free < REQUIRED_FREE_BYTES {
        return Err("TTS_INSUFFICIENT_DISK: at least 6 GB free is required".into());
    }

    let final_dir = root.join(&manifest.revision);
    if installed_manifest_matches(&final_dir, manifest) {
        return Ok(final_dir);
    }
    let staging = root.join(format!("{}.staging", manifest.revision));
    std::fs::create_dir_all(&staging).map_err(|error| format!("TTS_MODEL_CORRUPT: {error}"))?;

    let total = manifest.total_bytes();
    let mut completed = 0;
    for file in &manifest.files {
        if cancelled.load(Ordering::Relaxed) {
            return Err("TTS_DOWNLOAD_CANCELLED: download cancelled".into());
        }
        let destination = staging.join(&file.path);
        ensure_child(&staging, &destination)?;
        if verified_file(&destination, file)? {
            completed += file.size_bytes;
            progress(completed, total);
            continue;
        }
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("TTS_MODEL_CORRUPT: {error}"))?;
        }
        let partial = destination.with_extension(format!(
            "{}partial",
            destination
                .extension()
                .map(|ext| format!("{}.", ext.to_string_lossy()))
                .unwrap_or_default()
        ));
        download_file(manifest, file, &partial, cancelled, |file_bytes| {
            progress(completed + file_bytes, total)
        })
        .await?;
        verify_file(&partial, file)?;
        if file.path.ends_with(".safetensors") {
            validate_safetensors(&partial)?;
        }
        std::fs::rename(&partial, &destination)
            .map_err(|error| format!("TTS_MODEL_CORRUPT: {error}"))?;
        completed += file.size_bytes;
        progress(completed, total);
    }

    let installed_manifest =
        serde_json::to_vec_pretty(manifest).map_err(|error| error.to_string())?;
    std::fs::write(staging.join("manifest.json"), installed_manifest)
        .map_err(|error| format!("TTS_MODEL_CORRUPT: {error}"))?;
    if final_dir.exists() {
        return if installed_manifest_matches(&final_dir, manifest) {
            Ok(final_dir)
        } else {
            Err("TTS_MODEL_CORRUPT: target revision already exists".into())
        };
    }
    std::fs::rename(&staging, &final_dir)
        .map_err(|error| format!("TTS_MODEL_CORRUPT: activation failed: {error}"))?;
    Ok(final_dir)
}

/// Hugging Face serves the weights over HTTPS, so the crypto provider has to be
/// in place first — `reqwest` panics rather than errors without one.
fn http_client() -> Result<reqwest::Client, String> {
    crate::tls::ensure_provider();
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|error| format!("TTS_DOWNLOAD_NETWORK: {error}"))
}

async fn download_file(
    manifest: &ModelManifest,
    file: &ModelFile,
    partial: &Path,
    cancelled: &AtomicBool,
    progress: impl Fn(u64),
) -> Result<(), String> {
    let existing = std::fs::metadata(partial)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let existing = existing.min(file.size_bytes);
    let client = http_client()?;
    let mut request = client.get(manifest.url(file));
    if existing > 0 {
        request = request.header(RANGE, format!("bytes={existing}-"));
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("TTS_DOWNLOAD_NETWORK: {error}"))?;
    let resumed = existing > 0
        && response.status() == reqwest::StatusCode::PARTIAL_CONTENT
        && response
            .headers()
            .get(CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value.starts_with(&format!("bytes {existing}-"))
                    && value.ends_with(&format!("/{}", file.size_bytes))
            });
    if !response.status().is_success() {
        return Err(format!(
            "TTS_DOWNLOAD_NETWORK: server returned {}",
            response.status()
        ));
    }
    let mut output = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resumed)
        .truncate(!resumed)
        .open(partial)
        .await
        .map_err(|error| format!("TTS_MODEL_CORRUPT: {error}"))?;
    let mut downloaded = if resumed { existing } else { 0 };
    progress(downloaded);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancelled.load(Ordering::Relaxed) {
            return Err("TTS_DOWNLOAD_CANCELLED: download cancelled".into());
        }
        let chunk = chunk.map_err(|error| format!("TTS_DOWNLOAD_NETWORK: {error}"))?;
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > file.size_bytes {
            return Err("TTS_MODEL_CORRUPT: server sent too many bytes".into());
        }
        output
            .write_all(&chunk)
            .await
            .map_err(|error| format!("TTS_MODEL_CORRUPT: {error}"))?;
        progress(downloaded);
    }
    output
        .flush()
        .await
        .map_err(|error| format!("TTS_MODEL_CORRUPT: {error}"))?;
    if downloaded != file.size_bytes {
        return Err(format!(
            "TTS_DOWNLOAD_NETWORK: expected {} bytes, received {downloaded}",
            file.size_bytes
        ));
    }
    Ok(())
}

fn sha256(path: &Path) -> Result<(u64, String), String> {
    let mut input = File::open(path).map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    let mut length = 0;
    loop {
        let read = input.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        length += read as u64;
        hash.update(&buffer[..read]);
    }
    Ok((length, format!("{:x}", hash.finalize())))
}

fn verify_file(path: &Path, expected: &ModelFile) -> Result<(), String> {
    let (length, digest) = sha256(path).map_err(|error| format!("TTS_MODEL_CHECKSUM: {error}"))?;
    if length != expected.size_bytes || digest != expected.sha256 {
        return Err(format!(
            "TTS_MODEL_CHECKSUM: {} failed length or SHA-256 verification",
            expected.path
        ));
    }
    Ok(())
}

fn verified_file(path: &Path, expected: &ModelFile) -> Result<bool, String> {
    if !path.is_file() {
        return Ok(false);
    }
    match verify_file(path, expected) {
        Ok(()) => Ok(true),
        Err(_) => {
            std::fs::remove_file(path).map_err(|error| format!("TTS_MODEL_CORRUPT: {error}"))?;
            Ok(false)
        }
    }
}

fn validate_safetensors(path: &Path) -> Result<(), String> {
    let mut input = File::open(path).map_err(|error| format!("TTS_MODEL_CORRUPT: {error}"))?;
    let mut header_size = [0u8; 8];
    input
        .read_exact(&mut header_size)
        .map_err(|_| "TTS_MODEL_CORRUPT: truncated safetensors header".to_string())?;
    let header_size = u64::from_le_bytes(header_size);
    if header_size == 0 || header_size > 100 * 1024 * 1024 {
        return Err("TTS_MODEL_CORRUPT: invalid safetensors header size".into());
    }
    let file_size = input
        .metadata()
        .map_err(|error| format!("TTS_MODEL_CORRUPT: {error}"))?
        .len();
    if header_size + 8 >= file_size {
        return Err("TTS_MODEL_CORRUPT: safetensors has no tensor data".into());
    }
    let mut header = vec![0u8; header_size as usize];
    input
        .read_exact(&mut header)
        .map_err(|_| "TTS_MODEL_CORRUPT: truncated safetensors metadata".to_string())?;
    let metadata: serde_json::Value = serde_json::from_slice(&header)
        .map_err(|_| "TTS_MODEL_CORRUPT: invalid safetensors metadata".to_string())?;
    if !metadata.is_object() {
        return Err("TTS_MODEL_CORRUPT: invalid safetensors metadata".into());
    }
    Ok(())
}

fn ensure_child(root: &Path, target: &Path) -> Result<(), String> {
    if !target.starts_with(root) {
        return Err("TTS_MODEL_CORRUPT: model path escaped its root".into());
    }
    Ok(())
}

fn installed_manifest_matches(directory: &Path, expected: &ModelManifest) -> bool {
    let Ok(bytes) = std::fs::read(directory.join("manifest.json")) else {
        return false;
    };
    let Ok(actual) = serde_json::from_slice::<ModelManifest>(&bytes) else {
        return false;
    };
    actual.revision == expected.revision
        && actual.model_id == expected.model_id
        && actual.files.len() == expected.files.len()
}

pub fn remove_installed(root: &Path, manifest: &ModelManifest) -> Result<(), String> {
    let target = root.join(&manifest.revision);
    if !target.exists() {
        return Ok(());
    }
    let canonical_root =
        std::fs::canonicalize(root).map_err(|error| format!("TTS_MODEL_CORRUPT: {error}"))?;
    let canonical_target =
        std::fs::canonicalize(&target).map_err(|error| format!("TTS_MODEL_CORRUPT: {error}"))?;
    if canonical_target.parent() != Some(canonical_root.as_path()) {
        return Err("TTS_MODEL_CORRUPT: refused unsafe model removal".into());
    }
    std::fs::remove_dir_all(canonical_target).map_err(|error| format!("TTS_MODEL_CORRUPT: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safetensors_rejects_an_empty_file() {
        let path = std::env::temp_dir().join(format!(
            "notabene-invalid-safetensors-{}",
            std::process::id()
        ));
        std::fs::write(&path, []).unwrap();
        assert!(validate_safetensors(&path).is_err());
        let _ = std::fs::remove_file(path);
    }

    /// `reqwest` is compiled with `rustls-no-provider`, so building a client
    /// without a crypto provider panics rather than erroring — which is how the
    /// download task once died leaving the UI at 0%.
    #[test]
    fn client_builds_once_the_crypto_provider_is_installed() {
        crate::tls::ensure_provider();
        assert!(http_client().is_ok());
    }

    #[test]
    fn child_check_rejects_a_sibling() {
        assert!(ensure_child(Path::new("/safe/root"), Path::new("/safe/other")).is_err());
    }
}
