import { ApprovalPolicyStore } from "../../persistence/permissions/approval-policy.js"
import type { PermissionRuleList } from "@arden-hq/protocol/permissions"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"

import { SpaceStore } from "../../persistence/spaces/store.js"
import {
  PermissionRules,
  PermissionRulesError,
  wordsRuleText,
  type RuleList,
  type RuleSubject
} from "../../persistence/permissions/rules.js"
import { sameList } from "../../execution/rules.js"
import { checkCompiled } from "../../tools/rule-compile.js"
import { resolveCommandSandbox } from "../../runtime/command-sandbox.js"
import { ServerToolRegistry } from "../../tools/registry.js"
import { ArdenApi } from "../api.js"
import { failStore } from "../errors.js"
import { pageOf, ruleItems, subjectItem, type RulePage } from "./rule-items.js"

const notFound = (message: string) =>
  new PermissionRulesError({ operation: "save", reason: "not_found", message })

export const PermissionHandlers = HttpApiBuilder.group(
  ArdenApi,
  "permissions",
  Effect.fn("PermissionHandlers")(function* (handlers) {
    const policy = yield* ApprovalPolicyStore
    const rules = yield* PermissionRules
    const tools = yield* ServerToolRegistry
    const spaces = yield* SpaceStore

    const listed = Effect.fn("PermissionHandlers.listed")(function* (page: RulePage) {
      const [saved, names] = yield* Effect.all([rules.list(), tools.ruleNames()])
      return { rules: ruleItems(saved, names, page) }
    })

    const listOf = Effect.fn("PermissionHandlers.listOf")(function* (list: PermissionRuleList) {
      if (list.kind !== "space") return list
      const space = yield* spaces.get(list.space_id).pipe(Effect.orElseSucceed(() => null))
      if (space === null) return yield* notFound("That Space was not found")
      return { kind: "space", spaceId: list.space_id } satisfies RuleList
    })

    return handlers
      .handle("session", ({ params }) =>
        policy.session(params.sessionId).pipe(Effect.catch(failStore))
      )
      .handle("setSession", ({ params, payload }) =>
        policy
          .setSession({
            sessionId: params.sessionId,
            ...(payload.approval_mode === undefined ? {} : { mode: payload.approval_mode })
          })
          .pipe(Effect.catch(failStore))
      )
      .handle("defaultMode", () =>
        policy.defaultMode().pipe(
          Effect.map((mode) => ({ approval_mode: mode })),
          Effect.catch(failStore)
        )
      )
      .handle("setDefaultMode", ({ payload }) =>
        policy.setDefaultMode(payload.approval_mode).pipe(
          Effect.map((mode) => ({ approval_mode: mode })),
          Effect.catch(failStore)
        )
      )
      .handle("rules", () => listed({ kind: "settings" }).pipe(Effect.catch(failStore)))
      .handle("spaceRules", ({ params }) =>
        Effect.gen(function* () {
          const list = yield* listOf({ kind: "space", space_id: params.spaceId })
          return yield* listed(pageOf(list))
        }).pipe(Effect.catch(failStore))
      )
      .handle("saveRule", ({ payload }) =>
        Effect.gen(function* () {
          const list = yield* listOf(payload.list)
          const subjects = yield* tools.settingsRuleSubjects(payload.subject)
          const held = (yield* rules.list()).filter((rule) => sameList(rule.list, list))
          const same = (subject: RuleSubject) =>
            held.some((rule) => JSON.stringify(rule.subject) === JSON.stringify(subject))
          if (subjects.some(same))
            return yield* new PermissionRulesError({
              operation: "save",
              reason: "conflict",
              message: "That rule is already on the list"
            })
          for (const subject of subjects)
            yield* rules.save({
              subject,
              list,
              decision: payload.decision,
              source: { kind: "settings" }
            })
          return yield* listed(pageOf(list))
        }).pipe(Effect.catch(failStore))
      )
      .handle("compileWords", ({ payload }) =>
        Effect.gen(function* () {
          yield* listOf(payload.list)
          const compiled = yield* tools.compileWords({
            text: wordsRuleText(payload.text),
            sessionId: null
          })
          const names = yield* tools.ruleNames()
          return {
            decision: compiled.decision,
            rules: compiled.rules.map((rule) => ({
              decision: rule.decision,
              subject: rule.wire,
              shown: subjectItem(rule.subject, names)
            })),
            dropped: compiled.dropped
          }
        }).pipe(Effect.catch(failStore))
      )
      .handle("saveWords", ({ payload }) =>
        Effect.gen(function* () {
          const list = yield* listOf(payload.list)
          const { kept, dropped } = yield* checkCompiled(
            payload.rules.map((rule) => ({ decision: rule.decision, wire: rule.subject })),
            tools.settingsRuleSubjects
          )
          if (dropped.length > 0)
            return yield* new PermissionRulesError({
              operation: "save",
              reason: "invalid",
              message: dropped.join("; ")
            })
          yield* rules.saveWords({
            text: payload.text,
            list,
            decision: payload.decision,
            rules: kept.map((rule) => ({ subject: rule.subject, decision: rule.decision })),
            source: { kind: "settings" },
            ...(payload.replaces === undefined ? {} : { replaces: payload.replaces })
          })
          return yield* listed(pageOf(list))
        }).pipe(Effect.catch(failStore))
      )
      .handle("decideRule", ({ params, payload }) =>
        rules
          .change({
            ruleId: params.ruleId,
            decision: payload.decision,
            source: { kind: "settings" }
          })
          .pipe(
            Effect.flatMap((rule) => listed(pageOf(rule.list))),
            Effect.catch(failStore)
          )
      )
      .handle("removeRule", ({ params }) =>
        rules
          .change({ ruleId: params.ruleId, decision: "remove", source: { kind: "settings" } })
          .pipe(
            Effect.flatMap((rule) => listed(pageOf(rule.list))),
            Effect.catch(failStore)
          )
      )
      .handle("commandSandbox", () =>
        Effect.promise(resolveCommandSandbox).pipe(Effect.map((status) => ({ status })))
      )
  })
)
