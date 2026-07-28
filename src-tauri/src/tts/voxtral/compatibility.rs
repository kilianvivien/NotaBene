use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Compatibility {
    Supported,
    Unsupported { code: &'static str, reason: String },
}

pub fn detect() -> Compatibility {
    if !cfg!(target_os = "macos") {
        return Compatibility::Unsupported {
            code: "TTS_UNSUPPORTED_OS",
            reason: "Local Voxtral is available only on macOS.".into(),
        };
    }
    if std::env::consts::ARCH != "aarch64" {
        return Compatibility::Unsupported {
            code: "TTS_UNSUPPORTED_ARCH",
            reason: "Local Voxtral requires an Apple Silicon Mac.".into(),
        };
    }
    let version = Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .unwrap_or_default();
    let major = version
        .trim()
        .split('.')
        .next()
        .and_then(|part| part.parse::<u32>().ok())
        .unwrap_or(0);
    if major < 14 {
        return Compatibility::Unsupported {
            code: "TTS_UNSUPPORTED_OS",
            reason: "Local Voxtral requires macOS 14 or later.".into(),
        };
    }
    Compatibility::Supported
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compatibility_is_always_a_named_state() {
        match detect() {
            Compatibility::Supported => {}
            Compatibility::Unsupported { code, reason } => {
                assert!(code.starts_with("TTS_"));
                assert!(!reason.is_empty());
            }
        }
    }
}
