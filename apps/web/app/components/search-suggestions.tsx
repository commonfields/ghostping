// Google supplies the search-suggestion widget with grounded answers.
// Keep provider HTML in an opaque sandbox, with no scripts, same-origin
// access, forms, resource fetches, or navigation of the containing record.
export function SearchSuggestions({ html }: { html: string | null }) {
  if (!html) return null
  const policy = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
  return <iframe title="Google Search suggestions" className="h-40 w-full border-0"
    sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer"
    srcDoc={`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"></head><body>${html}</body></html>`} />
}
