export const MAX_RECIPIENTS = 50
const APPROVAL_RECIPIENT_FIELD_CHARS = 4_000

export const recipientPresentationFields = (
  label: "To" | "Cc",
  recipients: ReadonlyArray<string>
): ReadonlyArray<{ readonly label: string; readonly value: string }> => {
  const chunks: string[] = []
  let current = ""
  for (const recipient of recipients) {
    const candidate = current === "" ? recipient : `${current}, ${recipient}`
    if (candidate.length <= APPROVAL_RECIPIENT_FIELD_CHARS) {
      current = candidate
      continue
    }
    if (current !== "") chunks.push(current)
    current = recipient
  }
  if (current !== "") chunks.push(current)
  return chunks.map((value, index) => ({
    label: index === 0 ? label : `${label} ${index + 1}`,
    value
  }))
}
