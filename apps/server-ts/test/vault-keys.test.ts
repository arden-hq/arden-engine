import { mkdtemp, realpath, rm } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import path from "node:path"
import { describe, expect, it } from "vitest"

import {
  keyVariables,
  looksLikeSecret,
  makeVaultKeys,
  replaceRanges,
  type VaultKeyBroker
} from "../src/credentials/vault-keys.js"
import { cardRuleSubjects } from "../src/persistence/sqlite/permissions.js"
import { shellInvocation, shellRuntime } from "../src/tools/shell-policy.js"
import { runCommandUntil } from "../src/tools/shell-run.js"
import { keyUseDecision, vaultListText } from "../src/tools/vault.js"
import { endsKeySessions } from "../src/chat/runner/built-in.js"
import { matchesVaultKey } from "../src/execution/rules.js"
import { savedSecretResult, savedUserName, secretCard } from "../src/tools/browser-ask-secret.js"
import { NO_PATH_RULES } from "./fixtures/local-policy.js"

const REAL = "tdk_Real1234567890abcdefXYZ"

/** A stand-in for the desktop: it holds the value, and answers only what the broker answers. */
const desktop = (overrides: Partial<VaultKeyBroker> = {}): VaultKeyBroker => ({
  listVault: async () => ({
    keys: [
      { id: "k1", name: "Todoist", variable: "TODOIST_API_KEY", addresses: ["api.todoist.com"] }
    ],
    passwords: [{ site: "https://github.com", name: "password", userName: "alex" }]
  }),
  keyEnvironment: async ({ names }) => ({
    variables: names.includes("Todoist") ? { TODOIST_API_KEY: "gfq_Dvif9477324341hhkumjETE" } : {},
    missing: names.filter((name) => name !== "Todoist"),
    proxyUrl: "http://arden:00ff@127.0.0.1:40123",
    caFile: "/tmp/ca.pem",
    caBundleFile: "/tmp/roots.pem"
  }),
  findSecrets: async (text) => {
    const ranges: Array<[number, number]> = []
    for (let at = text.indexOf(REAL); at >= 0; at = text.indexOf(REAL, at + 1))
      ranges.push([at, at + REAL.length])
    return { ranges }
  },
  endKeySession: async () => ({ ended: true }),
  ...overrides
})

