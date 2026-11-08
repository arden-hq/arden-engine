import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { parseCommandSegments } from "../src/tools/bash-permissions.js"
import { changesNothing, isReadOnlyCommand } from "../src/tools/bash-safe-commands.js"

const NORMAL = mkdtempSync(join(tmpdir(), "arden-globs-normal-"))
for (const name of ["a.ts", "b.ts", "x.txt", "y.txt", "f.json", "g.log", "file.ts", "f"])
  writeFileSync(join(NORMAL, name), "a\n")
const HOSTILE = mkdtempSync(join(tmpdir(), "arden-globs-hostile-"))
for (const name of ["-a", "-delete", "--pre=evil", "-i", "a.ts", "f"])
  writeFileSync(join(HOSTILE, name), "a\n")
mkdirSync(join(HOSTILE, "src"))
afterAll(() => {
  rmSync(NORMAL, { recursive: true, force: true })
  rmSync(HOSTILE, { recursive: true, force: true })
})

const readOnly = (command: string, cwd = NORMAL) =>
  isReadOnlyCommand(parseCommandSegments(command), cwd)

describe("read-only shell commands (safe mode)", () => {
  it.each([
    "ls -la",
    "cat package.json | head -20",
    "git status --short && git diff --stat",
    "rg approvalDecision apps/server-ts/src",
    "find . -name '*.ts' | wc -l",
    "gh pr view 12 --json title",
    "git log --oneline -5; git branch -a",
    "/usr/bin/grep -rn foo .",
    "npm ls --depth=0",
    "docker ps",
    "sed -n 1,20p file.ts"
  ])("clears %s", (command) => {
    expect(readOnly(command)).toBe(true)
  })

  it.each([
    "git push origin main",
    "rm -rf dist",
    "find . -name '*.log' -delete",
    "find . -exec rm {} \;",
    "sed -i 's/a/b/' file.ts",
    "sed -ni p file.ts",
    "rg foo --pre cat",
    "ls > out.txt",
    "echo $(rm x)",
    "cat file | xargs rm",
    "git status && git commit -m x",
    "gh pr merge 12",
    "git branch -D old",
    "git -c core.editor=true rebase",
    "npm install",
    "bun pm cache rm",
    "awk 'system(\"rm x\")' f",
    "",
    "true; sudo ls",
    "env rm -rf dist",
    "env FOO=1 bash"
  ])("does not clear %s", (command) => {
    expect(readOnly(command)).toBe(false)
  })
})

