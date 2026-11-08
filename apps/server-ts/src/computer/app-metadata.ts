import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Schema } from "effect"
import type { ComputerStatus } from "@arden-hq/protocol/computer"

const execute = promisify(execFile)
const decode = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.NullOr(Schema.Struct({ name: Schema.String, icon: Schema.String })))
)
// NSRunningApplication reads identity without Apple Events or app activation.
const script = `ObjC.import('AppKit');function run(args){var app=$.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(args[0]));if(app.isNil())return 'null';var icon=$.NSImage.alloc.initWithSize($.NSMakeSize(32,32));icon.lockFocus;app.icon.drawInRectFromRectOperationFraction($.NSMakeRect(0,0,32,32),$.NSZeroRect,$.NSCompositingOperationCopy,1);icon.unlockFocus;var rep=$.NSBitmapImageRep.imageRepWithData(icon.TIFFRepresentation);var data=rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG,$({}));return JSON.stringify({name:ObjC.unwrap(app.localizedName),icon:'data:image/png;base64,'+ObjC.unwrap(data.base64EncodedStringWithOptions(0))});}`

export async function nativeAppMetadata({
  pid,
  signal
}: {
  pid: number
  signal: AbortSignal
}): Promise<ComputerStatus["application"]> {
  return execute("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, String(pid)], {
    signal,
    timeout: 3000,
    maxBuffer: 64_000
  })
    .then(({ stdout }) => decode(stdout))
    .catch(() => null)
}
