import type { CliToolsReport } from "@arden-hq/protocol/cli-tools"
import { Context, DateTime, Duration, Effect, Layer, Ref } from "effect"

import type { SkillError } from "../skills/errors.js"
import { SkillCatalog } from "../skills/service.js"
import { skillFor } from "./catalog.js"
import { type CliToolsDetection, detectCliTools } from "./detect.js"

export class CliTools extends Context.Service<
  CliTools,
  {
    readonly current: () => Effect.Effect<CliToolsReport, SkillError>
    readonly refresh: () => Effect.Effect<CliToolsReport, SkillError>
    readonly known: () => Effect.Effect<CliToolsReport | undefined, SkillError>
  }
>()("@arden-hq/server/cli-tools/CliTools") {}

interface Detected {
  readonly result: CliToolsDetection
  readonly checkedAt: string
}

export const cliToolsLayer = ({
  detect = (refreshPath) => detectCliTools({ refreshPath }),
  warm = false
}: {
  readonly detect?: (refreshPath: boolean) => Promise<CliToolsDetection>
  readonly warm?: boolean
} = {}): Layer.Layer<CliTools, never, SkillCatalog> =>
  Layer.effect(
    CliTools,
    Effect.gen(function* () {
      const skills = yield* SkillCatalog
      let detectedOnce = false
      const last = yield* Ref.make<Detected | undefined>(undefined)
      const [detection, invalidate] = yield* Effect.cachedInvalidateWithTTL(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => {
            const refreshPath = detectedOnce
            detectedOnce = true
            return detect(refreshPath)
          })
          const checkedAt = yield* DateTime.now
          const detected = { result, checkedAt: DateTime.formatIso(checkedAt) }
          yield* Ref.set(last, detected)
          return detected
        }),
        Duration.infinity
      )
      const report = Effect.fn("CliTools.report")(function* ({ result, checkedAt }: Detected) {
        const installed = yield* skills.list()
        return {
          tools: result.tools.map((tool) => ({
            id: tool.entry.id,
            name: tool.entry.name,
            description: tool.entry.description,
            command: tool.command,
            path: tool.path,
            version: tool.version,
            sign_in: tool.signIn,
            login_command:
              tool.entry.login === undefined ? null : [tool.command, ...tool.entry.login].join(" "),
            skill: skillFor(tool.entry, installed)
          })),
          path_source: result.pathSource,
          checked_at: checkedAt
        } satisfies CliToolsReport
      })
      if (warm) yield* Effect.forkScoped(detection)
      return CliTools.of({
        current: () => detection.pipe(Effect.flatMap(report)),
        refresh: Effect.fn("CliTools.refresh")(function* () {
          yield* invalidate
          return yield* report(yield* detection)
        }),
        known: Effect.fn("CliTools.known")(function* () {
          const detected = yield* Ref.get(last)
          return detected === undefined ? undefined : yield* report(detected)
        })
      })
    })
  )