describe("commands that change nothing", () => {
  it.each([
    "GH_PAGER=cat GH_PROMPT_DISABLED=1 NO_COLOR=1 gh auth status && GH_PAGER=cat gh api repos/openai/codex/commits/main --jq '{sha:.sha}'",
    "set -e\nfor f in a b; do gh api repos/x/contents/a.rs --jq .sha; done",
    "gh api -X GET repos/x/pulls --jq '.[].title'",
    "gh api -X GET search/issues -f q='repo:x is:pr' --jq .total_count",
    "gh api 'repos/x/contents/a.rs?ref=abc' --jq .content | tr -d '\\n' | base64 -d | sed -n '1,260p'",
    "gh release list -R openai/codex --limit 5",
    "curl -s https://example.com/feed | jq . | head",
    "rg foo src 2>/dev/null",
    "git log -5 --oneline"
  ])("%s changes nothing", (command) => {
    expect(changesNothing(command, NORMAL)).toBe(true)
  })

  it.each([
    "gh api repos/x/issues -f title=hi",
    "gh api -X POST repos/x/dispatches",
    "gh api --method=DELETE repos/x/hooks/1",
    "gh pr merge 12",
    "curl -o out.html https://example.com",
    "curl -d a=b https://example.com",
    "cat a > b",
    "echo $(gh api x) >> notes.txt",
    "rm -rf build",
    'eval "$P api repos"',
    "for f in a; do rm $f; done",
    "curl -XPOST https://x",
    "curl -sX POST https://x",
    "curl -sd a https://x",
    "curl -sSLo f https://x",
    "curl -sO https://x",
    "curl --data-ascii a https://x",
    "curl --mail-rcpt a@b smtp://x",
    "gh api -XPOST repos/x",
    "gh api -X=POST repos/x",
    "gh api -fa=b repos/x",
    "gh api -X GET -X POST repos/x",
    "echo ${X:-$(rm y)}",
    "echo $(( $(rm x) ))",
    "base64 -o out f",
    "sed 's/a/b/w out' f",
    "sort f -ofile",
    "git log --output=f"
  ])("%s may change something", (command) => {
    expect(changesNothing(command, NORMAL)).toBe(false)
  })

  it.each([
    "GH_PAGER=cat GH_PROMPT_DISABLED=1 NO_COLOR=1 gh api repos/openai/codex/commits/main --jq '{sha:.sha,date:.commit.committer.date}'",
    `GH_PAGER=cat gh api repos/x --jq "{sha:.sha,date:.date}"`,
    `GH_PAGER=cat gh api repos/x --jq '{sha:'".sha"',date:.date}'`,
    `X=1; echo '$HOME' '\`date\`' '\${X:-$(touch out)}'`,
    String.raw`X=1; echo \$HOME \{a,b\} "\$HOME"`,
    "cat <<'EOF'\n$(touch out) $HOME\nEOF",
    "cat <<EOF\nliteral {a,b}\nEOF",
    String.raw`cat <<EOF
\$(touch out)
EOF`,
    "cat <(printf '%s' '$HOME')"
  ])("keeps literal shell-looking data read-only: %s", (command) => {
    expect(changesNothing(command, NORMAL)).toBe(true)
  })

  it.each([
    `X=1; echo "$HOME"`,
    "X=1; echo '${HOME}'$HOME",
    "X=1; echo {a,b}",
    "X=1; sort -{'o','o'} out f",
    "X=1; sort -{o..o} out f",
    `X=1; echo "$(touch out)"`,
    "X=1; echo `touch out`",
    "A=${X:-$(touch out)} gh api repos/x",
    "A=${X:-$(touch out)}; gh api repos/x",
    "A=$(( $(touch out) )); gh api repos/x",
    "A=$(touch out); gh api repos/x",
    "echo hi; A=${X:-$(touch out)}",
    "echo hi; A=$(( $(touch out) ))",
    "echo hi; A=${X:-$(touch out)};",
    "echo hi; A=${X:-$(touch out)}; echo done",
    "cat <(A=${X:-$(touch out)})",
    "cat <(echo hi; A=$(( $(touch out) )))",
    "cat <(echo ${X:-$(touch out)})",
    "cat >(cat > out)",
    "cat <<EOF\n'$(touch out)'\nEOF",
    "X=1 cat <<EOF\n$(touch out)\nEOF",
    "X=1; echo '$HOME' > out",
    "X=1; sort $'-o' out f"
  ])("keeps active expansions and writes conservative: %s", (command) => {
    expect(changesNothing(command, NORMAL)).toBe(false)
    expect(readOnly(command)).toBe(false)
  })

  it("keeps environment-prefixed literal reads behind the existing approval gate", () => {
    const command = "GH_PAGER=cat gh api repos/x --jq '{sha:.sha,date:.date}'"
    expect(changesNothing(command, NORMAL)).toBe(true)
    expect(readOnly(command)).toBe(false)
  })

  it("asks before a read-only executable that can still write", () => {
    for (const command of [
      "sed 's/a/b/w out' f",
      "sed 'e touch x' f",
      "sed '1w out' f",
      "sed '$w out' f",
      "sed '/x/w out' f",
      "sed 's/a/b/e' f",
      "sed 's|a|b|gw out' f",
      "sed --expression='w out' f",
      "sed -n -es/a/b/w f",
      "sed 'w/dev/stdout' f",
      "sed '0~2w out' f",
      "sed '1,+2w out' f",
      "sed '/x/I w out' f",
      "sed -f script.sed f",
      "sort f -ofile",
      "date -s 2020",
      "git log --output=f"
    ])
      expect(isReadOnlyCommand(parseCommandSegments(command), NORMAL)).toBe(false)
  })

  it("does not widen what runs without a card", () => {
    expect(isReadOnlyCommand(parseCommandSegments("gh api repos/x"), NORMAL)).toBe(false)
    expect(isReadOnlyCommand(parseCommandSegments("curl -s https://example.com"), NORMAL)).toBe(
      false
    )
  })
})

