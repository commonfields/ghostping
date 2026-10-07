use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Project-level configuration stored in openrecord.toml
/// This is distinct from the global ~/.openrecord/config.toml
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct ProjectConfig {
    #[serde(default)]
    pub project: ProjectInfo,
    #[serde(default)]
    pub competitors: CompetitorsConfig,
    #[serde(default)]
    pub keywords: KeywordsConfig,
    #[serde(default)]
    pub providers: ProjectProvidersConfig,
    #[serde(default)]
    pub audit: AuditConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct ProjectInfo {
    pub name: String,
    #[serde(default)]
    pub website: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub audience: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct CompetitorsConfig {
    #[serde(default)]
    pub names: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct KeywordsConfig {
    #[serde(default)]
    pub topics: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct ProjectProvidersConfig {
    #[serde(default = "default_provider")]
    pub default: String,
    #[serde(default)]
    pub models: Vec<String>,
}

fn default_provider() -> String {
    "ollama".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AuditConfig {
    #[serde(default = "default_samples")]
    pub samples_per_prompt: usize,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    #[serde(default = "default_true")]
    pub store_raw_responses: bool,
}

impl Default for AuditConfig {
    fn default() -> Self {
        Self {
            samples_per_prompt: default_samples(),
            temperature: default_temperature(),
            store_raw_responses: default_true(),
        }
    }
}

fn default_samples() -> usize {
    3
}
fn default_temperature() -> f32 {
    0.2
}
fn default_true() -> bool {
    true
}

impl ProjectConfig {
    /// Load project config from openrecord.toml in the given directory
    /// (falls back to legacy llmention.toml from before the rebrand).
    pub fn load_from_dir(dir: &Path) -> Result<Option<Self>> {
        let path = dir.join("openrecord.toml");
        let path = if !path.exists() && dir.join("llmention.toml").exists() {
            dir.join("llmention.toml")
        } else {
            path
        };
        if !path.exists() {
            return Ok(None);
        }
        let contents = std::fs::read_to_string(&path)
            .with_context(|| format!("Failed to read {}", path.display()))?;
        let config: ProjectConfig = toml::from_str(&contents)
            .with_context(|| format!("Failed to parse {}", path.display()))?;
        Ok(Some(config))
    }

    /// Find and load the nearest openrecord.toml by walking up from current dir
    /// (falls back to legacy llmention.toml from before the rebrand).
    pub fn find_and_load() -> Result<Option<(Self, PathBuf)>> {
        let mut current = std::env::current_dir()?;
        loop {
            let config_path = current.join("openrecord.toml");
            let config_path = if !config_path.exists() && current.join("llmention.toml").exists() {
                current.join("llmention.toml")
            } else {
                config_path
            };
            if config_path.exists() {
                let contents = std::fs::read_to_string(&config_path)
                    .with_context(|| format!("Failed to read {}", config_path.display()))?;
                let config: ProjectConfig = toml::from_str(&contents)
                    .with_context(|| format!("Failed to parse {}", config_path.display()))?;
                return Ok(Some((config, current)));
            }
            if !current.pop() {
                break;
            }
        }
        Ok(None)
    }

    /// Save project config to openrecord.toml in the given directory
    pub fn save_to_dir(&self, dir: &Path) -> Result<PathBuf> {
        let path = dir.join("openrecord.toml");
        let contents =
            toml::to_string_pretty(self).context("Failed to serialize project config")?;
        std::fs::write(&path, contents)
            .with_context(|| format!("Failed to write {}", path.display()))?;
        Ok(path)
    }

    /// Validate required fields
    pub fn validate(&self) -> Result<()> {
        if self.project.name.is_empty() {
            anyhow::bail!("Project name is required in openrecord.toml");
        }
        Ok(())
    }

    /// Get domain from website or project name
    pub fn domain(&self) -> String {
        if !self.project.website.is_empty() {
            self.project.website.clone()
        } else {
            self.project.name.to_lowercase().replace(' ', "-")
        }
    }

    /// Get niche/category for prompt generation
    pub fn niche(&self) -> String {
        if !self.project.category.is_empty() {
            self.project.category.clone()
        } else {
            "developer tool".to_string()
        }
    }
}

pub const EXAMPLE_PROJECT_CONFIG: &str = r#"# OpenRecord Project Configuration
# This file defines your project for local GEO auditing
# Place this in your project root as openrecord.toml

[project]
name = "MyProject"
website = "https://myproject.dev"
category = "AI visibility tool"
description = "A local-first AI visibility workbench for developers"
audience = ["indie hackers", "solo founders", "open-source maintainers", "technical builders"]

[competitors]
names = ["CompetitorA", "CompetitorB", "CompetitorC"]

[keywords]
topics = [
    "AI visibility",
    "Generative Engine Optimization",
    "ChatGPT mentions",
    "AI search monitoring",
    "GEO for developers"
]

[providers]
default = "ollama"
models = [
    "ollama:llama3.2",
    "openai:gpt-4o-mini",
    "anthropic:claude-3-haiku"
]

[audit]
samples_per_prompt = 3
temperature = 0.2
store_raw_responses = true
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_project_config_roundtrip() {
        let config = ProjectConfig {
            project: ProjectInfo {
                name: "TestProject".to_string(),
                website: "https://test.dev".to_string(),
                category: "test tool".to_string(),
                description: "A test project".to_string(),
                audience: vec!["developers".to_string()],
            },
            competitors: CompetitorsConfig {
                names: vec!["CompA".to_string()],
            },
            keywords: KeywordsConfig {
                topics: vec!["testing".to_string()],
            },
            providers: ProjectProvidersConfig {
                default: "ollama".to_string(),
                models: vec!["ollama:llama3.2".to_string()],
            },
            audit: AuditConfig {
                samples_per_prompt: 5,
                temperature: 0.5,
                store_raw_responses: true,
            },
        };

        let dir = TempDir::new().unwrap();
        let path = config.save_to_dir(dir.path()).unwrap();
        assert!(path.exists());

        let loaded = ProjectConfig::load_from_dir(dir.path()).unwrap().unwrap();
        assert_eq!(loaded.project.name, "TestProject");
        assert_eq!(loaded.audit.samples_per_prompt, 5);
    }

    #[test]
    fn test_parse_example_config() {
        let config: ProjectConfig = toml::from_str(EXAMPLE_PROJECT_CONFIG).unwrap();
        assert_eq!(config.project.name, "MyProject");
        assert!(!config.competitors.names.is_empty());
    }

    #[test]
    fn test_validate_requires_name() {
        let config = ProjectConfig::default();
        assert!(config.validate().is_err());
    }
}
