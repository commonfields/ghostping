'use client';

import { useState } from 'react';
import {
  Terminal,
  Download,
  Github,
  FileText,
  Shield,
  Search,
  BarChart3,
  Database,
  FileCode,
  Zap,
  Copy,
  Check,
  ExternalLink,
  Lock,
  Activity,
} from 'lucide-react';

// ── Canonical project URLs ───────────────────────────────
const GITHUB_REPO   = 'https://github.com/commonfields/ghostping';
const RELEASES_URL  = 'https://github.com/commonfields/ghostping/releases';
const DOCS_URL      = 'https://github.com/commonfields/ghostping#readme';
const INSTALL_SH    = 'https://raw.githubusercontent.com/commonfields/ghostping/main/scripts/install.sh';
const INSTALL_PS1   = 'https://raw.githubusercontent.com/commonfields/ghostping/main/scripts/install.ps1';
// ─────────────────────────────────────────────────────────

const TERMINAL_LINES = [
  {
    cmd: 'ghostping init --name "MyProject" --website "https://example.com" --category "developer tool" --yes',
    out: '✓ Created ./ghostping.toml\n  Next steps:\n    1. Edit ghostping.toml to customize your project',
  },
  {
    cmd: 'ghostping prompts discover',
    out: '✓ Discovered 12 high-intent prompts for "developer tool"',
  },
  {
    cmd: 'ghostping audit run --models mock --samples 3',
    out: '✓ Audit Run 0193ef…\n  Mention rate:          66.7%\n  Recommendation rate:   33.3%\n  Citation rate:         33.3% (1 of 3 responses with a project citation)\n  Total queries:         3\n  Coverage:              3/3 planned queries succeeded',
  },
  {
    cmd: 'ghostping report --output ./reports/',
    out: '✓ Evidence report: ./reports/audit-2024-01-15.md',
  },
  {
    cmd: 'ghostping generate --output ./generated/',
    out: '✓ Generated 5 content assets from visibility gaps',
  },
];

const FEATURES = [
  {
    n: '01',
    Icon: Search,
    title: 'Discover high-intent prompts',
    desc: 'Find the prompts your audience actually uses when looking for solutions like yours.',
  },
  {
    n: '02',
    Icon: BarChart3,
    title: 'Repeatable multi-sample audits',
    desc: 'Run consistent audits across N samples. Results are probabilistic — sampling gives you a distribution, not a guarantee.',
  },
  {
    n: '03',
    Icon: Activity,
    title: 'Measure mentions, citations & gaps',
    desc: 'Track where you appear and where competitors appear instead of you.',
  },
  {
    n: '04',
    Icon: Database,
    title: 'Store raw evidence locally',
    desc: 'Every model response is saved on your machine. Full ownership, no cloud syncing.',
  },
  {
    n: '05',
    Icon: FileCode,
    title: 'Markdown evidence reports',
    desc: 'Generate detailed reports with raw model responses for further analysis or sharing.',
  },
  {
    n: '06',
    Icon: Zap,
    title: 'Content from visibility gaps',
    desc: 'Auto-generate content assets targeting the prompts where you\'re not appearing.',
  },
];

const NAV_LINKS = [
  { label: 'Features', href: '#features' },
  { label: 'Install',  href: '#install'  },
  { label: 'Privacy',  href: '#privacy'  },
];

// ── Shared copy button ───────────────────────────────────
function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setOk(true);
    setTimeout(() => setOk(false), 2000);
  };

  return (
    <button
      onClick={copy}
      className="flex-shrink-0 p-1.5 rounded transition-opacity"
      style={{ color: 'var(--amber)', opacity: ok ? 1 : 0.4 }}
      aria-label="Copy"
    >
      {ok
        ? <Check className="w-3.5 h-3.5" />
        : <Copy className="w-3.5 h-3.5" />
      }
    </button>
  );
}