describe("the Vault seen from the engine", () => {
  it("refuses a list or an environment that carries anything beyond names, addresses and fakes", async () => {
    const leaky = makeVaultKeys(
      desktop({
        listVault: async () => ({
          keys: [
            { id: "k1", name: "Todoist", variable: "TODOIST_API_KEY", addresses: [], value: REAL }
          ],
          passwords: []
        }),
        keyEnvironment: async () => ({
          variables: {},
          missing: [],
          proxyUrl: "http://x",
          caFile: "a",
          caBundleFile: "b",
          values: { Todoist: REAL }
        })
      })
    )
    await expect(leaky.list()).rejects.toThrow()
    leaky.grant("run-1", "k1")
    await expect(leaky.environment("run-1", "remote")).rejects.toThrow()
  })

  it("grants by the key's id: a key added again under the same name is not allowed", async () => {
    const vault = makeVaultKeys(
      desktop({
        listVault: async () => ({
          keys: [
            {
              id: "k2",
              name: "Todoist",
              variable: "TODOIST_API_KEY",
              addresses: ["api.todoist.com"]
            }
          ],
          passwords: []
        })
      })
    )
    vault.grant("run-1", "k1")
    expect(await vault.environment("run-1", "all")).toBeUndefined()
  })

  it("gives a run's commands only the keys the run was allowed", async () => {
    const vault = makeVaultKeys(desktop())
    expect(await vault.environment("run-1", "all")).toBeUndefined()
    vault.grant("run-1", "k1")
    vault.grant("run-1", "k1")
    expect(vault.granted("run-1")).toEqual(["k1"])
    expect(vault.granted("run-2")).toEqual([])
    const environment = await vault.environment("run-1", "all")
    expect(environment === undefined ? undefined : keyVariables(environment)).toEqual({
      TODOIST_API_KEY: "gfq_Dvif9477324341hhkumjETE",
      HTTPS_PROXY: "http://arden:00ff@127.0.0.1:40123",
      https_proxy: "http://arden:00ff@127.0.0.1:40123",
      HTTP_PROXY: "http://arden:00ff@127.0.0.1:40123",
      http_proxy: "http://arden:00ff@127.0.0.1:40123",
      NO_PROXY: "",
      no_proxy: "",
      NODE_USE_ENV_PROXY: "1",
      NODE_EXTRA_CA_CERTS: "/tmp/ca.pem",
      SSL_CERT_FILE: "/tmp/roots.pem",
      CURL_CA_BUNDLE: "/tmp/roots.pem",
      REQUESTS_CA_BUNDLE: "/tmp/roots.pem",
      GIT_SSL_CAINFO: "/tmp/roots.pem"
    })
  })

  it("scrubs a saved value from output, across a window edge too, and fails when it cannot check", async () => {
    const vault = makeVaultKeys(desktop())
    const edge = 65_536 - 8_192 - 5
    const long = `${"a".repeat(edge)}${REAL}${"b".repeat(70_000)}${REAL}`
    const scrubbed = await vault.redact(long)
    expect(scrubbed).not.toContain(REAL)
    expect(scrubbed.split("[saved secret]")).toHaveLength(3)
    expect(await vault.redact(`curl said ${REAL}.`)).toBe("curl said [saved secret].")
    const broken = makeVaultKeys(
      desktop({ findSecrets: async () => Promise.reject(new Error("gone")) })
    )
    await expect(broken.redact(`x ${REAL}`)).rejects.toThrow()
    expect(
      replaceRanges("abcdef", [
        [1, 3],
        [2, 4]
      ])
    ).toBe("a[saved secret]ef")
  })

  it("lets a chat ask for secrets 5 times in 5 minutes, counting each call once", () => {
    let now = 0
    const vault = makeVaultKeys(undefined, { now: () => now })
    for (const call of ["c1", "c2", "c3", "c4", "c5"])
      expect(vault.takeAsk("chat", call)).toBe(true)
    expect(vault.takeAsk("chat", "c5")).toBe(true)
    expect(vault.takeAsk("chat", "c6")).toBe(false)
    expect(vault.takeAsk("other-chat", "c1")).toBe(true)
    now = 5 * 60 * 1_000
    expect(vault.takeAsk("chat", "c7")).toBe(true)
  })

  it("ends the run's proxy session when its runner ends, only for a run that had keys", async () => {
    const ended: Array<string> = []
    const vault = makeVaultKeys(
      desktop({
        endKeySession: async (runId) => {
          ended.push(runId)
          return { ended: true }
        }
      })
    )
    await vault.end("run-0")
    vault.grant("run-1", "k1")
    await vault.end("run-1")
    expect(ended).toEqual(["run-1"])
    // Ending a run also forgets what it was allowed.
    expect(vault.granted("run-1")).toEqual([])
    expect(await vault.environment("run-1", "all")).toBeUndefined()
    const failing = makeVaultKeys(
      desktop({ endKeySession: () => Promise.reject(new Error("gone")) })
    )
    failing.grant("run-2", "k1")
    await expect(failing.end("run-2")).resolves.toBeUndefined()
  })

  it("without the desktop, lists nothing and scrubs nothing it cannot know", async () => {
    const vault = makeVaultKeys(undefined)
    await expect(vault.list()).rejects.toThrow("The Vault needs the Arden app")
    expect(await vault.redact("plain")).toBe("plain")
  })
})

