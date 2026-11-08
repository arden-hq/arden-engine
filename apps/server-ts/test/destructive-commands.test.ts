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
    ["rm -rf /tmp/", undefined],
    ["rm -rf /app", undefined],
    ["cd build && rm -rf *", "/Users/sam"],
    ["rm -rf *.log", "/Users/sam"],
    ["find . -name '*.o' -delete", "/Users/sam"],
    ["find . -name x | xargs rm -rf", undefined],
    ["cat <<EOF\nrm -rf /\nEOF", undefined],
    ["rm -rf *", "/Users/sam/proj/build"],
    ["find . -type f -delete", "/Users/sam/p"],
    ["cd build; cd -; rm -rf *", "/Users/sam/p"],
    ["(cd /; ls); rm -rf *", "/Users/sam/p/build"],
    ["find ~/p -name x | xargs rm -rf", undefined],
    ["echo 'rm -rf ~' > notes.txt", undefined],
    ["rm -rf {build,dist}", "/Users/sam/p"]
  ])("runs %j in %s", (command, workdir) => {
    expect(floorOf(command, workdir)).toBeUndefined()
  })

  it.each<[string, string | undefined]>([
    ["rm -fr /", undefined],
    ["rm -r -f /", undefined],
    ["rm  -rf /", undefined],
    ["rm -rf $HOME", undefined],
    ['rm -rf "$HOME"', undefined],
    ["sudo rm -rf --no-preserve-root /", undefined],
    ["rm -rf /Users/sam", undefined],
    ["bash -c 'rm -rf ~/'", undefined],
    ["rm -rf / 2>/dev/null", undefined],
    ["dd if=/dev/zero of=/dev/disk2", undefined],
    ["echo $(date); rm -rf /", undefined],
    ["x=$(pwd); rm -rf ~", undefined],
    ["rm -rf ~ `true`", undefined],
    ["cat <<EOF\nhi\nEOF\nrm -rf /", undefined],
    ["rm -rf / ${X:-y}", undefined],
    ['rm -rf "${HOME:?}"', undefined],
    ["if true; then rm -rf /; fi", undefined],
    ["for i in 1; do rm -rf /; done", undefined],
    ["while true; do rm -rf ~; done", undefined],
    ["! rm -rf /", undefined],
    ["timeout 5 rm -rf /", undefined],
    ["caffeinate rm -rf /", undefined],
    ["stdbuf -o0 rm -rf /", undefined],
    ["watch rm -rf /", undefined],
    ["builtin command rm -rf /", undefined],
    ["eval 'rm -rf /'", undefined],
    ["env -S 'rm -rf /'", undefined],
    ["bash -c -- 'rm -rf ~'", undefined],
    ["echo / | xargs rm -rf", undefined],
    ["find / -delete", undefined],
    ["find ~ -exec rm -rf {} +", undefined],
    ["rm -rf usr", "/"],
    ["rm -rf .", "/Users/sam/x/.."],
    ["rm -rf ./*", "/Users/sam"],
    ["cd / && rm -rf ./*", undefined],
    ["tee /dev/disk2 < /dev/zero", undefined],
    ["cp /dev/zero /dev/rdisk2", undefined],
    ["diskutil apfs deleteContainer disk1", undefined],
    [":(){ :|:& };:", undefined],
    ["rm -rf *", "/Users/sam"],
    ["rm -rf .", "/Users/sam"],
    ["bash <<'EOF'\nrm -rf ~\nEOF", undefined],
    ["bash <<< 'rm -rf ~'", undefined],
    ["echo rm -rf / | sh", undefined],
    ["printf 'rm -rf ~' | sudo bash", undefined],
    ["echo / | sudo xargs rm -rf", undefined],
    ["xargs rm -rf <<EOF\n/\nEOF", undefined],
    ["find / -name '*' -delete", undefined],
    ["find / -exec sudo rm -rf {} +", undefined],
    ["rm -rf /U*", undefined],
    ["rm -rf /Users/s*", undefined],
    ["pushd / && rm -rf *", undefined],
    ["rm -rf $'/'", undefined],
    ["rm -r -f /Volumes/Macintosh\\ HD", undefined]
  ])("refuses %j in %s", (command, workdir) => {
    expect(floorOf(command, workdir)).toBe("destructive_command")
  })
})
