import type {
  PermissionRuleItem,
  PermissionRuleList,
  PermissionRuleSubject
} from "@arden-hq/protocol/permissions"
import { commandWords } from "../../persistence/permissions/command-policy.js"
import type { PermissionRule, RuleList, RuleSubject } from "../../persistence/permissions/rules.js"
import type { RuleNames } from "../../tools/registry.js"

export type RulePage =
  | { readonly kind: "settings" }
  | { readonly kind: "space"; readonly spaceId: string }

export const pageOf = (list: RuleList): RulePage =>
  list.kind === "space" ? { kind: "space", spaceId: list.spaceId } : { kind: "settings" }

const onPage = (list: RuleList, page: RulePage): boolean =>
  page.kind === "settings"
    ? list.kind !== "space"
    : list.kind === "space" && list.spaceId === page.spaceId

const listItem = (list: RuleList): PermissionRuleList =>
  list.kind === "space" ? { kind: "space", space_id: list.spaceId } : list

export const ruleItems = (
  rules: ReadonlyArray<PermissionRule>,
  names: RuleNames,
  page: RulePage
): ReadonlyArray<PermissionRuleItem> =>
  rules
    .filter((rule) => onPage(rule.list, page))
    .map((rule) => ({
      id: rule.id,
      list: listItem(rule.list),
      decision: rule.decision,
      subject: subjectItem(rule.subject, names),
      from: rule.fromRuleId
    }))

export const subjectItem = (subject: RuleSubject, names: RuleNames): PermissionRuleSubject => {
  switch (subject.kind) {
    case "tool": {
      const tool = names.tool(subject.tool)
      return {
        kind: "tool",
        tool: subject.tool,
        server: subject.server,
        title: tool?.title ?? subject.tool,
        server_title:
          subject.server === null ? null : (names.connector(subject.server) ?? subject.server)
      }
    }
    case "site":
      return {
        kind: "site",
        tool: subject.tool,
        origin: subject.origin,
        title: names.tool(subject.tool)?.title ?? subject.tool
      }
    case "connector":
      return {
        kind: "connector",
        server: subject.server,
        title: names.connector(subject.server) ?? subject.server
      }
    case "command":
      return { kind: "command", words: commandWords(subject.executable, subject.argumentPrefix) }
    case "host_commands":
    case "words":
    case "path":
      return subject
  }
}