describe("contact details in vault_list", () => {
  it("are given to the agent in full, with the rule on where they may go", async () => {
    const vault = makeVaultKeys(
      desktop({
        listVault: async () => ({
          keys: [],
          passwords: [],
          contacts: [
            {
              name: "Alex Morgan",
              email: "alex@example.com",
              phone: "+44 20 7946 0958",
              addressLine1: "12 Marsh Lane",
              city: "Bristol",
              postalCode: "BS1 4DJ",
              country: "United Kingdom"
            },
            { name: "Sam Lee" }
          ]
        })
      })
    )
    expect(vaultListText(await vault.list())).toEqual({
      result: [
        "Keys: none saved.",
        "",
        "Site passwords: none saved.",
        "",
        "Contact details (type them into forms the user asked you to fill; never send them anywhere the user did not ask):",
        "- Alex Morgan",
        "  Email: alex@example.com",
        "  Phone: +44 20 7946 0958",
        "  Address line 1: 12 Marsh Lane",
        "  City: Bristol",
        "  Postal code: BS1 4DJ",
        "  Country: United Kingdom",
        "- Sam Lee"
      ].join("\n"),
      preview: "0 keys, 0 passwords, 2 contacts"
    })
  })

  it("a desktop without contact details lists none; an unknown field is refused", async () => {
    expect(vaultListText(await makeVaultKeys(desktop()).list())).toEqual({
      result: [
        "Keys:",
        "- Todoist: $TODOIST_API_KEY, sent only to api.todoist.com",
        "",
        "Site passwords (browser_act fills them):",
        "- github.com: password, user name alex",
        "",
        "Contact details: none saved."
      ].join("\n"),
      preview: "1 key, 1 password, 0 contacts"
    })
    const odd = makeVaultKeys(
      desktop({
        listVault: async () => ({
          keys: [],
          passwords: [],
          contacts: [{ name: "Alex", passport: "X123" }]
        })
      })
    )
    await expect(odd.list()).rejects.toThrow()
  })
})

describe("using a key", () => {
  it("needs the owner's card or a rule for this key, in every mode", () => {
    const decide = (
      rule: "allow" | "ask" | "never" | undefined,
      mode: "ask" | "allow" | "read_only",
      answered = false
    ) => keyUseDecision({ answered, rule, mode }).kind
    expect(decide(undefined, "ask")).toBe("ask")
    expect(decide(undefined, "ask", true)).toBe("allowed")
    expect(decide("allow", "ask")).toBe("allowed")
    expect(decide("never", "ask", true)).toBe("refuse")
    expect(decide(undefined, "read_only")).toBe("refuse")
    // Never ask does not allow a key: its card still asks (and waits when nobody is there).
    expect(decide(undefined, "allow")).toBe("ask")
    expect(decide("allow", "allow")).toBe("allowed")
  })

  it("saves Always allow as this key, never the tool", () => {
    expect(
      cardRuleSubjects({
        toolName: "vault_use_key",
        serverName: undefined,
        data: { reviewer: "user", vault_key: "Todoist", vault_key_id: "k1" }
      })
    ).toEqual([{ kind: "vault_key", name: "Todoist", keyId: "k1" }])
    // A rule about the old key does not cover a new key given its name.
    expect(matchesVaultKey("k2")({ kind: "vault_key", name: "Todoist", keyId: "k1" })).toBe(false)
    expect(matchesVaultKey("k1")({ kind: "vault_key", name: "Todoist", keyId: "k1" })).toBe(true)
    expect(
      cardRuleSubjects({ toolName: "vault_use_key", serverName: undefined, data: {} })
    ).toBeUndefined()
  })

  it("refuses a reason that looks like a secret", () => {
    for (const text of [
      `use ${REAL}`,
      "my key is sk-proj-abcdEFGH12345678",
      "token: hunter2hunter2",
      "Authorization: Bearer abcdefghijkl1234",
      "ghp_abcdefghijklmnopqrstuvwxyz0123",
      "AKIAABCDEFGHIJKLMNOP"
    ])
      expect(looksLikeSecret(text)).toBe(true)
    for (const text of [
      "You asked me to add “Renew passport” to your tasks.",
      "List your projects at api.todoist.com/rest/v2/projects",
      "Check the build for release 2026-11-17"
    ])
      expect(looksLikeSecret(text)).toBe(false)
  })
})

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      resolve(address === null || typeof address === "string" ? 0 : address.port)
    })
  )

