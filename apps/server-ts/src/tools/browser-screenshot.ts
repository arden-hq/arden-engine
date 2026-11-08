import { ToolExecutionError, type ToolResultOutput } from "@arden-hq/loop"
import { Effect, Schema } from "effect"

import { ScreenshotCaptureSchema, type ConversationArtifacts } from "../artifacts/conversation.js"
import type { BrowserOutput } from "../browser/service.js"
import { OPENAI_IMAGE_INPUT, fitPng } from "../lib/prompt-image.js"
import { toolFailure } from "./tool-failure.js"

const visualizationReference = (manifest: {
  readonly ref: string
  readonly title: string
  readonly summary: string
  readonly mode: "normal" | "wide"
}): string =>
  `visualize${JSON.stringify({
    ref: manifest.ref,
    title: manifest.title,
    summary: manifest.summary,
    mode: manifest.mode
  })}`

export const preserveBrowserScreenshot = async (input: {
  readonly output: BrowserOutput
  readonly artifacts: ConversationArtifacts["Service"]
  readonly sessionId: string
  readonly runId: string
  readonly toolCallId: string
  readonly signal: AbortSignal
}): Promise<ToolResultOutput> => {
  const capture = Schema.decodeUnknownExit(ScreenshotCaptureSchema)(input.output.data)
  const image = input.output.modelContent?.find((block) => block.type === "image")
  if (capture._tag === "Failure" || image === undefined || image.media_type !== "image/png") {
    throw new ToolExecutionError("Browser screenshot returned no PNG or capture metadata", {
      preview: "Screenshot unavailable",
      retryable: true
    })
  }
  const bytes = Buffer.from(image.data, "base64")
  const manifest = await Effect.runPromise(
    input.artifacts
      .createImage({
        sessionId: input.sessionId,
        producerRunId: input.runId,
        toolCallId: input.toolCallId,
        source: { kind: "bytes", bytes },
        capture: capture.value,
        title: "Browser screenshot",
        summary: `Captured ${capture.value.url}`.slice(0, 500),
        mode: "normal",
        role: "working"
      })
      .pipe(
        Effect.mapError((error) =>
          toolFailure(
            {
              reason: error.reason,
              message: `The browser captured an image, but it could not be preserved: ${error.message}`
            },
            "Screenshot could not be saved"
          )
        )
      ),
    { signal: input.signal }
  )
  const fitted = fitPng({ bytes, limits: OPENAI_IMAGE_INPUT })
  const modelImage =
    fitted === undefined ? image : { ...image, data: fitted.data.toString("base64") }
  return {
    result: [
      input.output.result,
      ...(fitted === undefined ? [] : modelCopyNote(fitted)),
      `Saved screenshot as artifact_ref ${manifest.ref}.`,
      `Source: ${capture.value.url}\nCaptured at: ${capture.value.captured_at}`,
      "Use artifact_export with this artifact_ref and a destination path to reuse the PNG in project files. No manual saving is needed.",
      "To display it in chat, include this exact reference on its own line:",
      visualizationReference(manifest)
    ].join("\n"),
    preview: "Screenshot saved",
    data: {
      ...input.output.data,
      artifact_ref: manifest.ref,
      media_type: manifest.media_type,
      sha256: manifest.sha256,
      byte_length: manifest.byte_length
    },
    model_content: [modelImage]
  }
}

const modelCopyNote = (fitted: NonNullable<ReturnType<typeof fitPng>>): ReadonlyArray<string> => {
  const { source, size } = fitted
  if (source.width === size.width && source.height === size.height) return []
  return [
    `The image you see is the full ${source.width}x${source.height} viewport, shown at ${size.width}x${size.height}. Fractional pointer coordinates use the whole image.`
  ]
}
