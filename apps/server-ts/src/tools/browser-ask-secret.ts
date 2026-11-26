import { ToolExecutionError } from "@arden-hq/loop"
import { APPROVAL_FIELD_LABEL, type ChatApprovalMode } from "@arden-hq/protocol/chat"
import { Effect, Schema } from "effect"

import { BrowserClient, SiteSecretNameSchema, type BrowserOutput } from "../browser/service.js"
import { OriginSchema, originIssues, runBrowserForRun, TabRefSchema } from "./browser-support.js"
import { defineServerTool, type ServerApprovalPrompt, type ServerTool } from "./define.js"
import { personCard } from "../execution/decide.js"
import type { ServerRunContext } from "./run-context.js"
import { looksLikeSecret, VaultKeys, type VaultKeysService } from "../credentials/vault-keys.js"
import { toolRefusal } from "./tool-failure.js"

const AskSecretParametersSchema = Schema.Struct({
  tab_ref: TabRefSchema.annotate({
    description: "The tab showing the sign-in form, from browser_tabs or browser_open."
  }),
  origin: OriginSchema.annotate({
    description:
      "The tab's exact current origin, such as https://accounts.example.com, without a path. It must still match the tab."
  }),
  name: SiteSecretNameSchema.annotate({
    description:
      "Short lower_snake name for the secret, such as password. You use it later as browser_act secret."
  }),
  purpose: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(
    Schema.annotateEncoded({
      description: "One short sentence for the user: what you will sign in to do."
    })
  ),
  replace: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "true to ask again for a secret already saved under this name, for example after the site rejected it. Defaults to false."
    })
  )
}).check(Schema.makeFilter((input) => originIssues(input.origin)))

type AskSecretInput = typeof AskSecretParametersSchema.Type

type SiteSecretRequestDecision =
  | { readonly kind: "saved" }
  | { readonly kind: "ask" }
  | { readonly kind: "answered" }
  | { readonly kind: "refuse"; readonly reason: "never_ask" | "read_only" }

const siteSecretRequestDecision = (input: {
  readonly mode: ChatApprovalMode
  readonly saved: boolean
  readonly replace: boolean
  readonly answered: boolean
}): SiteSecretRequestDecision => {
  if (input.answered) return { kind: "answered" }
  if (input.saved && !input.replace) return { kind: "saved" }
  const card = personCard(input.mode)
  return card === "ask" ? { kind: "ask" } : { kind: "refuse", reason: card }
}

const REFUSAL: Record<Extract<SiteSecretRequestDecision, { kind: "refuse" }>["reason"], string> = {
  never_ask:
    "Not asked: in Never ask, Arden does not ask the user for a password. Tell the user they can sign in themselves in the browser with Take control, then carry on.",
  read_only: "Not asked: this run may not start a sign-in."
}

const secretCard = (input: AskSecretInput): ServerApprovalPrompt => {
  const site = new URL(input.origin).host
  return {
    preview: `Sign in to ${site}`,
    presentation: {
      title: `Sign in to ${site}`,
      fields: [
        { label: APPROVAL_FIELD_LABEL.site, value: input.origin },
        { label: APPROVAL_FIELD_LABEL.secret, value: input.name },
        { label: "For", value: input.purpose }
      ],
      body: {
        label: "Password",
        text: "Type it on the card in the chat. Arden saves it for this site only."
      },
      approve_label: "Save password",
      reject_label: "Not now"
    },
    data: { reviewer: "user", origin: input.origin, name: input.name }
  }
}

export const tabOriginOf = (output: BrowserOutput, tabRef: string): string | undefined => {
  const tabs = output.data?.["tabs"]
  if (!Array.isArray(tabs)) return undefined
  for (const tab of tabs) {
    if (typeof tab !== "object" || tab === null) continue
    if (!("tab_ref" in tab) || tab.tab_ref !== tabRef) continue
    const url = "url" in tab && typeof tab.url === "string" ? tab.url : ""
    return URL.canParse(url) ? new URL(url).origin : undefined
  }
  return undefined
}

const savedNames = (output: BrowserOutput): ReadonlyArray<string> => {
  const names = output.data?.["names"]
  return Array.isArray(names) ? names.filter((name) => typeof name === "string") : []
}

const savedUserName = (output: BrowserOutput, name: string): string | undefined => {
  const users = output.data?.["users"]
  if (typeof users !== "object" || users === null || Array.isArray(users)) return undefined
  const user: unknown = Object.entries(users).find(([key]) => key === name)?.[1]
  return typeof user === "string" && user.length > 0 ? user : undefined
}

