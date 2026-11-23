import { describe, expect, it } from "vitest"
import { commandFacts } from "../src/tools/approval-decision.js"

const floorOf = (command: string, cwd: string | undefined) =>
  commandFacts({ command, cwd }, "/Users/sam").floor

describe("the destructive-command floor reads parsed commands, not substrings", () => {
  it.each<[string, string | undefined]>([
    ["rm -rf /tmp/build", undefined],
    ["git log --grep=mkfs", undefined],
    ['echo "dd if=x"', undefined],
    ["ls ~/fdisk-notes", undefined],
    ["rm -rf /tmp/*", undefined],
    ["cd build && rm -rf *", "/Users/sam"],
    ["rm -rf *.log", "/Users/sam"],
    ["find . -name '*.o' -delete", "/Users/sam"],
    ["find . -name x | xargs rm -rf", undefined],
    ["cat <<EOF\nrm -rf /\nEOF", undefined],
    ["(cd /; ls); rm -rf *", "/Users/sam/p/build"],
    ["echo 'rm -rf ~' > notes.txt", undefined]
  ])("runs %j in %s", (command, workdir) => {
    expect(floorOf(command, workdir)).toBeUndefined()
  })

  it.each<[string, string | undefined]>([
    ["rm -fr /", undefined],
    ['rm -rf "$HOME"', undefined],
    ["sudo rm -rf --no-preserve-root /", undefined],
    ["rm -rf /Users/sam", undefined],
    ["bash -c 'rm -rf ~/'", undefined],
    ["dd if=/dev/zero of=/dev/disk2", undefined],
    ["echo $(date); rm -rf /", undefined],
    ["cat <<EOF\nhi\nEOF\nrm -rf /", undefined],
    ['rm -rf "${HOME:?}"', undefined],
    ["if true; then rm -rf /; fi", undefined],
    ["for i in 1; do rm -rf /; done", undefined],
    ["timeout 5 rm -rf /", undefined],
    ["eval 'rm -rf /'", undefined],
    ["env -S 'rm -rf /'", undefined],
    ["bash -c -- 'rm -rf ~'", undefined],
    ["echo / | xargs rm -rf", undefined],
    ["find / -delete", undefined],
    ["find ~ -exec rm -rf {} +", undefined],
    ["rm -rf usr", "/"],
    ["rm -rf ./*", "/Users/sam"],
    ["tee /dev/disk2 < /dev/zero", undefined],
    ["diskutil apfs deleteContainer disk1", undefined],
    [":(){ :|:& };:", undefined],
    ["rm -rf *", "/Users/sam"],
    ["rm -rf .", "/Users/sam"],
    ["bash <<'EOF'\nrm -rf ~\nEOF", undefined],
    ["echo rm -rf / | sh", undefined],
    ["rm -rf /U*", undefined],
    ["rm -rf /Users/s*", undefined],
    ["pushd / && rm -rf *", undefined],
    ["rm -rf $'/'", undefined],
    ["rm -r -f /Volumes/Macintosh\\ HD", undefined]
  ])("refuses %j in %s", (command, workdir) => {
    expect(floorOf(command, workdir)).toBe("destructive_command")
  })
})