// ── Phosphor CRT terminal ────────────────────────────────
function PhosphorTerminal() {
  return (
    <div
      className="relative rounded-lg overflow-hidden scanlines"
      style={{
        background: '#040300',
        border: '1px solid var(--amber-ring)',
        boxShadow:
          '0 0 0 1px rgba(245,167,42,0.06), 0 0 40px rgba(245,167,42,0.05), 0 24px 64px rgba(0,0,0,0.6)',
      }}
    >
      {/* Title bar */}
      <div
        className="flex items-center gap-2 px-4 py-3 border-b"
        style={{
          borderColor: 'rgba(245,167,42,0.1)',
          background: 'rgba(245,167,42,0.03)',
        }}
      >
        <div className="flex gap-1.5" aria-hidden="true">
          {['#2a1e0a','#2a1e0a','#2a1e0a'].map((c, i) => (
            <div key={i} className="w-2.5 h-2.5 rounded-full" style={{ background: c }} />
          ))}
        </div>
        <span
          className="ml-3 text-xs font-mono tracking-widest uppercase select-none"
          style={{ color: 'rgba(245,167,42,0.35)' }}
        >
          ghostping — zsh
        </span>
      </div>

      {/* Body */}
      <div className="p-5 font-mono text-sm space-y-5 relative z-[1]">
        {TERMINAL_LINES.map((line, i) => (
          <div
            key={i}
            className={`fade-up d${i + 2}`}
          >
            <div className="flex items-start gap-2">
              <span
                className="select-none mt-px flex-shrink-0"
                style={{ color: 'rgba(245,167,42,0.4)' }}
              >
                $
              </span>
              <span
                className="flex-1 break-all leading-relaxed"
                style={{
                  color: 'var(--amber)',
                  textShadow: '0 0 10px rgba(245,167,42,0.45)',
                }}
              >
                {line.cmd}
              </span>
              <CopyBtn text={line.cmd} />
            </div>
            {line.out && (
              <div
                className="mt-1 pl-5 whitespace-pre-line text-xs leading-relaxed"
                style={{ color: 'rgba(245,167,42,0.48)' }}
              >
                {line.out}
              </div>
            )}
          </div>
        ))}

        {/* Blinking cursor */}
        <div className="flex items-center gap-2">
          <span
            className="select-none"
            style={{ color: 'rgba(245,167,42,0.4)' }}
          >
            $
          </span>
          <span
            className="cursor w-2 h-[1.1em] rounded-[1px] inline-block"
            style={{
              background: 'var(--amber)',
              boxShadow: '0 0 8px var(--amber)',
            }}
          />
        </div>
      </div>
    </div>
  );
}

// ── Install code block ───────────────────────────────────
function CodeBlock({ label, cmd }: { label: string; cmd: string }) {
  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{ border: '1px solid var(--border-mid)', background: 'var(--surface)' }}
    >
      <div
        className="flex items-center justify-between px-4 py-2.5 border-b"
        style={{ borderColor: 'var(--border)', background: 'var(--elevated)' }}
      >
        <span
          className="text-xs font-mono tracking-widest uppercase"
          style={{ color: 'var(--text-2)' }}
        >
          {label}
        </span>
        <CopyBtn text={cmd} />
      </div>
      <div className="px-4 py-4">
        <code
          className="font-mono text-sm leading-relaxed block break-all"
          style={{ color: 'var(--amber)' }}
        >
          {cmd}
        </code>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────
