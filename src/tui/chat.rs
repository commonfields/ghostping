use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use crossterm::{
    event::{self, Event, KeyCode, KeyModifiers},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, Paragraph, Wrap},
    Frame, Terminal,
};
use tokio::sync::mpsc;

use crate::providers::LlmProvider;

#[derive(Debug, Clone)]
enum MessageKind {
    Bot,
    User,
    System,
}

#[derive(Debug, Clone)]
struct Message {
    kind: MessageKind,
    text: String,
}

impl Message {
    fn bot(text: impl Into<String>) -> Self {
        Self {
            kind: MessageKind::Bot,
            text: text.into(),
        }
    }
    fn user(text: impl Into<String>) -> Self {
        Self {
            kind: MessageKind::User,
            text: text.into(),
        }
    }
    fn system(text: impl Into<String>) -> Self {
        Self {
            kind: MessageKind::System,
            text: text.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
enum ChatState {
    AskDomain,
    AskNiche { domain: String },
    AskAction { domain: String, niche: String },
    AskPrompt { domain: String, niche: String },
    Running { domain: String, niche: String },
    AskNext { domain: String, niche: String },
    Done,
}

struct ChatApp {
    state: ChatState,
    messages: Vec<Message>,
    input: String,
    scroll: usize,
    result_rx: Option<mpsc::Receiver<Result<String, String>>>,
}

impl ChatApp {
    fn new() -> Self {
        let mut app = Self {
            state: ChatState::AskDomain,
            messages: Vec::new(),
            input: String::new(),
            scroll: 0,
            result_rx: None,
        };
        app.push_bot("Welcome to OpenRecord chat! I'll guide you through GEO tasks.");
        app.push_bot("What domain do you want to work on? (e.g. myproject.com)");
        app
    }

    fn push_bot(&mut self, text: impl Into<String>) {
        self.messages.push(Message::bot(text));
        self.scroll_to_bottom();
    }

    fn push_user(&mut self, text: impl Into<String>) {
        self.messages.push(Message::user(text));
        self.scroll_to_bottom();
    }

    fn push_system(&mut self, text: impl Into<String>) {
        self.messages.push(Message::system(text));
        self.scroll_to_bottom();
    }

    fn scroll_to_bottom(&mut self) {
        self.scroll = self.messages.len().saturating_sub(1);
    }

    fn handle_submit(&mut self, providers: &[Arc<dyn LlmProvider>]) {
        let input = self.input.trim().to_string();
        if input.is_empty() {
            return;
        }
        self.input.clear();

        match self.state.clone() {
            ChatState::AskDomain => {
                self.push_user(&input);
                let domain = input.clone();
                self.state = ChatState::AskNiche { domain };
                self.push_bot(
                    "Great! What niche or product category is this? (e.g. \"Rust CLI tool\", \"SaaS analytics\")",
                );
            }

            ChatState::AskNiche { domain } => {
                self.push_user(&input);
                let niche = input.clone();
                self.state = ChatState::AskAction {
                    domain: domain.clone(),
                    niche: niche.clone(),
                };
                self.push_bot(format!(
                    "Got it — {} / {}. What would you like to do?",
                    domain, niche
                ));
                self.push_bot(
                    "  [1] audit    — Quick visibility scan\n  [2] optimize  — Full 5-step GEO agent\n  [3] generate  — Create citable content\n  [q] quit",
                );
            }

            ChatState::AskAction { domain, niche } => {
                self.push_user(&input);
                match input.trim() {
                    "1" | "audit" => {
                        self.push_system(format!(
                            "Running audit for {} [12 prompts × {} model(s)]…",
                            domain,
                            providers.len()
                        ));
                        self.launch_audit(domain.clone(), niche.clone(), providers);
                        self.state = ChatState::Running { domain, niche };
                    }
                    "2" | "optimize" => {
                        self.push_system(format!("Running optimize for {} / {}…", domain, niche));
                        self.launch_optimize(domain.clone(), niche.clone(), providers);
                        self.state = ChatState::Running { domain, niche };
                    }
                    "3" | "generate" => {
                        self.state = ChatState::AskPrompt {
                            domain: domain.clone(),
                            niche: niche.clone(),
                        };
                        self.push_bot(
                            "What query should I generate content for? (e.g. \"best rust cli tool\")",
                        );
                    }
                    "q" | "quit" => {
                        self.state = ChatState::Done;
                    }
                    _ => {
                        self.push_bot(
                            "Please enter 1 (audit), 2 (optimize), 3 (generate), or q to quit.",
                        );
                    }
                }
            }

            ChatState::AskPrompt { domain, niche } => {
                self.push_user(&input);
                let prompt = input.clone();
                self.push_system(format!("Generating content for \"{}\"…", prompt));
                self.launch_generate(niche.clone(), prompt, providers);
                self.state = ChatState::Running { domain, niche };
            }

            ChatState::AskNext { domain, niche } => {
                self.push_user(&input);
                match input.trim() {
                    "1" | "audit" => {
                        self.push_system(format!("Running audit for {}…", domain));
                        self.launch_audit(domain.clone(), niche.clone(), providers);
                        self.state = ChatState::Running { domain, niche };
                    }
                    "2" | "optimize" => {
                        self.push_system(format!("Running optimize for {}…", domain));
                        self.launch_optimize(domain.clone(), niche.clone(), providers);
                        self.state = ChatState::Running { domain, niche };
                    }
                    "3" | "generate" => {
                        self.state = ChatState::AskPrompt {
                            domain: domain.clone(),
                            niche: niche.clone(),
                        };
                        self.push_bot("What query should I generate content for?");
                    }
                    "r" | "restart" => {
                        self.state = ChatState::AskDomain;
                        self.push_bot("Starting over. What domain do you want to work on?");
                    }
                    "q" | "quit" => {
                        self.state = ChatState::Done;
                    }
                    _ => {
                        self.push_bot(
                            "  [1] audit  [2] optimize  [3] generate  [r] restart  [q] quit",
                        );
                    }
                }
            }

            ChatState::Running { .. } | ChatState::Done => {}
        }
    }

    fn launch_audit(&mut self, domain: String, niche: String, providers: &[Arc<dyn LlmProvider>]) {
        let (tx, rx) = mpsc::channel::<Result<String, String>>(1);
        self.result_rx = Some(rx);
        let providers = providers.to_vec();

        // Use a dedicated thread + single-threaded runtime to avoid Storage !Send constraint.
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("tokio runtime");
            rt.block_on(async move {
                use crate::{
                    cache::Cache,
                    geo::prompts,
                    storage::Storage,
                    tracker::{self, TrackOptions},
                };

                let base_dir = match dirs::home_dir() {
                    Some(h) => h.join(".openrecord"),
                    None => {
                        let _ = tx.send(Err("Cannot find home directory".to_string())).await;
                        return;
                    }
                };

                let storage = match Storage::open(&base_dir) {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = tx.send(Err(e.to_string())).await;
                        return;
                    }
                };
                let cache = match Cache::new(&base_dir) {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = tx.send(Err(e.to_string())).await;
                        return;
                    }
                };

                let audit_prompts = prompts::default_prompts(&domain, Some(&niche), None);
                match tracker::run_track(
                    &domain,
                    audit_prompts,
                    providers,
                    &storage,
                    &cache,
                    TrackOptions {
                        verbose: false,
                        concurrency: 5,
                        judge: None,
                        quiet: true,
                    },
                )
                .await
                {
                    Ok(summary) => {
                        let rate = summary.mention_rate();
                        let result = format!(
                            "Audit complete for {}.\nMention rate: {:.0}%  ({}/{} queries)",
                            domain, rate, summary.mention_count, summary.total_queries
                        );
                        let _ = tx.send(Ok(result)).await;
                    }
                    Err(e) => {
                        let _ = tx.send(Err(e.to_string())).await;
                    }
                }
            });
        });
    }

    fn launch_optimize(
        &mut self,
        domain: String,
        niche: String,
        providers: &[Arc<dyn LlmProvider>],
    ) {
        let (tx, rx) = mpsc::channel::<Result<String, String>>(1);
        self.result_rx = Some(rx);
        let providers = providers.to_vec();

        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("tokio runtime");
            rt.block_on(async move {
                use crate::{
                    agent::optimizer::{self, OptimizeOptions},
                    cache::Cache,
                    storage::Storage,
                };

                let base_dir = match dirs::home_dir() {
                    Some(h) => h.join(".openrecord"),
                    None => {
                        let _ = tx.send(Err("Cannot find home directory".to_string())).await;
                        return;
                    }
                };

                let storage = match Storage::open(&base_dir) {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = tx.send(Err(e.to_string())).await;
                        return;
                    }
                };
                let cache = match Cache::new(&base_dir) {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = tx.send(Err(e.to_string())).await;
                        return;
                    }
                };

                let opts = OptimizeOptions {
                    domain: domain.clone(),
                    niche: niche.clone(),
                    competitors: vec![],
                    steps: 3,
                    max_rounds: 2,
                    dry_run: true,
                    verbose: false,
                    quiet: true,
                    generate_template_override: None,
                    discover_template_override: None,
                };

                match optimizer::optimize(&opts, &providers, &storage, &cache).await {
                    Ok(plan) => {
                        let result = format!(
                            "Optimize complete for {}.\nCurrent mention rate: {:.0}%\nSections generated: {}\nAvg citability: {:.0}%\nProjected lift: +{:.0}%",
                            domain,
                            plan.current_mention_rate,
                            plan.sections.len(),
                            plan.avg_citability(),
                            plan.projected_lift(),
                        );
                        let _ = tx.send(Ok(result)).await;
                    }
                    Err(e) => {
                        let _ = tx.send(Err(e.to_string())).await;
                    }
                }
            });
        });
    }

    fn launch_generate(
        &mut self,
        niche: String,
        prompt: String,
        providers: &[Arc<dyn LlmProvider>],
    ) {
        let (tx, rx) = mpsc::channel::<Result<String, String>>(1);
        self.result_rx = Some(rx);
        let providers = providers.to_vec();

        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("tokio runtime");
            rt.block_on(async move {
                use crate::geo::generator::{self, GenerateOptions};

                let opts = GenerateOptions {
                    prompt: prompt.clone(),
                    about: String::new(),
                    niche,
                    verbose: false,
                    system_prompt_override: None,
                };

                match generator::generate(&opts, &providers).await {
                    Ok(results) if !results.is_empty() => {
                        let r = &results[0];
                        let preview: String =
                            r.content.lines().take(8).collect::<Vec<_>>().join("\n");
                        let result = format!(
                            "Generated content for \"{}\" via {}.\n\nPreview:\n{}\n\n[{} words total]",
                            prompt,
                            r.model,
                            preview,
                            r.content.split_whitespace().count()
                        );
                        let _ = tx.send(Ok(result)).await;
                    }
                    Ok(_) => {
                        let _ =
                            tx.send(Err("No providers returned content.".to_string())).await;
                    }
                    Err(e) => {
                        let _ = tx.send(Err(e.to_string())).await;
                    }
                }
            });
        });
    }

    fn poll_result(&mut self) -> bool {
        let result = if let Some(rx) = &mut self.result_rx {
            rx.try_recv().ok()
        } else {
            None
        };

        if let Some(outcome) = result {
            let (domain, niche) = match &self.state {
                ChatState::Running { domain, niche } => (domain.clone(), niche.clone()),
                _ => ("unknown".to_string(), "unknown".to_string()),
            };

            self.result_rx = None;

            match outcome {
                Ok(text) => {
                    for line in text.lines() {
                        self.push_system(line);
                    }
                }
                Err(e) => {
                    self.push_bot(format!("Error: {}", e));
                }
            }

            self.state = ChatState::AskNext { domain, niche };
            self.push_bot(
                "What next?  [1] audit  [2] optimize  [3] generate  [r] restart  [q] quit",
            );
            return true;
        }
        false
    }
}

