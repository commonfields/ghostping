use anyhow::Result;
use std::path::PathBuf;

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

/// Install a launchd plist on macOS that re-runs `ghostping audit` periodically.
/// Returns the path to the written plist file.
pub fn install_launchd(
    domain: &str,
    niche: Option<&str>,
    interval: ScheduleInterval,
    binary_path: &str,
) -> Result<PathBuf> {
    let label = format!("com.ghostping.audit.{}", domain.replace('.', "_"));
    let interval_secs = interval.hours() as u64 * 3600;

    let niche_args = niche
        .map(|n| {
            format!(
                "\n                <string>--niche</string>\n                <string>{}</string>",
                n
            )
        })
        .unwrap_or_default();

    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{binary}</string>
        <string>audit</string>
        <string>{domain}</string>{niche_args}
        <string>--quiet</string>
    </array>
    <key>StartInterval</key>
    <integer>{interval_secs}</integer>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>/tmp/ghostping-{domain_safe}.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/ghostping-{domain_safe}.log</string>
</dict>
</plist>
"#,
        label = label,
        binary = binary_path,
        domain = domain,
        niche_args = niche_args,
        interval_secs = interval_secs,
        domain_safe = domain.replace('.', "_"),
    );

    let plist_dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Library")
        .join("LaunchAgents");
    std::fs::create_dir_all(&plist_dir)?;

    let plist_path = plist_dir.join(format!("{}.plist", label));
    std::fs::write(&plist_path, plist)?;
    Ok(plist_path)
}

/// Generate a crontab line for Linux/non-macOS systems.
pub fn cron_line(
    domain: &str,
    niche: Option<&str>,
    interval: ScheduleInterval,
    binary_path: &str,
) -> String {
    let niche_flag = niche
        .map(|n| format!(" --niche \"{}\"", n))
        .unwrap_or_default();

    let schedule = match interval {
        ScheduleInterval::Daily => "0 8 * * *".to_string(),
        ScheduleInterval::Weekly => "0 8 * * 1".to_string(),
        ScheduleInterval::Custom(h) => format!("0 */{} * * *", h),
    };

    format!(
        "{} {} audit {}{} --quiet >> /tmp/ghostping-{}.log 2>&1",
        schedule,
        binary_path,
        domain,
        niche_flag,
        domain.replace('.', "_"),
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