const makeBrowserAskSecretTool = (
  browser: BrowserClient["Service"],
  vault: VaultKeysService
): ServerTool => {
  const requireTabOn = async (
    input: AskSecretInput,
    run: ServerRunContext,
    signal: AbortSignal
  ) => {
    const tabs = await runBrowserForRun(browser, { run }, { type: "tabs" }, signal)
    if (tabOriginOf(tabs, input.tab_ref) !== input.origin) {
      throw new ToolExecutionError(
        "The tab is no longer on that site. Check browser_tabs and ask with the tab's current origin.",
        { preview: "Site changed", retryable: false }
      )
    }
  }
  const saved = async (input: AskSecretInput, run: ServerRunContext, signal: AbortSignal) => {
    const output = await runBrowserForRun(
      browser,
      { run },
      { type: "site_secrets", origin: input.origin },
      signal
    )
    return savedNames(output).includes(input.name)
      ? { userName: savedUserName(output, input.name) }
      : undefined
  }
  const isSaved = async (input: AskSecretInput, run: ServerRunContext, signal: AbortSignal) =>
    (await saved(input, run, signal)) !== undefined
  const refuseSecretShaped = (purpose: string) => {
    if (looksLikeSecret(purpose))
      throw toolRefusal(
        "The purpose looks like it holds a secret. Write it again in plain words, with no password or token in it.",
        "Purpose refused"
      )
  }

  return defineServerTool({
    name: "browser_ask_secret",
    summary: "Asks you for a site password on a card; only that site gets it.",
    discovery: { group: "web_browser_sign_in" },
    description: [
      "Ask the user for a password for the site open in a browser tab, on a secure card, when a sign-in form needs one.",
      "Never ask for a password in the chat. The user types it into the card; Arden saves it for that one site and you get only its name.",
      "If it is already saved, it returns at once; set replace to ask again. In Never ask or read-only runs it does not ask and says so. Then fill the password field with browser_act action fill and secret set to the name."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(AskSecretParametersSchema),
    metadata: {
      display: [{ fact: "card", value: "site_secret" }],
      effect: "none",
      display_name: "Sign-in secret",
      kind: "browser",
      action: "read",
      approval_preview: "Ask for a password for this site.",
      source: "_browser",
      changes_state: false,
      concurrency_group: "browser",
      destructive: null,
      approval_bypass: true,
      refuse_unattended: true,
      policy_scope: "external",
      open_world: true,
      idempotent: true,
      code_mode: false
    },
    approvalRequirement: async (input, ctx) => {
      refuseSecretShaped(input.purpose)
      await requireTabOn(input, ctx.run, ctx.signal)
      const decision = siteSecretRequestDecision({
        mode: ctx.run.approvalMode,
        saved: await isSaved(input, ctx.run, ctx.signal),
        replace: input.replace === true,
        answered: false
      })
      if (decision.kind !== "ask") return undefined
      if (!vault.takeAsk(ctx.run.sessionId, ctx.toolCallId))
        throw toolRefusal(
          "You asked the user for passwords or keys 5 times in 5 minutes. Stop asking; tell the user they can sign in themselves in the browser with Take control.",
          "Too many asks"
        )
      return secretCard(input)
    },
    approvalPrompt: async (input, ctx) => {
      await requireTabOn(input, ctx.run, ctx.signal)
      return secretCard(input)
    },
    execute: async (input, ctx) => {
      refuseSecretShaped(input.purpose)
      const held = await saved(input, ctx.run, ctx.signal)
      const decision = siteSecretRequestDecision({
        mode: ctx.run.approvalMode,
        saved: held !== undefined,
        replace: input.replace === true,
        answered: ctx.approval !== undefined
      })
      switch (decision.kind) {
        case "refuse":
          return { result: REFUSAL[decision.reason], preview: "Not asked" }
        case "ask":
          throw new ToolExecutionError("A site secret is asked only on the user's card.", {
            preview: "Asked only on the card",
            retryable: false
          })
        case "saved":
        case "answered":
          if (held === undefined) {
            throw new ToolExecutionError(
              `Nothing was saved for ${input.name} on ${input.origin}. Ask again only if the user wants to sign in.`,
              { preview: "Nothing saved", retryable: false }
            )
          }
          return {
            result: savedSecretResult(input, held.userName),
            preview: `Secret ${input.name} saved`
          }
      }
    }
  })
}

const savedSecretResult = (
  input: Pick<AskSecretInput, "origin" | "name">,
  userName: string | undefined
): string =>
  [
    `Saved for ${input.origin} as ${input.name}.`,
    userName === undefined
      ? "No user name is saved with it."
      : `Its user name is ${userName}; type it into the user name field yourself if the form asks.`,
    `Fill the password field with browser_act action fill, secret ${input.name}, and a fresh node_ref. You will not see the value.`
  ].join(" ")

export const browserAskSecretTools = Effect.gen(function* () {
  return [makeBrowserAskSecretTool(yield* BrowserClient, yield* VaultKeys)]
})
