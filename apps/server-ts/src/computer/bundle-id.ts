const segmentsOf = (bundleId: string): ReadonlyArray<string> => bundleId.split(".")

export const bundleName = (bundleId: string): string => segmentsOf(bundleId).at(-1) || bundleId

export const bundleWithin = (bundleId: string, family: string): boolean => {
  const parts = segmentsOf(bundleId.toLowerCase())
  return segmentsOf(family).every((part, index) => parts[index] === part)
}