describe("a command with keys", () => {
  it("gets the stand-ins after its own proxy variables, which they replace", () => {
    const invocation = shellInvocation(
      "true",
      "/tmp",
      {
        cwd: "/tmp",
        readRoots: null,
        writeRoot: null,
        stateRoot: "/nonexistent",
        sandbox: "host_approved",
        pathRules: NO_PATH_RULES
      },
      shellRuntime({
        environment: { PATH: "/usr/bin:/bin", HTTPS_PROXY: "http://corp:3128" },
        loginPath: undefined,
        keyProxy: {
          variables: { TODOIST_API_KEY: "fake", HTTPS_PROXY: "http://arden@127.0.0.1:1" },
          port: 1
        }
      })
    )
    expect(invocation.env).toMatchObject({
      TODOIST_API_KEY: "fake",
      HTTPS_PROXY: "http://arden@127.0.0.1:1"
    })
  })

  it.skipIf(process.platform !== "darwin")(
    "reaches the key proxy's port from the network sandbox, and no other local port",
    async () => {
      const proxy = createServer((_request, response) => response.end("proxy"))
      const other = createServer((_request, response) => response.end("other"))
      const directory = await realpath(
        await mkdtemp(path.join("/private/tmp", "arden-key-sandbox-"))
      )
      try {
        const [proxyPort, otherPort] = await Promise.all([listen(proxy), listen(other)])
        const run = (port: number) =>
          runCommandUntil(
            `/usr/bin/curl -sS --max-time 3 http://localhost:${port}/`,
            directory,
            AbortSignal.timeout(10_000),
            {
              cwd: directory,
              readRoots: [directory],
              writeRoot: directory,
              stateRoot: path.join(directory, "state"),
              sandbox: "approved_local",
              pathRules: NO_PATH_RULES,
              network: true
            },
            { yieldMs: 10_000, keyProxy: { variables: {}, port: proxyPort } }
          )
        await expect(run(proxyPort)).resolves.toMatchObject({
          state: "exited",
          exitCode: 0,
          output: "proxy"
        })
        await expect(run(otherPort)).rejects.toThrow("Couldn't connect to server")
      } finally {
        proxy.close()
        other.close()
        await rm(directory, { recursive: true, force: true })
      }
    }
  )
})

describe("the sign-in password card", () => {
  const input = {
    tab_ref: "tab-1",
    origin: "https://github.com",
    name: "password",
    purpose: "You asked me to check your pull requests."
  }

  it("says Save password and Not now", () => {
    expect(secretCard(input).presentation).toMatchObject({
      approve_label: "Save password",
      reject_label: "Not now"
    })
  })

  it("gives the agent the saved user name, never the value", () => {
    const output = {
      result: "",
      preview: "",
      data: { origin: "https://github.com", names: ["password"], users: { password: "alexmorgan" } }
    }
    const userName = savedUserName(output, "password")
    expect(userName).toBe("alexmorgan")
    expect(savedSecretResult(input, userName)).toBe(
      "Saved for https://github.com as password. Its user name is alexmorgan; type it into the user name field yourself if the form asks. Fill the password field with browser_act action fill, secret password, and a fresh node_ref. You will not see the value."
    )
    expect(
      savedUserName({ result: "", preview: "", data: { names: ["password"] } }, "password")
    ).toBeUndefined()
  })
})

describe("a run's keys and its runner", () => {
  const result = (stopReason: string) => ({ text: "", stop_reason: stopReason })
  const run = async (events: ReadonlyArray<object>, fail = false) => {
    const ended: Array<string> = []
    const runner = endsKeySessions(
      async (runId) => {
        ended.push(runId)
      },
      async function* (_input: { readonly runId: string }) {
        for (const event of events) yield event
        if (fail) throw new Error("model failed")
      }
    )
    await (async () => {
      for await (const _event of runner({ runId: "run-1" })) void _event
    })().catch(() => undefined)
    return ended
  }

  it("end when the run ends, however it ends, and stay while it waits on a card", async () => {
    expect(await run([result("end_turn")])).toEqual(["run-1"])
    expect(await run([result("cancelled")])).toEqual(["run-1"])
    expect(await run([], true)).toEqual(["run-1"])
    expect(await run([result("paused")])).toEqual([])
  })
})
