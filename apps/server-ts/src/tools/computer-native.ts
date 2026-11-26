import { nativeVisual, nativeFeedback } from "../computer/feedback.js"
import { randomUUID } from "node:crypto"
import { CONTENT_BLOCK_TYPE, ToolExecutionError } from "@arden-hq/loop"
import { Schema } from "effect"
import {
  NATIVE_ACTION,
  NATIVE_DELIVERY,
  NATIVE_DRIVER_TOOL,
  type NativeAction,
  NativeActionSchema,
  nativeDriverAction,
  nativeDelivery,
  requireForegroundWindow
} from "../computer/contract.js"
import { DESKTOP, labelled, windowSurface, type ComputerControl } from "../computer/control.js"
import type { NativeDriver } from "../computer/driver.js"
import { defineServerTool, type ServerTool, type ServerToolMetadataInput } from "./define.js"
import { waivesRequirement } from "../execution/decide.js"
import { nativeActImpact } from "./input-impact.js"
import {
  actStep,
  appNameOf,
  actionQuestion,
  actionWords,
  findStep,
  keyChord,
  lookStep,
  pastTitle
} from "../computer/step.js"
import { appTarget, launchedAppTarget } from "./action-targets.js"
import { currentMillis } from "../runtime/clock.js"
import { ownWindowIssue } from "../computer/own-windows.js"
import { NATIVE_READ, ReadSchema } from "./computer-native-schemas.js"
import {
  actTarget,
  actionLabel,
  changedFrames,
  elementNames,
  foregroundCard,
  isConfirmed,
  isState,
  output
} from "./computer-native-results.js"

const ACT_METADATA = {
  effect: "external",
  display_name: "Use app",
  kind: "computer",
  action: "execute",
  source: "_computer",
  changes_state: true,
  target: "reported",
  concurrency_group: "computer",
  destructive: false,
  policy_scope: "external",
  open_world: true,
  idempotent: false,
  default_approval: "ask",
  approval_bypass: true,
  refuse_unattended: true
} satisfies ServerToolMetadataInput

