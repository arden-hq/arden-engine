import { Buffer } from "node:buffer"

export const encodeSnapshotJson = (
  value: unknown
): { readonly data: string; readonly bytes: number } => {
  const data = JSON.stringify(value)
  if (data === undefined) throw new TypeError("Snapshot value cannot be encoded as JSON")
  return { data, bytes: Buffer.byteLength(data, "utf8") }
}

export const snapshotJsonBytes = (value: unknown): number => encodeSnapshotJson(value).bytes
