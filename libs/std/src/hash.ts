import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"

export const sha256Hex = (input: string | Uint8Array): string =>
  createHash("sha256").update(input).digest("hex")

export const sha256Base64Url = (input: string | Uint8Array): string =>
  createHash("sha256").update(input).digest("base64url")

export const sha256Bytes = (input: string | Uint8Array): Buffer =>
  createHash("sha256").update(input).digest()

export const hashFile = async (path: string): Promise<string> => {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}
