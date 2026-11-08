import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { PermissionRule } from "../src/persistence/permissions/rules.js"
import type { LocalPathPolicy } from "../src/storage/local-paths.js"
import { refuseNeverPaths } from "../src/tools/command-paths.js"

describe("a command naming a never path", () => {
  let base = ""
  let privateFolder = ""
  let taxes = ""
  const homeNever = path.join(homedir(), "arden-never-test-folder")
  const never = (folder: string, access: "read" | "change"): PermissionRule => ({
    id: `${access}-${folder}`,
    subject: { kind: "path", path: folder, access },
    list: { kind: "global" },
    decision: "never",
    source: { kind: "settings", runId: null },
    createdAt: null,
    fromRuleId: null
  })
  const policy = (): LocalPathPolicy => ({
    cwd: base,
    readRoots: null,
    writeRoot: null,
    stateRoot: "/nonexistent/arden-state",
    sandbox: "host_approved",
    pathRules: {
      own: undefined,
      rules: [never(privateFolder, "read"), never(taxes, "change"), never(homeNever, "read")]
    }
  })
  const run = (command: string) => refuseNeverPaths(command, base, policy())

  beforeAll(async () => {
    base = await realpath(await mkdtemp(path.join(tmpdir(), "arden-cmd-never-")))
    privateFolder = path.join(base, "Private")
    taxes = path.join(base, "taxes")
    await mkdir(privateFolder)
    await mkdir(taxes)
    await mkdir(path.join(base, "work"))
    await symlink(privateFolder, path.join(base, "work", "link"))
  })
  afterAll(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it.each([
    ["an absolute path", () => `cat ${privateFolder}/a.txt`],
    ["a relative path with ..", () => "cat work/../Private/a.txt"],
    ["a link into it", () => "cat work/link/a.txt"],
    ["~ and $HOME", () => "cat ~/arden-never-test-folder/a; ls $HOME/arden-never-test-folder"],
    ["${HOME}", () => "cp ${HOME}/arden-never-test-folder/a /tmp/b"],
    ["an option's value", () => `grep --file=${privateFolder}/p x`],
    ["a part after a pipe", () => `echo hi | tee ${privateFolder}/a`],
    ["a redirect target under a never-change folder", () => `echo hi > ${taxes}/a`],
    ["a command that changes files under a never-change folder", () => `rm ${taxes}/a`],
    ["a relative path after cd", () => `cd ${base} && cat Private/a.txt`],
    ["a relative path after pushd", () => `pushd ${base}; ls Private`],
    ["a -C folder", () => `tar -C ${base} -cf /tmp/a.tar Private`],
    ["a -C folder glued to its option", () => `git -C${privateFolder} show HEAD:x`],
    ["an assignment", () => `D=${privateFolder}; cat "$D/x"`],
    ["a HOME reassignment", () => `HOME=${privateFolder}; cat $HOME/x`],
    ["braces", () => `cat ${base}/{Private,work}/f`],
    ["a colon list", () => `PATH_LIST=a:${privateFolder} run`],
    ["a file URL", () => `open file://${privateFolder}/a.txt`],
    ["$'…' quoting", () => "cat ~/$'\\x44ocuments'/f"],
    ["a ~/ spelling in a quoted value", () => `echo '~/arden-never-test-folder/x' | xargs cat`],
    ["cd with no folder", () => "cd && cat arden-never-test-folder/a"],
    ["cd -", () => `cd ${base}/work; cd -; cat Private/a`],
    ["cd -P ~", () => "cd -P ~ && cat arden-never-test-folder/a"],
    ["cd -- ~", () => "cd -- ~ && cat arden-never-test-folder/a"],
    ["builtin cd", () => ({ command: `builtin cd ${base} && cat Private/a`, cwd: () => "/tmp" })],
    ["command cd", () => ({ command: `command cd ${base} && cat Private/a`, cwd: () => "/tmp" })],
    ["CDPATH", () => ({ command: `CDPATH=${base} cd Private && cat a`, cwd: () => "/tmp" })],
    ["popd", () => `pushd /tmp; popd; cat Private/a`],
    ["~user", () => "cat ~root/../me/Private/a"],
    ["~+", () => "cat ~+/Private/a"],
    ["~-", () => "cat ~-/Private/a"],
    ["a relative path glued to a short option", () => "sort -oPrivate/x a.txt"],
    ["a link to a folder holding it", () => `ln -s ${base} /tmp/h && cat /tmp/h/Private/a`],
    ["a command that starts inside it", () => ({ command: "ls", cwd: () => privateFolder })],
    ["cd after then", () => "if true; then cd ~; cat arden-never-test-folder/a; fi"],
    ["cd after do", () => "for f in 1; do cd ~; cat arden-never-test-folder/a; done"],
    ["cd after !", () => "! cd ~; cat arden-never-test-folder/a"],
    ["ln by its path", () => `/bin/ln -s ${base} /tmp/h && cat /tmp/h/Private/a`],
    ["ln through env", () => `env ln -s ${base} /tmp/h`],
    ["ln through find -exec", () => `find . -exec ln -s ${base} /tmp/h \\;`],
    ["bash -c", () => "bash -c 'cd ~ && cat arden-never-test-folder/a'"],
    ["sh -lc", () => "sh -lc 'cd ~; cat arden-never-test-folder/a'"],
    ["eval", () => "eval cat x"],
    ["pushd with no folder", () => "pushd; cat Private/a"]
  ])("refuses %s", async (_case, command) => {
    const made = command()
    const refused =
      typeof made === "string" ? run(made) : refuseNeverPaths(made.command, made.cwd(), policy())
    await expect(refused).rejects.toThrow(/your rule says Arden never|cannot be checked/)
  })

  it.each([
    ["reading under a never-change folder", () => `cat ${taxes}/a`],
    ["a folder beside it", () => `cat ${privateFolder}-two/a`],
    ["a command naming no path", () => "git status"]
  ])("lets %s through", async (_case, command) => {
    await expect(run(command())).resolves.toBeUndefined()
  })

  it.runIf(process.platform === "darwin")(
    "refuses any spelling on a disk that ignores case",
    async () => {
      await expect(run(`cat ${base}/PRIVATE/a.txt`)).rejects.toThrow(/never/)
    }
  )
})
