import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { installedAppAt } from "../src/app-launch.js"

const folders: Array<string> = []

afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

const bundle = async (entries: string): Promise<string> => {
  const folder = await mkdtemp(join(tmpdir(), "arden-bundle-"))
  folders.push(folder)
  const app = join(folder, "Arden.app")
  await mkdir(join(app, "Contents"), { recursive: true })
  await writeFile(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.arden.desktop</string>${entries}</dict></plist>`
  )
  return app
}

describe.runIf(process.platform === "darwin")("installedAppAt", () => {
  it("starts in the background only an app whose Info.plist declares it", async () => {
    const declared = await bundle("<key>ArdenBackgroundLaunch</key><true/>")
    const numbered = await bundle("<key>ArdenBackgroundLaunch</key><integer>1</integer>")
    const older = await bundle("")
    expect(await installedAppAt(declared)).toEqual({ kind: "background", path: declared })
    expect(await installedAppAt(numbered)).toEqual({ kind: "background", path: numbered })
    expect(await installedAppAt(older)).toEqual({ kind: "too_old", path: older })
  })
})
