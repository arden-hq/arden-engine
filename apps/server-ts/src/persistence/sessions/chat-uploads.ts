const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const UPLOAD_REFERENCE = new RegExp(`/uploads/(${UUID})/`, "g")
const UPLOAD_ID = new RegExp(`^${UUID}$`)

export const uploadIdsIn = (text: string): ReadonlyArray<string> => [
  ...new Set(
    Array.from(text.matchAll(UPLOAD_REFERENCE)).flatMap((match) =>
      match[1] === undefined ? [] : [match[1]]
    )
  )
]

export const isUploadId = (value: string): boolean => UPLOAD_ID.test(value)
