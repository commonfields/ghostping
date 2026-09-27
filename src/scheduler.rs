use anyhow::{bail, Result};
use std::path::{Path, PathBuf};

/// Interval presets
#[derive(Debug, Clone, Copy)]
pub enum ScheduleInterval {
    Daily,
    Weekly,
    Custom(u32), // hours
}

impl ScheduleInterval {
    pub fn hours(self) -> u32 {
        match self {
            Self::Daily => 24,
            Self::Weekly => 168,
            Self::Custom(h) => h,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Daily => "daily",
            Self::Weekly => "weekly",
            Self::Custom(_) => "custom",
        }
    }
}

/// A scheduled evidence-engine audit.
///
/// The generated job runs the canonical CLI surface (`ghostping audit run`)
/// from the project directory holding `ghostping.toml`, so scheduled runs
/// produce evidence-engine records — never legacy tracker rows.
#[derive(Debug, Clone)]
pub struct ScheduledAudit {
    /// Project directory containing `ghostping.toml`. The job runs with this
    /// as its working directory.
    pub project_dir: PathBuf,
    /// Value for `--models` (e.g. `"ollama"`, `"openai,anthropic"`).
    /// `None` defers to the project's configured models.
    pub models: Option<String>,
    /// Human-readable label used for the job name and log filename.
    /// Sanitized before use; see [`sanitize_label`].
    pub label: String,
    /// Absolute path to the ghostping binary.
    pub binary: String,
}

impl ScheduledAudit {
    /// Argument vector for the scheduled audit, excluding any shell wrapper.
    /// `argv[0]` is the binary itself, so fixtures can execute this directly
    /// against a stub executable to prove the job is runnable.
    pub fn argv(&self) -> Vec<String> {
        let mut args = vec![
            self.binary.clone(),
            "audit".to_string(),
            "run".to_string(),
            "--yes".to_string(),
        ];
        if let Some(models) = &self.models {
            args.push("--models".to_string());
            args.push(models.clone());
        }
        args
    }

    /// Full shell command for cron: `cd <project_dir> && <argv...>`.
    /// Every interpolated value is single-quote escaped; `%` is escaped
    /// because cron treats bare `%` as a newline.
    pub fn shell_command(&self) -> String {
        let mut parts = vec![
            "cd".to_string(),
            shell_quote(&self.project_dir.display().to_string()),
            "&&".to_string(),
        ];
        parts.extend(self.argv().into_iter().map(|a| shell_quote(&a)));
        parts.join(" ").replace('%', "\\%")
    }

    /// Log file for the scheduled job's output.
    pub fn log_path(&self) -> String {
        format!("/tmp/ghostping-{}.log", sanitize_label(&self.label))
    }
}

/// Escape a string for inclusion in a launchd plist `<string>` value.
pub fn escape_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