fn render(f: &mut Frame, app: &ChatApp) {
    let area = f.area();
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(5),
            Constraint::Length(3),
            Constraint::Length(1),
        ])
        .split(area);

    render_header(f, chunks[0]);
    render_messages(f, chunks[1], app);
    render_input(f, chunks[2], app);
    render_hints(f, chunks[3], app);
}

fn render_header(f: &mut Frame, area: Rect) {
    let title = Paragraph::new(Line::from(vec![
        Span::styled(
            "OpenRecord ",
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled("Chat", Style::default().fg(Color::White)),
        Span::styled(
            " — GEO task assistant",
            Style::default().fg(Color::DarkGray),
        ),
    ]))
    .block(Block::default().borders(Borders::ALL));
    f.render_widget(title, area);
}

fn render_messages(f: &mut Frame, area: Rect, app: &ChatApp) {
    let visible_height = area.height.saturating_sub(2) as usize;
    let total = app.messages.len();
    let start = if total > visible_height {
        app.scroll
            .saturating_sub(visible_height.saturating_sub(1))
            .min(total.saturating_sub(visible_height))
    } else {
        0
    };

    let visible: Vec<ListItem> = app
        .messages
        .iter()
        .skip(start)
        .take(visible_height + 2)
        .map(|m| {
            let (prefix, style) = match m.kind {
                MessageKind::Bot => ("  ● ", Style::default().fg(Color::Cyan)),
                MessageKind::User => ("  > ", Style::default().fg(Color::Yellow)),
                MessageKind::System => ("  · ", Style::default().fg(Color::DarkGray)),
            };
            let lines: Vec<Line> = m
                .text
                .lines()
                .enumerate()
                .map(|(i, line)| {
                    if i == 0 {
                        Line::from(vec![
                            Span::styled(prefix, style),
                            Span::styled(line.to_string(), style),
                        ])
                    } else {
                        Line::from(vec![
                            Span::raw("    "),
                            Span::styled(line.to_string(), style),
                        ])
                    }
                })
                .collect();
            ListItem::new(lines)
        })
        .collect();

    let list = List::new(visible).block(Block::default().borders(Borders::ALL).title(" Messages "));
    f.render_widget(list, area);
}

fn render_input(f: &mut Frame, area: Rect, app: &ChatApp) {
    let is_running = matches!(app.state, ChatState::Running { .. });
    let is_done = matches!(app.state, ChatState::Done);

    let input_widget = if is_running {
        Paragraph::new(Line::from(Span::styled(
            "  waiting for result…",
            Style::default().fg(Color::DarkGray),
        )))
        .block(Block::default().borders(Borders::ALL).title(" Input "))
    } else if is_done {
        Paragraph::new(Line::from(Span::styled(
            "  done",
            Style::default().fg(Color::DarkGray),
        )))
        .block(Block::default().borders(Borders::ALL).title(" Input "))
    } else {
        Paragraph::new(Line::from(vec![
            Span::styled("  › ", Style::default().fg(Color::Cyan)),
            Span::raw(&app.input),
            Span::styled("▌", Style::default().fg(Color::Cyan)),
        ]))
        .block(Block::default().borders(Borders::ALL).title(" Input "))
        .wrap(Wrap { trim: false })
    };
    f.render_widget(input_widget, area);
}

fn render_hints(f: &mut Frame, area: Rect, app: &ChatApp) {
    let hints = match &app.state {
        ChatState::Running { .. } => " Ctrl+C to abort ",
        ChatState::Done => " Press any key to exit ",
        _ => " Enter to submit  ↑↓ scroll  Ctrl+C quit ",
    };
    let p = Paragraph::new(Span::styled(hints, Style::default().fg(Color::DarkGray)));
    f.render_widget(p, area);
}

pub async fn run(providers: Vec<Arc<dyn LlmProvider>>) -> Result<()> {
    enable_raw_mode()?;
    let mut stdout = std::io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let mut app = ChatApp::new();
    let tick = Duration::from_millis(100);

    loop {
        terminal.draw(|f| render(f, &app))?;

        if matches!(app.state, ChatState::Done) {
            if event::poll(Duration::from_secs(60))? {
                event::read()?;
            }
            break;
        }

        if matches!(app.state, ChatState::Running { .. }) {
            app.poll_result();
        }

        if event::poll(tick)? {
            if let Event::Key(key) = event::read()? {
                if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
                    break;
                }

                match key.code {
                    KeyCode::Enter => {
                        if !matches!(app.state, ChatState::Running { .. }) {
                            app.handle_submit(&providers);
                        }
                    }
                    KeyCode::Char(c) => {
                        if !matches!(app.state, ChatState::Running { .. }) {
                            app.input.push(c);
                        }
                    }
                    KeyCode::Backspace => {
                        app.input.pop();
                    }
                    KeyCode::Up => {
                        app.scroll = app.scroll.saturating_sub(1);
                    }
                    KeyCode::Down => {
                        app.scroll = (app.scroll + 1).min(app.messages.len().saturating_sub(1));
                    }
                    _ => {}
                }
            }
        }
    }

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    Ok(())
}
