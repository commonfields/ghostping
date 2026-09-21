import { View } from "../App";

const items: { id: View; label: string; icon: string; desc: string }[] = [
  { id: "audit",    label: "Audit",    icon: "🔍", desc: "Check visibility" },
  { id: "optimize", label: "Optimize", icon: "⚡", desc: "5-step GEO agent" },
  { id: "generate", label: "Generate", icon: "✍️", desc: "Create content" },
  { id: "projects", label: "Projects", icon: "📁", desc: "Saved domains" },
];

const styles: Record<string, React.CSSProperties> = {
  sidebar: {
    width: 200,
    minWidth: 200,
    background: "#010409",
    borderRight: "1px solid #21262d",
    display: "flex",
    flexDirection: "column",
    padding: "16px 0",
  },
  logo: {
    padding: "12px 20px 24px",
    fontWeight: 700,
    fontSize: 15,
    letterSpacing: "0.05em",
    color: "#58a6ff",
    borderBottom: "1px solid #21262d",
    marginBottom: 12,
  },
  nav: { flex: 1 },
  item: (active: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 20px",
    cursor: "pointer",
    background: active ? "#161b22" : "transparent",
    borderLeft: active ? "2px solid #58a6ff" : "2px solid transparent",
    color: active ? "#e6edf3" : "#8b949e",
    transition: "all 0.15s",
  }),
  icon: { fontSize: 16 },
  label: { fontWeight: 600, fontSize: 13 },
  desc: { fontSize: 11, color: "#484f58", marginTop: 1 },
  footer: {
    padding: "12px 20px",
    fontSize: 11,
    color: "#484f58",
    borderTop: "1px solid #21262d",
  },
};

interface Props {
  active: View;
  onChange: (v: View) => void;
}

export default function Sidebar({ active, onChange }: Props) {
  return (
    <div style={styles.sidebar}>
      <div style={styles.logo}>Ghostping</div>
      <nav style={styles.nav}>
        {items.map((item) => (
          <div
            key={item.id}
            style={styles.item(active === item.id)}
            onClick={() => onChange(item.id)}
          >
            <span style={styles.icon}>{item.icon}</span>
            <div>
              <div style={styles.label}>{item.label}</div>
              <div style={styles.desc}>{item.desc}</div>
            </div>
          </div>
        ))}
      </nav>
      <div style={styles.footer}>v0.3.0 · local-first</div>
    </div>
  );
}
