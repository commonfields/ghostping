// OpenRecord public homepage. Sells exactly what exists: a shareable,
// human-reviewed evidence record per client, checked weekly on one live AI
// surface. No demo data, no scores, no future infrastructure.

// Set at build time; the pilot button only appears with a real address.
const CONTACT_EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? ''
const GITHUB_REPO = 'https://github.com/commonfields/openrecord'

const STEPS = [
  {
    title: 'Approve three facts with your client',
    body: 'Check-in time, whether breakfast is included, the free-shipping threshold — whatever matters to the business, with the page where it is published.',
  },
  {
    title: 'Ask one live AI surface one question per fact',
    body: 'Gemini with Google Search grounding answers the question a buyer would ask. OpenRecord keeps the exact answer, the sources it cited, and whether it actually searched the web.',
  },
  {
    title: 'A person reviews every answer',
    body: 'You mark each answer Matches, Contradicts or Unknown. Unknown stays unknown. Nothing reaches your client until it has been reviewed.',
  },
  {
    title: 'Fix what you control, then check again',
    body: 'Record what you changed. A week later OpenRecord asks the same question on the same surface, you review the new answer, and the record shows what happened.',
  },
]

const RECORD_FIELDS = [
  ['Approved fact', 'What the business stands behind, and where it is published.'],
  ['Question', 'The buyer-style question that was asked, word for word.'],
  ['AI answer', 'The raw answer, exactly as returned. Never summarized.'],
  ['Sources', 'The pages the AI cited, and whether live web search was used.'],
  ['Judgment', 'Matches, Contradicts or Unknown — decided by a person.'],
  ['Weekly re-check', 'Before, your action, after, and the observed outcome.'],
]

const OUTCOMES = [
  ['Observed correction', 'The earlier answer contradicted the approved fact; the later one matches it.'],
  ['No observed change', 'Both answers say the same thing about the fact.'],
  ['Indeterminate', 'The evidence cannot support either conclusion — for example, the answer did not use live web search, the check failed, or the answer could not be judged. Shown, with the reason.'],
]

function Section({ id, label, title, children }: { id?: string; label: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="px-6 py-20 md:py-28" style={{ borderTop: '1px solid var(--border)' }}>
      <div className="mx-auto max-w-4xl space-y-10">
        <div className="space-y-3">
          <p className="font-mono text-xs uppercase tracking-[0.25em]" style={{ color: 'var(--amber)' }}>{label}</p>
          <h2 className="font-display text-3xl font-bold md:text-4xl">{title}</h2>
        </div>
        {children}
      </div>
    </section>
  )
}

export default function Page() {
  return (
    <main style={{ background: 'var(--bg)', color: 'var(--text)', minHeight: '100vh' }}>
      <nav
        className="fixed left-0 right-0 top-0 z-50 flex h-14 items-center justify-between px-6 md:px-10"
        style={{ background: 'rgba(6,6,6,0.90)', backdropFilter: 'blur(14px)', borderBottom: '1px solid var(--border)' }}
      >
        <span className="font-display text-sm font-bold uppercase tracking-[0.18em]">OpenRecord</span>
        <div className="flex items-center gap-8 font-mono text-xs uppercase tracking-widest" style={{ color: 'var(--text-2)' }}>
          <a href="#how" className="hidden hover:opacity-100 md:inline">How it works</a>
          <a href="#record" className="hidden hover:opacity-100 md:inline">The record</a>
          <a href="#pilot" className="hover:opacity-100">Pilot</a>
        </div>
      </nav>

      <section className="flex min-h-[88vh] flex-col justify-center px-6 pt-14">
        <div className="mx-auto max-w-4xl space-y-8">
          <p className="fade-up d0 font-mono text-xs uppercase tracking-[0.25em]" style={{ color: 'var(--amber)' }}>For agencies</p>
          <h1 className="fade-up d1 font-display text-4xl font-extrabold leading-[1.05] md:text-6xl">
            Show clients exactly what AI said before and after your work.
          </h1>
          <p className="fade-up d2 max-w-2xl text-lg md:text-xl" style={{ color: 'var(--text-2)' }}>
            OpenRecord gives agencies a shareable evidence record: the approved fact, the raw AI answer, its source,
            a human judgment, and the next weekly check.
          </p>
          <ul className="fade-up d3 flex flex-wrap gap-x-8 gap-y-2 font-mono text-sm">
            <li>No visibility score.</li>
            <li>No causal promises.</li>
            <li>Raw evidence stays attached.</li>
          </ul>
        </div>
      </section>

      <Section id="how" label="How it works" title="One record per client, checked weekly">
        <ol className="grid gap-6 md:grid-cols-2">
          {STEPS.map((s, i) => (
            <li key={s.title} className="space-y-2 rounded-lg p-6" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
              <p className="font-mono text-xs" style={{ color: 'var(--amber)' }}>0{i + 1}</p>
              <h3 className="font-semibold">{s.title}</h3>
              <p className="text-sm" style={{ color: 'var(--text-2)' }}>{s.body}</p>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="record" label="The record" title="A link you can forward to your client">
        <p className="max-w-2xl" style={{ color: 'var(--text-2)' }}>
          Each client gets one read-only URL. It reads like evidence, not software: no dashboard, no charts, no login.
          You can revoke it at any time.
        </p>
        <dl className="grid gap-px overflow-hidden rounded-lg md:grid-cols-2" style={{ background: 'var(--border)', border: '1px solid var(--border)' }}>
          {RECORD_FIELDS.map(([term, desc]) => (
            <div key={term} className="space-y-1 p-6" style={{ background: 'var(--surface)' }}>
              <dt className="font-semibold">{term}</dt>
              <dd className="text-sm" style={{ color: 'var(--text-2)' }}>{desc}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section label="Outcomes" title="Three honest outcomes">
        <dl className="space-y-6">
          {OUTCOMES.map(([term, desc]) => (
            <div key={term} className="grid gap-2 md:grid-cols-[14rem_1fr]">
              <dt className="font-semibold">{term}</dt>
              <dd style={{ color: 'var(--text-2)' }}>{desc}</dd>
            </div>
          ))}
        </dl>
        <p className="rounded-lg p-5 text-sm" style={{ border: '1px solid var(--amber-ring)', background: 'var(--amber-low)' }}>
          Every before-and-after comparison carries this sentence: “This shows what OpenRecord observed before and after the change.
          It does not prove that the edit caused the model&apos;s new answer.”
        </p>
      </Section>

      <Section id="pilot" label="Pilot" title="Three clients, four weekly checks">
        <p className="max-w-2xl" style={{ color: 'var(--text-2)' }}>
          OpenRecord is delivered as a manually operated service: three of your clients, four weekly checks on one live AI surface,
          and a shareable record for each client.
        </p>
        {CONTACT_EMAIL ? (
          <a
            href={`mailto:${CONTACT_EMAIL}?subject=OpenRecord%20pilot`}
            className="inline-block rounded-md px-5 py-3 font-semibold"
            style={{ background: 'var(--amber)', color: '#060606' }}
          >
            Ask about a pilot
          </a>
        ) : null}
      </Section>

      <footer className="px-6 py-10 text-xs" style={{ borderTop: '1px solid var(--border)', color: 'var(--text-2)' }}>
        <div className="mx-auto flex max-w-4xl flex-wrap justify-between gap-4">
          <span>OpenRecord</span>
          <a href={GITHUB_REPO} target="_blank" rel="noopener noreferrer" className="hover:opacity-100">Source on GitHub</a>
        </div>
      </footer>
    </main>
  )
}