/// Quote a string for POSIX shell: wrap in single quotes, escaping embedded
/// single quotes as `'\''`.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Restrict a job label to filesystem- and plist-safe characters so
/// adversarial domain/project text cannot escape the job name, filename,
/// or log path. Non `[A-Za-z0-9_-]` characters become `_`.
pub fn sanitize_label(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Validate a custom hour interval for cron emission.
/// cron hour steps (`0 */h * * *`) are only meaningful for 1–24 hours;
/// anything else previously produced a schedule that never (or wrongly)
/// fired, so it is now rejected instead of emitted.
pub fn validate_cron_hours(h: u32) -> Result<()> {
    if (1..=24).contains(&h) {
        Ok(())
    } else {
        bail!(
            "Invalid custom interval '{}h' for cron: use daily, weekly, or 1-24 hours.",
            h
        );
    }
}

/// Install a launchd plist on macOS that re-runs the evidence audit
/// periodically. Returns the path to the written plist file.
pub fn install_launchd(job: &ScheduledAudit, interval: ScheduleInterval) -> Result<PathBuf> {
    let safe_label = sanitize_label(&job.label);
    let label = format!("com.ghostping.audit.{}", safe_label);
    let plist = render_plist(job, interval);

    let plist_dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Library")
        .join("LaunchAgents");
    std::fs::create_dir_all(&plist_dir)?;

    let plist_path = plist_dir.join(format!("{}.plist", label));
    std::fs::write(&plist_path, plist)?;
    Ok(plist_path)
}

/// Generate a crontab line for Linux/non-macOS systems that runs the
/// evidence audit from the project directory.
pub fn cron_line(job: &ScheduledAudit, interval: ScheduleInterval) -> Result<String> {
    let schedule = match interval {
        ScheduleInterval::Daily => "0 8 * * *".to_string(),
        ScheduleInterval::Weekly => "0 8 * * 1".to_string(),
        ScheduleInterval::Custom(h) => {
            validate_cron_hours(h)?;
            if h == 24 {
                "0 0 * * *".to_string()
            } else {
                format!("0 */{} * * *", h)
            }
        }
    };

    Ok(format!(
        "{} {} >> {} 2>&1",
        schedule,
        job.shell_command(),
        job.log_path(),
    ))
}

/// Write the plist for `job` to `dir` instead of `~/Library/LaunchAgents`.
/// Test fixture hook: lets tests inspect generated jobs without touching
/// the user's real LaunchAgents directory.
#[cfg(test)]
fn write_plist_to_dir(
    job: &ScheduledAudit,
    interval: ScheduleInterval,
    dir: &Path,
) -> Result<PathBuf> {
    let safe_label = sanitize_label(&job.label);
    let path = dir.join(format!("com.ghostping.audit.{}.plist", safe_label));
    // Reuse the production renderer by installing, then moving the file.
    let rendered = render_plist(job, interval);
    std::fs::create_dir_all(dir)?;
    std::fs::write(&path, rendered)?;
    Ok(path)
}

fn render_plist(job: &ScheduledAudit, interval: ScheduleInterval) -> String {
    let safe_label = sanitize_label(&job.label);
    let label = format!("com.ghostping.audit.{}", safe_label);
    let interval_secs = interval.hours() as u64 * 3600;

    let mut program_args = format!(
        "\n                <string>{}</string>\n                <string>audit</string>\n                <string>run</string>\n                <string>--yes</string>",
        escape_xml(&job.binary),
    );
    if let Some(models) = &job.models {
        program_args.push_str(&format!(
            "\n                <string>--models</string>\n                <string>{}</string>",
            escape_xml(models)
        ));
    }

    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>{program_args}
    </array>
    <key>WorkingDirectory</key>
    <string>{project_dir}</string>
    <key>StartInterval</key>
    <integer>{interval_secs}</integer>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>{log_path}</string>
    <key>StandardErrorPath</key>
    <string>{log_path}</string>
</dict>
</plist>
"#,
        label = escape_xml(&label),
        program_args = program_args,
        project_dir = escape_xml(&job.project_dir.display().to_string()),
        interval_secs = interval_secs,
        log_path = escape_xml(&job.log_path()),
    )
}

