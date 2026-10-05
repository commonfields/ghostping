import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { card, input, btn, heading, muted, pre } from "./styles";

interface SectionResult {
  prompt: string;
  content: string;
  model: string;
  citability_rate: number;
  file_name: string;
}

interface OptimizeResult {
  domain: string;
  niche: string;
  current_mention_rate: number;
  avg_citability: number;
  sections: SectionResult[];
}

export default function OptimizePanel() {
  const [domain, setDomain] = useState("");
  const [niche, setNiche] = useState("");
  const [competitors, setCompetitors] = useState("");
  const [steps, setSteps] = useState("3");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<OptimizeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SectionResult | null>(null);

  async function run() {
    if (!domain.trim() || !niche.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setSelected(null);
    try {
      const r = await invoke<OptimizeResult>("run_optimize", {
        domain: domain.trim(),
        niche: niche.trim(),
        competitors: competitors.trim() || null,
        steps: parseInt(steps, 10),
        models: null,
      });
      setResult(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  const lift = result ? result.avg_citability - result.current_mention_rate : 0;
  const liftColor = lift >= 40 ? "#3fb950" : lift >= 20 ? "#d29922" : "#8b949e";

  return (
    <div>
      <h1 style={heading}>Optimize</h1>
      <p style={muted}>5-step GEO agent: discover prompts → audit → generate content → evaluate lift.</p>

      <div style={card}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
          <input style={{ ...input, flex: "1 1 180px" }} placeholder="Domain *" value={domain}
            onChange={e => setDomain(e.target.value)} />
          <input style={{ ...input, flex: "1 1 180px" }} placeholder="Niche *" value={niche}
            onChange={e => setNiche(e.target.value)} />
          <input style={{ ...input, flex: "1 1 160px" }} placeholder="Competitors (comma-sep)" value={competitors}
            onChange={e => setCompetitors(e.target.value)} />
          <input style={{ ...input, width: 70 }} placeholder="Steps" value={steps}
            onChange={e => setSteps(e.target.value)} type="number" min={1} max={10} />
          <button style={btn} onClick={run} disabled={loading || !domain.trim() || !niche.trim()}>
            {loading ? "Running agent…" : "Run Optimize"}
          </button>
        </div>
        {error && <div style={{ color: "#f85149", fontSize: 13 }}>Error: {error}</div>}
        {loading && (
          <div style={{ fontSize: 12, color: "#8b949e", marginTop: 8 }}>
            Running 5-step optimization… this may take 1–3 minutes.
          </div>
        )}
      </div>

      {result && (
        <>
          <div style={{ ...card, display: "flex", gap: 40 }}>
            <div>
              <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 4 }}>Current visibility</div>
              <div style={{ fontSize: 32, fontWeight: 700, color: "#8b949e" }}>
                {result.current_mention_rate.toFixed(0)}%
              </div>
            </div>
            <div style={{ fontSize: 28, color: "#30363d", alignSelf: "center" }}>→</div>
            <div>
              <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 4 }}>Projected citability</div>
              <div style={{ fontSize: 32, fontWeight: 700, color: "#3fb950" }}>
                {result.avg_citability.toFixed(0)}%
              </div>
            </div>
            <div style={{ fontSize: 28, fontWeight: 700, color: liftColor, alignSelf: "center" }}>
              +{lift.toFixed(0)}pp
            </div>
          </div>

          <div style={card}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#8b949e", marginBottom: 12 }}>
              Generated sections — click to preview
            </div>
            {result.sections.map((s, i) => (
              <div key={i}
                onClick={() => setSelected(selected?.prompt === s.prompt ? null : s)}
                style={{
                  padding: "10px 14px",
                  borderRadius: 6,
                  marginBottom: 8,
                  cursor: "pointer",
                  background: selected?.prompt === s.prompt ? "#0d1117" : "#1c2128",
                  border: `1px solid ${selected?.prompt === s.prompt ? "#58a6ff" : "#21262d"}`,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{s.prompt}</div>
                  <div style={{ fontSize: 11, color: "#8b949e", marginTop: 2 }}>{s.file_name}</div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 700,
                  color: s.citability_rate >= 70 ? "#3fb950" : s.citability_rate >= 40 ? "#d29922" : "#f85149" }}>
                  {s.citability_rate.toFixed(0)}%
                </div>
              </div>
            ))}
          </div>

          {selected && (
            <div style={card}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{selected.prompt}</div>
                <div style={{ fontSize: 11, color: "#8b949e" }}>by {selected.model}</div>
              </div>
              <pre style={pre}>{selected.content}</pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}
