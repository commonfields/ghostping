import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { card, input, btn, heading, muted } from "./styles";

interface AuditResult {
  domain: string;
  mention_rate: number;
  mention_count: number;
  total_queries: number;
  citation_count: number;
  models_with_mention: string[];
}

export default function AuditPanel() {
  const [domain, setDomain] = useState("");
  const [niche, setNiche] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!domain.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const r = await invoke<AuditResult>("run_audit", {
        domain: domain.trim(),
        niche: niche.trim() || null,
        models: null,
      });
      setResult(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  const rate = result?.mention_rate ?? 0;
  const rateColor = rate >= 60 ? "#3fb950" : rate >= 30 ? "#d29922" : "#f85149";

  return (
    <div>
      <h1 style={heading}>Audit Visibility</h1>
      <p style={muted}>Query all configured LLMs and measure how often they mention your brand.</p>

      <div style={card}>
        <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
          <input
            style={{ ...input, flex: 2 }}
            placeholder="Domain (e.g. myproject.com)"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
          />
          <input
            style={{ ...input, flex: 1 }}
            placeholder="Niche (optional)"
            value={niche}
            onChange={(e) => setNiche(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
          />
          <button style={btn} onClick={run} disabled={loading || !domain.trim()}>
            {loading ? "Running…" : "Run Audit"}
          </button>
        </div>

        {error && (
          <div style={{ color: "#f85149", fontSize: 13, marginTop: 8 }}>
            Error: {error}
          </div>
        )}
      </div>

      {result && (
        <div style={card}>
          <div style={{ fontSize: 13, color: "#8b949e", marginBottom: 16 }}>
            {result.domain} · {result.total_queries} queries
          </div>
          <div style={{ fontSize: 48, fontWeight: 700, color: rateColor, marginBottom: 4 }}>
            {rate.toFixed(0)}%
          </div>
          <div style={muted}>mention rate</div>

          <div style={{ display: "flex", gap: 24, marginTop: 20 }}>
            <Stat label="Mentions" value={`${result.mention_count}/${result.total_queries}`} />
            <Stat label="Citations" value={String(result.citation_count)} />
            <Stat
              label="Models"
              value={
                result.models_with_mention.length > 0
                  ? result.models_with_mention.join(", ")
                  : "none"
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 2 }}>{label}</div>
      <div style={{ fontWeight: 600, color: "#e6edf3" }}>{value}</div>
    </div>
  );
}