export default function Page() {
  return (
    <main style={{ background: 'var(--bg)', color: 'var(--text)', minHeight: '100vh' }}>

      {/* ── NAV ─────────────────────────────────────────── */}
      <nav
        className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 md:px-10 h-14"
        style={{
          background:    'rgba(6,6,6,0.90)',
          backdropFilter:'blur(14px)',
          borderBottom:  '1px solid var(--border)',
        }}
      >
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--amber)' }} />
          <span
            className="font-display font-bold text-sm tracking-[0.18em] uppercase"
            style={{ color: 'var(--text)' }}
          >
            Ghostping
          </span>
        </div>

        <div className="hidden md:flex items-center gap-8">
          {NAV_LINKS.map(({ label, href }) => (
            <a
              key={label}
              href={href}
              className="text-xs font-mono tracking-widest uppercase transition-opacity hover:opacity-100"
              style={{ color: 'var(--text-2)', opacity: 0.8 }}
            >
              {label}
            </a>
          ))}
          <a
            href={GITHUB_REPO}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs font-mono tracking-widest uppercase transition-opacity hover:opacity-100"
            style={{ color: 'var(--text-2)', opacity: 0.8 }}
          >
            <Github className="w-3.5 h-3.5" />
            GitHub
          </a>
        </div>
      </nav>

      {/* ── HERO ────────────────────────────────────────── */}
      <section
        className="relative flex flex-col items-center justify-center min-h-screen pt-14 px-6 overflow-hidden"
        style={{
          backgroundImage: `
            linear-gradient(rgba(245,167,42,0.04) 1px, transparent 1px),
            linear-gradient(90deg, rgba(245,167,42,0.04) 1px, transparent 1px)
          `,
          backgroundSize: '56px 56px',
        }}
      >
        {/* Large decorative LLM behind content */}
        <div
          className="absolute inset-0 flex items-center justify-center select-none pointer-events-none overflow-hidden"
          aria-hidden="true"
        >
          <span
            className="font-display font-black leading-none tracking-tight"
            style={{
              fontSize: 'clamp(110px, 20vw, 300px)',
              color: 'transparent',
              WebkitTextStroke: '1px rgba(245,167,42,0.045)',
              letterSpacing: '-0.04em',
            }}
          >
            LLM
          </span>
        </div>

        {/* Radial vignette to keep text readable */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse 75% 65% at 50% 50%, transparent 0%, var(--bg) 100%)',
          }}
        />

        {/* Content */}
        <div className="relative z-10 max-w-3xl mx-auto text-center">
          {/* Badge */}
          <div
            className="fade-up d0 inline-flex items-center gap-2 mb-8 px-3 py-1.5 text-xs font-mono tracking-widest uppercase rounded-sm"
            style={{
              border:     '1px solid var(--amber-ring)',
              color:      'var(--amber)',
              background: 'var(--amber-low)',
            }}
          >
            <span
              className="cursor w-1.5 h-1.5 rounded-full inline-block flex-shrink-0"
              style={{ background: 'var(--amber)' }}
            />
            CLI · Rust · Local-First
          </div>

          {/* H1 */}
          <h1
            className="fade-up d1 font-display font-bold leading-none tracking-tight mb-5"
            style={{
              fontSize:      'clamp(40px, 7.5vw, 88px)',
              letterSpacing: '-0.03em',
            }}
          >
            Check if AI recommends
            <br />
            <span style={{ color: 'var(--amber)' }}>your project.</span>
          </h1>

          {/* Tagline */}
          <p
            className="fade-up d2 text-lg leading-relaxed mb-3 max-w-xl mx-auto"
            style={{ color: 'var(--text-2)' }}
          >
            Ghostping audits whether AI models mention, cite, or recommend your project —
            then generates markdown content to help close the gaps.
          </p>
          <p
            className="fade-up d2 text-sm mb-10"
            style={{ color: 'var(--text-3)' }}
          >
            Results are probabilistic. No guarantees of AI visibility.
          </p>

          {/* CTAs */}
          <div className="fade-up d3 flex flex-col sm:flex-row items-center justify-center gap-4 mb-10">
            <a
              href="#install"
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3 text-sm font-semibold rounded-sm transition-opacity hover:opacity-85"
              style={{ background: 'var(--amber)', color: '#040300' }}
            >
              <Download className="w-4 h-4" />
              Install
            </a>
            <a
              href={GITHUB_REPO}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3 text-sm font-semibold rounded-sm transition-opacity hover:opacity-80"
              style={{ border: '1px solid var(--border-mid)', color: 'var(--text)', background: 'var(--surface)' }}
            >
              <Github className="w-4 h-4" />
              View GitHub
            </a>
          </div>

          {/* Inline install strip */}
          <div
            className="fade-up d4 inline-flex items-center gap-3 px-4 py-2.5 rounded-sm text-sm font-mono max-w-full overflow-x-auto"
            style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--amber)' }}
          >
            <span style={{ color: 'var(--text-3)', flexShrink: 0 }}>$</span>
            <span className="truncate">curl -fsSL {INSTALL_SH} | sh</span>
            <CopyBtn text={`curl -fsSL ${INSTALL_SH} | sh`} />
          </div>
        </div>

        {/* Scroll hint */}
        <div
          className="fade-up d5 absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2"
          style={{ color: 'var(--text-3)' }}
          aria-hidden="true"
        >
          <span className="text-[10px] font-mono tracking-widest uppercase">Scroll</span>
          <div
            className="scroll-line w-px h-8 origin-top"
            style={{ background: 'linear-gradient(to bottom, var(--text-3), transparent)' }}
          />
        </div>
      </section>

      {/* ── TERMINAL DEMO ───────────────────────────────── */}
      <section
        className="py-24 px-6"
        style={{ borderTop: '1px solid var(--border)' }}
      >
        <div className="max-w-4xl mx-auto">
          <div className="mb-12">
            <p
              className="text-xs font-mono tracking-widest uppercase mb-3"
              style={{ color: 'var(--amber)' }}
            >
              Demo
            </p>
            <h2
              className="font-display font-bold leading-tight"
              style={{ fontSize: 'clamp(24px, 4vw, 40px)' }}
            >
              The full workflow,
              <br />
              from your terminal.
            </h2>
          </div>

          <PhosphorTerminal />

          <p
            className="mt-4 text-xs font-mono text-center"
            style={{ color: 'var(--text-3)' }}
          >
            Mock provider shown — workflow testing only. Real audits require your own API keys.
          </p>
        </div>
      </section>

      {/* ── FEATURES ────────────────────────────────────── */}
      <section
        id="features"
        className="py-24 px-6"
        style={{ borderTop: '1px solid var(--border)' }}
      >
        <div className="max-w-4xl mx-auto">
          <div className="mb-16">
            <p
              className="text-xs font-mono tracking-widest uppercase mb-3"
              style={{ color: 'var(--amber)' }}
            >
              Capabilities
            </p>
            <h2
              className="font-display font-bold leading-tight"
              style={{ fontSize: 'clamp(24px, 4vw, 40px)' }}
            >
              What it measures.
              <br />
              What it generates.
            </h2>
          </div>

          {/* gap-px + bg = 1px grid lines */}
          <div
            className="grid md:grid-cols-2 gap-px"
            style={{ background: 'var(--border)' }}
          >
            {FEATURES.map(({ n, Icon, title, desc }) => (
              <div
                key={n}
                className="flex gap-5 py-8 px-6 group"
                style={{ background: 'var(--bg)' }}
              >
                <span
                  className="font-mono text-xs tracking-widest leading-none pt-1 flex-shrink-0 w-6"
                  style={{ color: 'var(--text-3)' }}
                >
                  {n}
                </span>
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <Icon
                      className="w-4 h-4 flex-shrink-0 transition-opacity group-hover:opacity-100"
                      style={{ color: 'var(--amber)', opacity: 0.75 }}
                    />
                    <h3 className="font-semibold text-sm" style={{ color: 'var(--text)' }}>
                      {title}
                    </h3>
                  </div>
                  <p className="text-sm leading-relaxed" style={{ color: 'var(--text-2)' }}>
                    {desc}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── PRIVACY ─────────────────────────────────────── */}
      <section
        id="privacy"
        className="py-24 px-6"
        style={{ borderTop: '1px solid var(--border)' }}
      >
        <div className="max-w-4xl mx-auto">
          <div className="grid md:grid-cols-2 gap-16 items-start">
            {/* Text */}
            <div>
              <p
                className="text-xs font-mono tracking-widest uppercase mb-3"
                style={{ color: 'var(--amber)' }}
              >
                Privacy
              </p>
              <h2
                className="font-display font-bold leading-tight mb-6"
                style={{ fontSize: 'clamp(24px, 4vw, 40px)' }}
              >
                Your data never
                <br />
                leaves your machine.
              </h2>
              <p
                className="text-sm leading-relaxed mb-8"
                style={{ color: 'var(--text-2)' }}
              >
                Project config, audit history, reports, and generated files stay local.
                Cloud providers are optional and use your own API keys. Mock mode
                works entirely offline — no API keys required.
              </p>
              <ul className="space-y-4">
                {[
                  'All project data stored in local directories',
                  'Cloud providers optional — use your own API keys',
                  'Mock mode works completely offline',
                ].map((item) => (
                  <li
                    key={item}
                    className="flex items-start gap-3 text-sm"
                    style={{ color: 'var(--text-2)' }}
                  >
                    <Check
                      className="w-4 h-4 flex-shrink-0 mt-0.5"
                      style={{ color: 'var(--amber)' }}
                    />
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            {/* File tree */}
            <div
              className="rounded-lg p-6 font-mono text-sm scanlines overflow-hidden relative"
              style={{ background: 'var(--surface)', border: '1px solid var(--border-mid)' }}
            >
              <div className="relative z-[1]">
                <div className="flex items-center gap-2 mb-5">
                  <Lock className="w-3.5 h-3.5" style={{ color: 'var(--amber)' }} />
                  <span
                    className="text-xs tracking-widest uppercase"
                    style={{ color: 'var(--text-2)' }}
                  >
                    local storage
                  </span>
                </div>
                <div style={{ color: 'var(--amber)', textShadow: '0 0 8px rgba(245,167,42,0.3)' }}>
                  ~/.ghostping/
                </div>
                <div className="pl-4 mt-2 space-y-1.5" style={{ color: 'rgba(245,167,42,0.45)' }}>
                  <div>├── config.toml</div>
                  <div>├── mentions.db</div>
                  <div>├── evidence.db</div>
                  <div>├── plugins/</div>
                  <div className="flex items-center gap-1">
                    └── cache/
                    <span
                      className="cursor w-2 h-[0.9em] inline-block ml-1 rounded-[1px]"
                      style={{ background: 'rgba(245,167,42,0.45)' }}
                    />
                  </div>
                </div>
                <div className="pl-4 mt-2 text-xs" style={{ color: 'var(--text-2)' }}>
                  reports/ and generated/ are written to your project directory, not here.
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── INSTALL ─────────────────────────────────────── */}
      <section
        id="install"
        className="py-24 px-6"
        style={{ borderTop: '1px solid var(--border)' }}
      >
        <div className="max-w-4xl mx-auto">
          <div className="mb-12">
            <p
              className="text-xs font-mono tracking-widest uppercase mb-3"
              style={{ color: 'var(--amber)' }}
            >
              Install
            </p>
            <h2
              className="font-display font-bold leading-tight mb-4"
              style={{ fontSize: 'clamp(24px, 4vw, 40px)' }}
            >
              Get running in seconds.
            </h2>
            <p className="text-sm" style={{ color: 'var(--text-2)' }}>
              Install via curl, PowerShell, or download a prebuilt binary from GitHub Releases.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-4 mb-6">
            <CodeBlock
              label="macOS / Linux"
              cmd={`curl -fsSL ${INSTALL_SH} | sh`}
            />
            <CodeBlock
              label="Windows (PowerShell)"
              cmd={`irm ${INSTALL_PS1} | iex`}
            />
          </div>

          {/* Manual download */}
          <div
            className="text-center py-6 rounded-lg mb-12"
            style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}
          >
            <p className="text-sm mb-4" style={{ color: 'var(--text-2)' }}>
              Or download prebuilt binaries manually
            </p>
            <a
              href={RELEASES_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-sm transition-opacity hover:opacity-80"
              style={{ border: '1px solid var(--border-mid)', color: 'var(--text)', background: 'var(--elevated)' }}
            >
              <Download className="w-4 h-4" />
              GitHub Releases
              <ExternalLink className="w-3.5 h-3.5" style={{ color: 'var(--text-3)' }} />
            </a>
          </div>

          {/* Quick start steps */}
          <div
            className="rounded-lg p-6 md:p-8"
            style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}
          >
            <p
              className="text-xs font-mono tracking-widest uppercase mb-6"
              style={{ color: 'var(--text-2)' }}
            >
              Quick Start
            </p>
            <ol className="space-y-5">
              {[
                { n: '1', cmd: 'ghostping init',                        desc: 'Initialize your project with name, website, and category' },
                { n: '2', cmd: 'ghostping prompts discover',            desc: 'Find high-intent prompts your audience uses' },
                { n: '3', cmd: 'ghostping audit run --models mock',     desc: 'Run a mock audit to test the workflow — no API keys needed' },
                { n: '4', cmd: 'ghostping report',                      desc: 'Generate a markdown evidence report' },
                { n: '5', cmd: 'ghostping generate',                    desc: 'Generate content assets from visibility gaps' },
              ].map(({ n, cmd, desc }) => (
                <li key={n} className="flex items-start gap-4">
                  <span
                    className="flex-shrink-0 w-6 h-6 rounded-sm flex items-center justify-center text-xs font-mono font-bold"
                    style={{ background: 'var(--elevated)', color: 'var(--text-3)', border: '1px solid var(--border)' }}
                  >
                    {n}
                  </span>
                  <div>
                    <code className="text-sm font-mono" style={{ color: 'var(--amber)' }}>
                      {cmd}
                    </code>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-2)' }}>
                      {desc}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      {/* ── DISCLAIMER ──────────────────────────────────── */}
      <section
        className="py-10 px-6"
        style={{ borderTop: '1px solid var(--border)' }}
      >
        <div className="max-w-4xl mx-auto">
          <div
            className="p-4 rounded-sm text-xs leading-relaxed font-mono"
            style={{ border: '1px solid var(--border)', color: 'var(--text-3)', background: 'var(--surface)' }}
          >
            <span style={{ color: 'var(--text-2)' }}>NOTICE: </span>
            Ghostping does not guarantee AI visibility. Results are probabilistic and depend on model
            training data, prompt variations, and timing. The mock provider is for workflow testing only
            and does not reflect real model behavior. Real provider audits require user-configured API keys.
            Always verify results independently before making strategic decisions.
          </div>
        </div>
      </section>

      {/* ── FOOTER ──────────────────────────────────────── */}
      <footer
        className="py-10 px-6"
        style={{ borderTop: '1px solid var(--border)' }}
      >
        <div className="max-w-4xl mx-auto">
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--amber)' }} />
              <span className="font-display font-bold text-sm tracking-[0.18em] uppercase">
                Ghostping
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-6 text-xs font-mono tracking-widest uppercase">
              {[
                { label: 'GitHub',   href: GITHUB_REPO,  Icon: Github   },
                { label: 'Docs',     href: DOCS_URL,     Icon: FileText  },
                { label: 'Releases', href: RELEASES_URL, Icon: Download  },
                { label: 'Privacy',  href: '#privacy',   Icon: Shield    },
              ].map(({ label, href, Icon }) => (
                <a
                  key={label}
                  href={href}
                  target={href.startsWith('http') ? '_blank' : undefined}
                  rel={href.startsWith('http') ? 'noopener noreferrer' : undefined}
                  className="flex items-center gap-1.5 transition-opacity hover:opacity-100"
                  style={{ color: 'var(--text-2)', opacity: 0.75 }}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </a>
              ))}
            </div>
          </div>

          <div
            className="mt-8 text-xs font-mono"
            style={{ color: 'var(--text-3)' }}
          >
            © {new Date().getFullYear()} Ghostping — MIT License
          </div>
        </div>
      </footer>

    </main>
  );
}