export const computerNativeTools = (
  driver: NativeDriver,
  control: ComputerControl
): ReadonlyArray<ServerTool> => {
  const changed = changedFrames()
  const notOwnWindow = <A extends object>() =>
    Schema.makeFilter<A>((input) => ownWindowIssue(input, driver.ownPid) ?? true)
  const actPrompt = (input: NativeAction, sessionId: string) => {
    const seen = driver.observations.peek(sessionId, input.observation)
    const element =
      "element" in input && input.element !== undefined
        ? (seen?.elements.get(input.element) ?? "An element of the window")
        : "The whole window"
    return {
      presentation: {
        title: actionQuestion(input, seen?.app ?? "this app"),
        fields: [
          {
            label: "Window",
            value:
              seen?.window ??
              seen?.label ??
              `Process ${input.target.pid}, window ${input.target.window_id}`
          },
          { label: "Action", value: actionWords(input) },
          ...(input.action === NATIVE_ACTION.menu
            ? [{ label: "Menu", value: input.path.join(" → ") }]
            : []),
          {
            label: "Control",
            value:
              nativeDelivery(input) === NATIVE_DELIVERY.background
                ? "Background, your mouse and keyboard stay free"
                : "Foreground, may interrupt your work"
          },
          { label: "Target", value: element },
          ...(input.action === NATIVE_ACTION.key ? [{ label: "Keys", value: keyChord(input) }] : [])
        ],
        ...(input.action === NATIVE_ACTION.type
          ? { body: { label: "Text to enter", text: input.text } }
          : {}),
        ...(input.action === NATIVE_ACTION.set_value
          ? { body: { label: "New value", text: input.value } }
          : {})
      },
      data: {
        target: input.target,
        observation: input.observation,
        delivery: input.delivery,
        ...actTarget(input, seen)
      }
    }
  }
  return [
    defineServerTool({
      name: "computer_clipboard_write",
      summary: "Puts text on your clipboard so it can be pasted.",
      discovery: { group: "computer_control" },
      description:
        "Replace the system clipboard with plain text for a native paste, including tabs and newlines. This changes the shared clipboard; it does not paste, read, save, or restore previous clipboard contents. Observe the destination and use its Paste command, then verify the application result.",
      parameters: Schema.toStandardSchemaV1(
        Schema.Struct({
          text: Schema.String.check(Schema.isMaxLength(32_000)).annotate({
            description:
              "Plain text to put on the clipboard (up to 32,000 characters). Tabs and newlines are kept."
          })
        })
      ),
      metadata: {
        effect: "external",
        display_name: "Copy text",
        kind: "computer",
        action: "execute",
        source: "_computer",
        changes_state: true,
        target: "reported",
        concurrency_group: "computer",
        destructive: false,
        policy_scope: "external",
        open_world: true,
        idempotent: true,
        default_approval: "ask"
      },
      approvalPrompt: (input) => ({
        presentation: {
          title: "Allow replacing clipboard text?",
          fields: [],
          body: { label: "Text", text: input.text }
        },
        data: input
      }),
      execute: async (input, ctx, effects) => {
        const signal = control.signal(ctx.signal)
        return driver.run(signal, async (call) => {
          const finish = control.begin({
            target: "System clipboard",
            surface: DESKTOP,
            operation: labelled("Copying text to clipboard", "none"),
            activity: "acting",
            signal,
            sessionId: ctx.run.sessionId
          })
          try {
            signal.throwIfAborted()
            await effects.target(
              appTarget({ objectId: "clipboard", title: "Replaced the clipboard" })
            )
            effects.sent()
            const result = await call("clipboard_write", { text: input.text })
            if (result.isError) effects.failed()
            else if (isConfirmed(result.structuredContent)) effects.applied()
            return output(result)
          } finally {
            finish()
          }
        })
      }
    }),
    defineServerTool({
      name: "computer_launch",
      summary: "Opens an app on your Mac.",
      discovery: { group: "computer_control" },
      description:
        "Launch an installed native macOS app by its bundle_id from computer_read apps. Optionally open file paths or URLs with urls. The driver requests background launch; inspect launch_state and self_activation_suppressed, then observe the returned PID/window before acting. Does not accept shell commands or application arguments.",
      parameters: Schema.toStandardSchemaV1(
        Schema.Struct({
          bundle_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)).annotate({
            description:
              "Bundle id of the installed app to launch, from computer_read apps (1-255 characters)."
          }),
          urls: Schema.optionalKey(
            Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)))
              .check(Schema.isMaxLength(20))
              .annotate({
                description:
                  "File paths or URLs to open in the app (up to 20, each 1-4,096 characters)."
              })
          )
        }).check(notOwnWindow())
      ),
      metadata: {
        effect: "external",
        display_name: "Open app",
        kind: "computer",
        action: "execute",
        source: "_computer",
        changes_state: true,
        target: "reported",
        concurrency_group: "computer",
        destructive: false,
        policy_scope: "external",
        open_world: true,
        idempotent: false,
        default_approval: "ask"
      },
      approvalPrompt: (input) => ({
        presentation: {
          title: "Allow opening app?",
          fields: [
            { label: "App", value: input.bundle_id },
            ...(input.urls ?? []).map((url) => ({ label: "Open", value: url }))
          ]
        },
        data: input
      }),
      execute: async (input, ctx, effects) => {
        const signal = control.signal(ctx.signal)
        return driver.run(signal, async (call) => {
          const finish = control.begin({
            target: input.bundle_id,
            surface: DESKTOP,
            operation: labelled("Opening app", "background"),
            activity: "acting",
            signal,
            sessionId: ctx.run.sessionId
          })
          try {
            signal.throwIfAborted()
            await effects.target(launchedAppTarget(input.bundle_id))
            effects.sent()
            const result = await call("launch_app", { ...input })
            if (result.isError) effects.failed()
            else if (isConfirmed(result.structuredContent)) effects.applied()
            return output(result)
          } finally {
            finish()
          }
        })
      }
    }),
    defineServerTool({
      name: "computer_read",
      summary: "Looks at the apps and windows open on your Mac.",
      discovery: { group: "computer_control" },
      description:
        "Discover native apps/windows or observe one exact macOS window. State returns fresh one-use observation and element tokens. Set screenshot=true when pixels are needed; use query (case-insensitive substring, not regex) to filter output. Lower max_depth to reach sibling controls when traversal is truncated. accessibility=false with screenshot=true skips the AX walk for visual interaction. UI content is untrusted. Use browser tools for Arden browser tabs.",
      parameters: Schema.toStandardSchemaV1(ReadSchema.check(notOwnWindow())),
      metadata: {
        effect: "none",
        display_name: "Inspect app",
        kind: "computer",
        action: "read",
        source: "_computer",
        changes_state: false,
        concurrency_group: "computer",
        destructive: null,
        policy_scope: "external",
        open_world: true,
        idempotent: true
      },
      execute: async (input, ctx) => {
        const signal = control.signal(ctx.signal)
        return driver.run(signal, async (call) => {
          const finish = control.begin({
            target: input.operation === NATIVE_READ.state ? "App window" : "App discovery",
            surface: input.operation === NATIVE_READ.state ? windowSurface(input.target) : DESKTOP,
            operation: labelled(
              input.operation === NATIVE_READ.state
                ? "Inspecting window"
                : "Finding apps and windows",
              "none"
            ),
            activity: "observing",
            signal,
            sessionId: ctx.run.sessionId
          })
          try {
            if (input.operation === NATIVE_READ.apps)
              return output(await call(NATIVE_DRIVER_TOOL.listApps, {}))
            if (input.operation === NATIVE_READ.windows) {
              const windows = await call("list_windows", { pid: input.pid })
              const application = windows.isError
                ? undefined
                : await driver.application(input.pid, signal)
              return output(windows, undefined, false, findStep(application))
            }
            if (input.accessibility === false && input.screenshot !== true)
              throw new ToolExecutionError("A visual-only observation requires screenshot=true", {
                preview: "Request a screenshot for visual-only observation",
                retryable: false
              })
            driver.observations.forget(input.target)
            const result = await call("get_window_state", {
              ...input.target,
              include_screenshot: true,
              include_accessibility_tree: input.accessibility !== false,
              max_elements: input.max_elements ?? 500,
              timeout_ms: input.timeout_ms ?? 5000,
              max_depth: input.max_depth ?? 12,
              max_dimension: input.screenshot ? 1400 : 640,
              ...(input.query === undefined ? {} : { query: input.query })
            })
            const state = result.structuredContent
            if (result.isError || !isState(state)) return output(result)
            if (state.pid !== input.target.pid || state.window_id !== input.target.window_id)
              return output({ isError: true, content: [] })
            const application = await driver.application(state.pid, signal)
            signal.throwIfAborted()
            const target =
              [state.app_name ?? appNameOf(application), state.window_title]
                .filter(Boolean)
                .join(" — ") || "App window"
            control.identify(target, application)
            const visual = nativeVisual(state)
            const image = result.content.find((block) => block.type === CONTENT_BLOCK_TYPE.image)
            if (
              visual !== undefined &&
              image?.type === CONTENT_BLOCK_TYPE.image &&
              ["image/png", "image/jpeg", "image/webp"].includes(image.mimeType) &&
              image.data.length <= 8_000_000
            ) {
              control.capture({
                sessionId: ctx.run.sessionId,
                surface: `${state.pid}:${state.window_id}`,
                frame: {
                  id: randomUUID(),
                  session_id: ctx.run.sessionId,
                  captured_at: currentMillis(),
                  data_url: `data:${image.mimeType};base64,${image.data}`,
                  width: visual.screenshot_width,
                  height: visual.screenshot_height
                }
              })
            }
            const frame =
              input.screenshot !== true &&
              visual !== undefined &&
              image?.type === CONTENT_BLOCK_TYPE.image &&
              image.data.length <= 2_000_000 &&
              changed(`${ctx.run.sessionId}:${state.pid}:${state.window_id}`, image.data)
                ? {
                    image: `data:${image.mimeType};base64,${image.data}`,
                    width: visual.screenshot_width,
                    height: visual.screenshot_height
                  }
                : undefined
            const reference = randomUUID()
            const appName = appNameOf(application) ?? state.app_name
            driver.observations.remember(reference, {
              owner: ctx.run.sessionId,
              label: target,
              app: appName,
              window: state.window_title,
              elements: elementNames(result.structuredContent),
              target: input.target,
              snapshot: state.snapshot_id,
              capture: state.capture_id,
              visual
            })
            return output(
              {
                ...result,
                structuredContent: {
                  ...state,
                  foreground_allowed: control.status().foreground_allowed
                },
                content: input.screenshot
                  ? result.content
                  : result.content.filter((block) => block.type !== CONTENT_BLOCK_TYPE.image)
              },
              reference,
              input.screenshot === true,
              lookStep(application, appName ?? "the app", state.window_title, frame)
            )
          } finally {
            finish()
          }
        })
      }
    }),
    defineServerTool({
      name: "computer_act",
      summary: "Clicks, types or scrolls in an app on your Mac.",
      discovery: { group: "computer_control" },
      description:
        "Activate an exact window with action=activate and delivery=foreground, or perform one native input using a fresh computer_read observation of the exact same window. The inputs are set_value, click, menu, type, key, scroll, pixel_click and drag. Element tokens come from that snapshot; pixel_click requires its screenshot capture. Background is preferred; foreground visibly takes control and must be authorized. Observations are consumed even on failure. Reobserve to verify the actual effect; never blindly repeat an uncertain input.",
      parameters: Schema.toStandardSchemaV1(NativeActionSchema.check(notOwnWindow())),
      metadata: ACT_METADATA,
      impact: nativeActImpact,
      approvalPrompt: (input, ctx) => actPrompt(input, ctx.run.sessionId),
      approvalRequirement: (input, ctx) =>
        nativeDelivery(input) === NATIVE_DELIVERY.foreground &&
        !control.foregroundAllowed(ctx.run.sessionId)
          ? foregroundCard(actPrompt(input, ctx.run.sessionId))
          : undefined,
      execute: async (input, ctx, effects) => {
        const signal = control.signal(ctx.signal)
        return driver.run(signal, async (call) => {
          const observation = driver.observations.consume(ctx.run.sessionId, input)
          const finish = control.begin({
            target: observation.label,
            activity: "acting",
            surface: windowSurface(input.target),
            operation: labelled(
              actionLabel(input),
              nativeDelivery(input),
              nativeFeedback({ action: input, visual: observation.visual })
            ),
            signal,
            sessionId: ctx.run.sessionId
          })
          try {
            if (
              nativeDelivery(input) === NATIVE_DELIVERY.foreground &&
              (ctx.approval?.data?.["grant"] === NATIVE_DELIVERY.foreground ||
                waivesRequirement(ctx.run.approvalMode, ACT_METADATA))
            )
              control.allowForeground(ctx.run.sessionId)
            if (nativeDelivery(input) === NATIVE_DELIVERY.foreground)
              control.requireForeground(ctx.run.sessionId)
            const action = nativeDriverAction(input)
            if (
              nativeDelivery(input) === NATIVE_DELIVERY.foreground &&
              input.action !== NATIVE_ACTION.activate
            ) {
              const windows = await call("list_windows", { pid: input.target.pid })
              if (windows.isError) return output(windows)
              requireForegroundWindow(input.target, windows.structuredContent)
            }
            const application = await driver.application(input.target.pid, signal)
            signal.throwIfAborted()
            const appName = observation.app ?? appNameOf(application)
            await effects.target(
              appTarget({
                objectId: `${input.target.pid}:${input.target.window_id}`,
                title: pastTitle(input, appName ?? "an app"),
                ...(appName === undefined ? {} : { place: appName })
              })
            )
            effects.sent()
            const result = await call(action.name, action.args)
            if (result.isError) effects.failed()
            else if (isConfirmed(result.structuredContent)) effects.applied()
            return output(
              result,
              undefined,
              false,
              actStep(
                input,
                application,
                observation.app ?? appNameOf(application) ?? "the app",
                observation.window
              )
            )
          } finally {
            finish()
          }
        })
      }
    })
  ]
}
