export const excerptSpan = (
  text: string,
  stated: { readonly start: number; readonly end: number; readonly excerpt: string }
): { readonly start: number; readonly end: number } | undefined => {
  if (stated.excerpt.length === 0) return undefined
  if (text.slice(stated.start, stated.end) === stated.excerpt)
    return { start: stated.start, end: stated.end }
  let nearest: number | undefined
  for (
    let at = text.indexOf(stated.excerpt);
    at !== -1;
    at = text.indexOf(stated.excerpt, at + 1)
  ) {
    if (nearest === undefined || Math.abs(at - stated.start) < Math.abs(nearest - stated.start))
      nearest = at
  }
  return nearest === undefined
    ? undefined
    : { start: nearest, end: nearest + stated.excerpt.length }
}
