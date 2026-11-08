import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"

/** SHA-256 of text (as UTF-8) or bytes, as lowercase hex. */
export const sha256Hex = (input: string | Uint8Array): string =>
  createHash("sha256").update(input).digest("hex")

/** SHA-256 of text (as UTF-8) or bytes, as unpadded base64url. */
export const sha256Base64Url = (input: string | Uint8Array): string =>
  createHash("sha256").update(input).digest("base64url")

/** SHA-256 of text (as UTF-8) or bytes, as raw bytes. */
export const sha256Bytes = (input: string | Uint8Array): Buffer =>
  createHash("sha256").update(input).digest()

/** SHA-256 of a file's bytes, read as a stream, as lowercase hex. */
export const hashFile = async (path: string): Promise<string> => {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}
