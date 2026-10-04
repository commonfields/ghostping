// Candidate-group counting V1. The run counter and the read model must use
// the same logical candidate identity: one candidate per page + lineage
// root. Raw match-event counts (e.g. 17 occurrences of "$59") must never
// reach candidates_found or the UI.

/** Count distinct candidate groups (page + lineage) in a match list. */
export const countCandidateGroups = (
  matches: ReadonlyArray<{ readonly pageKey: string; readonly lineageRootFactId: string }>,
): number => {
  const groups = new Set<string>()
  for (const m of matches) groups.add(`${m.pageKey} ${m.lineageRootFactId}`)
  return groups.size
}
