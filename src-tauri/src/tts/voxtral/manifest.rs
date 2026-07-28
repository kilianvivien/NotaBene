use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Component, Path};

pub const MANIFEST_JSON: &str = include_str!("../../../resources/voxtral-model-manifest.json");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelManifest {
    pub schema_version: u32,
    pub model_id: String,
    pub revision: String,
    pub license: String,
    pub sample_rate_hz: u32,
    pub source_base_url: String,
    pub files: Vec<ModelFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelFile {
    pub path: String,
    pub size_bytes: u64,
    pub sha256: String,
}

impl ModelManifest {
    pub fn bundled() -> Result<Self, String> {
        let manifest: Self =
            serde_json::from_str(MANIFEST_JSON).map_err(|error| error.to_string())?;
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err("unsupported Voxtral manifest schema".into());
        }
        if self.revision.len() != 40 || !self.revision.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("model revision must be a full immutable commit hash".into());
        }
        if self.license != "CC-BY-NC-4.0" || self.sample_rate_hz != 24_000 {
            return Err("unexpected model license or audio format".into());
        }
        if !self.source_base_url.starts_with("https://huggingface.co/")
            || !self.source_base_url.contains(&self.revision)
            || self.source_base_url.ends_with("/main")
        {
            return Err("model source is not revision-pinned HTTPS".into());
        }
        let mut paths = HashSet::new();
        for file in &self.files {
            let path = Path::new(&file.path);
            if path.is_absolute()
                || path
                    .components()
                    .any(|part| !matches!(part, Component::Normal(_)))
                || !paths.insert(file.path.as_str())
            {
                return Err(format!("unsafe or duplicate model path: {}", file.path));
            }
            if file.size_bytes == 0
                || file.sha256.len() != 64
                || !file.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(format!("invalid metadata for {}", file.path));
            }
        }
        if !paths.contains("model.safetensors")
            || !paths.contains("config.json")
            || !paths.contains("tekken.json")
        {
            return Err("manifest is missing a required model file".into());
        }
        Ok(())
    }

    pub fn total_bytes(&self) -> u64 {
        self.files.iter().map(|file| file.size_bytes).sum()
    }

    pub fn url(&self, file: &ModelFile) -> String {
        format!("{}/{}", self.source_base_url, file.path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_manifest_is_immutable_and_complete() {
        let manifest = ModelManifest::bundled().unwrap();
        assert_eq!(manifest.revision.len(), 40);
        assert!(manifest.total_bytes() > 2_500_000_000);
        assert!(manifest.files.len() >= 25);
    }

    #[test]
    fn rejects_path_escape() {
        let mut manifest = ModelManifest::bundled().unwrap();
        manifest.files[0].path = "../outside".into();
        assert!(manifest.validate().is_err());
    }

    #[test]
    fn rejects_mutable_source() {
        let mut manifest = ModelManifest::bundled().unwrap();
        manifest.source_base_url = "https://huggingface.co/example/model/resolve/main".into();
        assert!(manifest.validate().is_err());
    }
}
