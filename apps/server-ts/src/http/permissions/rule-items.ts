import {
  PERMISSION_RULE_LIST,
  PERMISSION_RULE_ORIGIN,
  PERMISSION_RULE_SUBJECT,
  PERMISSION_TOOL_OWNER,
  type PermissionRuleItem,
  type PermissionRuleList,
  type PermissionRuleSubject
} from "@arden-hq/protocol/permissions"
import { commandWords } from "../../persistence/permissions/command-policy.js"
import type { PermissionRule, RuleList, RuleSubject } from "../../persistence/permissions/rules.js"
import type { RuleNames } from "../../tools/registry-profile.js"

const RULE_PAGE = { settings: "settings", space: "space" } as const

export type RulePage =
  | { readonly kind: typeof RULE_PAGE.settings }
  | { readonly kind: typeof RULE_PAGE.space; readonly spaceId: string }

export const pageOf = (list: RuleList): RulePage =>
  list.kind === PERMISSION_RULE_LIST.space
    ? { kind: "space", spaceId: list.spaceId }
    : { kind: "settings" }

const onPage = (list: RuleList, page: RulePage): boolean =>
  page.kind === RULE_PAGE.settings
    ? list.kind !== PERMISSION_RULE_LIST.space
    : list.kind === PERMISSION_RULE_LIST.space && list.spaceId === page.spaceId

const listItem = (list: RuleList): PermissionRuleList =>
  list.kind === PERMISSION_RULE_LIST.space ? { kind: "space", space_id: list.spaceId } : list

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
      from:
        rule.fromRuleId === null
          ? { kind: PERMISSION_RULE_ORIGIN.standalone }
          : { kind: PERMISSION_RULE_ORIGIN.words, rule_id: rule.fromRuleId }
    }))

export const subjectItem = (subject: RuleSubject, names: RuleNames): PermissionRuleSubject => {
  switch (subject.kind) {
    case PERMISSION_RULE_SUBJECT.tool: {
      const tool = names.tool(subject.tool)
      return {
        kind: "tool",
        tool: subject.tool,
        title: tool?.title ?? subject.tool,
        owner:
          subject.server === null
            ? { kind: PERMISSION_TOOL_OWNER.arden }
            : {
                kind: PERMISSION_TOOL_OWNER.connector,
                server: subject.server,
                title: names.connector(subject.server) ?? subject.server
              }
      }
    }
    case PERMISSION_RULE_SUBJECT.site:
      return {
        kind: "site",
        tool: subject.tool,
        origin: subject.origin,
        title: names.tool(subject.tool)?.title ?? subject.tool
      }
    case PERMISSION_RULE_SUBJECT.connector:
      return {
        kind: "connector",
        server: subject.server,
        title: names.connector(subject.server) ?? subject.server
      }
    case PERMISSION_RULE_SUBJECT.command:
      return { kind: "command", words: commandWords(subject.executable, subject.argumentPrefix) }
    case PERMISSION_RULE_SUBJECT.vaultKey:
      return { kind: "vault_key", name: subject.name, key_id: subject.keyId }
    case PERMISSION_RULE_SUBJECT.hostCommands:
    case PERMISSION_RULE_SUBJECT.words:
    case PERMISSION_RULE_SUBJECT.path:
      return subject
  }
}
