import { useState } from "react";
import Sidebar from "./components/Sidebar";
import AuditPanel from "./components/AuditPanel";
import OptimizePanel from "./components/OptimizePanel";
import GeneratePanel from "./components/GeneratePanel";
import ProjectsPanel from "./components/ProjectsPanel";

export type View = "audit" | "optimize" | "generate" | "projects" | "onboarding";

const TAGLINE = "The private, local-first GEO companion for indie builders — track, generate, and optimize your visibility in AI answers.";

const onboardingStyles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "48px",
    textAlign: "center",
  },
  title: {
    fontSize: 28,
    fontWeight: 700,
    marginBottom: 16,
    color: "#e6edf3",
  },
  tagline: {
    fontSize: 16,
    color: "#8b949e",
    maxWidth: 600,
    lineHeight: 1.6,
    marginBottom: 32,
  },
  card: {
    background: "#161b22",
    border: "1px solid #30363d",
    borderRadius: 12,
    padding: 24,
    maxWidth: 500,
    width: "100%",
    marginBottom: 24,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: 600,
    marginBottom: 12,
    color: "#e6edf3",
  },
  step: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginBottom: 8,
  },
  stepNum: {
    width: 24,
    height: 24,
    borderRadius: "50%",
    background: "#238636",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 12,
    fontWeight: 600,
  },
  stepText: {
    fontSize: 14,
    color: "#e6edf3",
  },
  cmd: {
    fontFamily: "monospace",
    background: "#0d1117",
    padding: "4px 8px",
    borderRadius: 4,
    fontSize: 13,
    color: "#58a6ff",
  },
  btn: {
    background: "#238636",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "12px 24px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    marginTop: 16,
  },
  muted: {
    color: "#8b949e",
    fontSize: 13,
  },
};

function Onboarding({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div style={onboardingStyles.container}>
      <h1 style={onboardingStyles.title}>Welcome to OpenRecord</h1>
      <p style={onboardingStyles.tagline}>{TAGLINE}</p>
      
      <div style={onboardingStyles.card}>
        <div style={onboardingStyles.cardTitle}>Quick Start</div>
        <div style={onboardingStyles.step}>
          <span style={onboardingStyles.stepNum}>1</span>
          <span style={onboardingStyles.stepText}>Run <code style={onboardingStyles.cmd}>openrecord config</code> to create config</span>
        </div>
        <div style={onboardingStyles.step}>
          <span style={onboardingStyles.stepNum}>2</span>
          <span style={onboardingStyles.stepText}>Add your API key in <code style={onboardingStyles.cmd}>~/.openrecord/config.toml</code></span>
        </div>
        <div style={onboardingStyles.step}>
          <span style={onboardingStyles.stepNum}>3</span>
          <span style={onboardingStyles.stepText}>Run <code style={onboardingStyles.cmd}>openrecord doctor</code> to verify</span>
        </div>
        <div style={onboardingStyles.step}>
          <span style={onboardingStyles.stepNum}>4</span>
          <span style={onboardingStyles.stepText}>Add a project in the Projects tab and run audit</span>
        </div>
      </div>

      <p style={onboardingStyles.muted}>
        Free option: <code style={onboardingStyles.cmd}>ollama pull llama3.2</code> then set{" "}
        <code style={onboardingStyles.cmd}>enabled = true</code> under{" "}
        <code style={onboardingStyles.cmd}>[providers.ollama]</code> in config.
      </p>

      <p style={{ ...onboardingStyles.muted, maxWidth: 560, marginTop: 12, lineHeight: 1.5 }}>
        <strong style={{ color: "#e6edf3" }}>Honest note:</strong>{" "}
        OpenRecord improves your <em>probability</em> of being cited by LLMs —
        it does not guarantee it. Results depend on content quality and model behavior.
        Audit regularly and iterate.
      </p>

      <button style={onboardingStyles.btn} onClick={onDismiss}>
        Get Started
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  app: {
    display: "flex",
    height: "100vh",
    background: "#0d1117",
    color: "#e6edf3",
    overflow: "hidden",
  },
  main: {
    flex: 1,
    overflowY: "auto",
    padding: "32px",
  },
};

export default function App() {
  const [view, setView] = useState<View>("audit");
  const [hasSeenOnboarding, setHasSeenOnboarding] = useState(false);

  if (!hasSeenOnboarding) {
    return (
      <div style={styles.app}>
        <div style={{ flex: 1, display: "flex" }}>
          <Onboarding onDismiss={() => setHasSeenOnboarding(true)} />
        </div>
      </div>
    );
  }

  return (
    <div style={styles.app}>
      <Sidebar active={view} onChange={setView} />
      <main style={styles.main}>
        {view === "audit" && <AuditPanel />}
        {view === "optimize" && <OptimizePanel />}
        {view === "generate" && <GeneratePanel />}
        {view === "projects" && <ProjectsPanel />}
      </main>
    </div>
  );
}