describe("sed reads only inside its allowlist", () => {
  it.each([
    "sed -n '1,20p' f",
    "sed 's/a/b/' f",
    "sed -n '/error/p' f",
    "sed -n '1,20p;30p' f",
    "sed -n 1,20p file.ts",
    "sed -E 's/(a|b)+/x/g' f",
    "sed 's|a|b|g' f",
    "sed -ne '/x/,+3p' f",
    "sed --quiet --expression='$p' f",
    "sed '0~2d' f",
    "sed 5q f",
    "sed -n '/a\\/b/Ip' f",
    "cat f | sed -n '$='"
  ])("%s reads only", (command) => {
    expect(readOnly(command)).toBe(true)
  })

  it.each([
    "sed '\\,x,w out' f",
    "sed '\\%a%e' f",
    "sed '1,\\,x,w out' f",
    "sed '/[/]/w out' f",
    "sed 's/[/]/x/w out' f",
    "sed --in-pl 's/a/b/' f",
    "sed --in=.bak 's/a/b/' f",
    "sed --fi=scr.sed f",
    "sed --expr='w out' f",
    "sed --e='w out' f",
    "sed -nf scr.sed f",
    "sed -s p f",
    "sed 'w out' f",
    "sed 's/a/b/w out' f",
    "sed 's/a/b/e' f",
    "sed 'e touch x' f",
    "sed '1w out' f",
    "sed 'r /etc/passwd' f",
    "sed 'R other' f",
    "sed 'y/ab/cd/' f",
    "sed '{p}' f",
    "sed --expression='w out' f",
    "sed -n -es/a/b/w f",
    "sed 'w/dev/stdout' f",
    "sed -f script.sed f",
    "X=-i; sed -n 1p $X f",
    'sed -n p "$X" f',
    "sed -n p ${X} f",
    "sed -n p $(echo -i) f"
  ])("%s asks", (command) => {
    expect(readOnly(command)).toBe(false)
    expect(changesNothing(command, NORMAL)).toBe(false)
  })

  it("rejects a long script in linear time", () => {
    const started = performance.now()
    expect(changesNothing(`sed -n '${" ".repeat(4_000)}w x' f`, NORMAL)).toBe(false)
    expect(readOnly(`sed '${" ".repeat(3_000)}w x' f`)).toBe(false)
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})

describe("globs expand against the folder", () => {
  it.each([
    "find . -name *",
    "find . -iname *",
    "find . -name [-]*",
    "find . -name -name [-]delete",
    "find . ?delete",
    "rg foo [-]-pre=evil",
    "rg foo *",
    "sed -n p [-]i f",
    "sed -n 1p *",
    "grep -r foo *",
    "git branch *",
    "find . [[:punct:]]*",
    "find . [!]a]*",
    "find . [[.-.]]*",
    "rg -g -- *",
    "rg foo -- *",
    "ls [z-a]*"
  ])("%s asks where files are named like flags", (command) => {
    expect(readOnly(command, HOSTILE)).toBe(false)
    expect(changesNothing(command, HOSTILE)).toBe(false)
  })

  it.each([
    "grep -r foo *.ts",
    "sed -n 1p *.ts",
    "sort *.txt",
    "jq . *.json",
    "git log -- *.ts",
    "fd foo *.ts",
    "find . -newer *.ts",
    "find . -name *.ts",
    "ls *.ts",
    "rg foo *",
    "cat *.txt | sed -n '1,5p'"
  ])("%s reads only in an ordinary folder", (command) => {
    expect(readOnly(command)).toBe(true)
  })

  it("reads quoted globs as written", () => {
    expect(readOnly("find . -name '*'", HOSTILE)).toBe(true)
    expect(readOnly("ls a*", HOSTILE)).toBe(true)
    expect(readOnly("find . -name '*' -delete", HOSTILE)).toBe(false)
  })

  it("counts a glob after cd, and a brace sequence, as a change", () => {
    expect(changesNothing("cd src && find . *", NORMAL)).toBe(false)
    expect(changesNothing("(cd src; ls *)", NORMAL)).toBe(false)
    expect(changesNothing("for x in 1; do cd src; find . *; done", NORMAL)).toBe(false)
    expect(changesNothing("if true; then cd src; fi; find . *", NORMAL)).toBe(false)
    expect(changesNothing("! cd src; find . *", NORMAL)).toBe(false)
    expect(changesNothing("./cd x", NORMAL)).toBe(false)
    expect(changesNothing("while true; do find . *; cd src; done", NORMAL)).toBe(false)
    expect(changesNothing("X=1; sort -{o..o} out in", NORMAL)).toBe(false)
  })

  it("judges a glob in linear time and never throws", () => {
    const started = performance.now()
    expect(readOnly("ls *a*a*a*a*a*a*a*a*a*a*a*a*b")).toBe(true)
    expect(readOnly("ls [z-a]*")).toBe(true)
    expect(performance.now() - started).toBeLessThan(500)
  })
})

it("counts a loosely read word the shell fills in as a change", () => {
  expect(changesNothing('for f in a b; do gh api "repos/$f"; done', NORMAL)).toBe(false)
  expect(changesNothing("X=--pre=sh; rg $X foo", NORMAL)).toBe(false)
})
