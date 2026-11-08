export const overviewSourceFreshness = (
  revisionId: number | null,
  savedFingerprint: string,
  currentFingerprint: string | null
): "fresh" | "stale" | "unknown" => {
  if (revisionId === null) return "unknown"
  return savedFingerprint === currentFingerprint ? "fresh" : "stale"
}