/// Send a macOS notification via `osascript`. Silent no-op on non-macOS.
pub fn notify(title: &str, message: &str) {
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "display notification \"{}\" with title \"{}\"",
            message.replace('"', "'"),
            title.replace('"', "'")
        );
        let _ = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output();
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (title, message); // silence unused warnings
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn fixture_job(binary: &str) -> ScheduledAudit {
        ScheduledAudit {
            project_dir: PathBuf::from("/tmp/gp proj"),
            models: Some("mock".to_string()),
            label: "example.com".to_string(),
            binary: binary.to_string(),
        }
    }

    #[test]
    fn test_argv_uses_current_audit_run_surface() {
        let job = fixture_job("/usr/local/bin/ghostping");
        assert_eq!(
            job.argv(),
            vec![
                "/usr/local/bin/ghostping",
                "audit",
                "run",
                "--yes",
                "--models",
                "mock",
            ]
        );
        // No legacy domain/niche/quiet positional form.
        assert!(!job.argv().iter().any(|a| a == "audit-legacy"));
    }

    #[test]
    fn test_argv_without_models_omits_flag() {
        let mut job = fixture_job("/bin/ghostping");
        job.models = None;
        assert_eq!(job.argv(), vec!["/bin/ghostping", "audit", "run", "--yes"]);
    }

    #[test]
    fn test_generated_argv_executes_against_stub() {
        // Prove the generated job is executable: run argv[0..] against a
        // stub executable and assert it receives the audit run arguments.
        let dir = tempfile::TempDir::new().unwrap();
        let stub = dir.path().join("ghostping-stub.sh");
        let record = dir.path().join("args.txt");
        std::fs::write(
            &stub,
            format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > {}\n", record.display()),
        )
        .unwrap();
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();

        let job = fixture_job(&stub.display().to_string());
        let argv = job.argv();
        let status = std::process::Command::new(&argv[0])
            .args(&argv[1..])
            .current_dir(dir.path())
            .status()
            .unwrap();
        assert!(status.success());
        let seen = std::fs::read_to_string(&record).unwrap();
        let lines: Vec<&str> = seen.lines().collect();
        assert_eq!(lines, vec!["audit", "run", "--yes", "--models", "mock"]);
    }

    #[test]
    fn test_shell_command_executes_from_project_dir() {
        // The cron shell wrapper must cd to the project dir first, with
        // quoting that survives spaces in the path.
        let dir = tempfile::TempDir::new().unwrap();
        let stub = dir.path().join("bin-stub.sh");
        let record = dir.path().join("seen.txt");
        std::fs::write(
            &stub,
            format!(
                "#!/bin/sh\npwd > {}\nprintf '%s\\n' \"$@\" >> {}\n",
                record.display(),
                record.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();

        let project = dir.path().join("my project");
        std::fs::create_dir_all(&project).unwrap();
        let job = ScheduledAudit {
            project_dir: project.clone(),
            models: None,
            label: "x.com".to_string(),
            binary: stub.display().to_string(),
        };
        let status = std::process::Command::new("sh")
            .args(["-c", &job.shell_command()])
            .status()
            .unwrap();
        assert!(status.success());
        let seen = std::fs::read_to_string(&record).unwrap();
        let mut lines = seen.lines();
        assert_eq!(lines.next().unwrap(), project.to_str().unwrap());
        assert_eq!(lines.collect::<Vec<_>>(), vec!["audit", "run", "--yes"]);
    }

    #[test]
    fn test_xml_escaping_adversarial_label_and_models() {
        let job = ScheduledAudit {
            project_dir: PathBuf::from("/tmp/p"),
            models: Some("a&b<\"c\">".to_string()),
            label: "evil\"><script>".to_string(),
            binary: "/bin/ghostping".to_string(),
        };
        let plist = render_plist(&job, ScheduleInterval::Daily);
        assert!(!plist.contains("evil\"><script>"));
        assert!(plist.contains("a&amp;b&lt;&quot;c&quot;&gt;"));
        // Label sanitized for filename safety.
        assert_eq!(sanitize_label("evil\"><script>"), "evil___script_");

        let dir = tempfile::TempDir::new().unwrap();
        let written = write_plist_to_dir(&job, ScheduleInterval::Daily, dir.path()).unwrap();
        let content = std::fs::read_to_string(&written).unwrap();
        assert!(content.contains("&amp;"));
        assert!(!content.contains("a&b<"));
    }

    #[test]
    fn test_shell_quoting_adversarial_values() {
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
        let job = ScheduledAudit {
            project_dir: PathBuf::from("/tmp/p'; evil"),
            models: Some("m; rm -rf /".to_string()),
            label: "x".to_string(),
            binary: "/bin/ghostping".to_string(),
        };
        let cmd = job.shell_command();
        // Single-quoted throughout; no bare metacharacters outside quotes.
        assert!(cmd.contains("'/tmp/p'\\''; evil'"));
        assert!(cmd.contains("'m; rm -rf /'"));
    }

    #[test]
    fn test_cron_rejects_invalid_custom_intervals() {
        let job = fixture_job("/bin/ghostping");
        assert!(cron_line(&job, ScheduleInterval::Custom(6)).is_ok());
        assert!(cron_line(&job, ScheduleInterval::Custom(24)).is_ok());
        assert!(cron_line(&job, ScheduleInterval::Custom(0)).is_err());
        assert!(cron_line(&job, ScheduleInterval::Custom(48)).is_err());
        assert!(cron_line(&job, ScheduleInterval::Custom(168)).is_err());
        let line = cron_line(&job, ScheduleInterval::Custom(6)).unwrap();
        assert!(line.starts_with("0 */6 * * * "));
        // argv elements are individually shell-quoted.
        assert!(line.contains("'audit'") && line.contains("'run'"));
    }

    #[test]
    fn test_sanitize_label_restricts_charset() {
        assert_eq!(sanitize_label("example.com"), "example_com");
        assert_eq!(sanitize_label("a/b..c d"), "a_b__c_d");
        assert_eq!(sanitize_label("ok-Name_1"), "ok-Name_1");
    }
}
