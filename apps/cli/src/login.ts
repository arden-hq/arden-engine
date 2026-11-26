import { chatGptLoginFile, startChatGptLogin } from "@arden-hq/headless/chatgpt-login"
import { errorMessage } from "@arden-hq/std/errors"
import { ardenCliDir } from "@arden-hq/std/paths"
import { spawn } from "node:child_process"

import type { CliDependencies } from "./command.js"
import { LOGIN_ACTION, type LoginAction } from "./cli-words.js"

export type { LoginAction }

export const loginCommand = async (
  action: LoginAction,
  dependencies: CliDependencies
): Promise<number> => {
  const store = chatGptLoginFile(ardenCliDir(dependencies.homeDirectory))
  try {
    switch (action) {
      case LOGIN_ACTION.status: {
        const tokens = await store.read()
        dependencies.writeStdout(
          tokens === undefined ? "Not signed in. Run `arden login`.\n" : "Signed in with ChatGPT.\n"
        )
        return tokens === undefined ? 1 : 0
      }
      case LOGIN_ACTION.signOut:
        await store.remove()
        dependencies.writeStdout("Signed out.\n")
        return 0
      case LOGIN_ACTION.signIn:
        return await signIn(store, dependencies)
    }
  } catch (cause) {
    dependencies.writeStderr(`arden: ${errorMessage(cause)}\n`)
    return 1
  }
}

const signIn = async (
  store: ReturnType<typeof chatGptLoginFile>,
  dependencies: CliDependencies
): Promise<number> => {
  const login = await (dependencies.startLogin ?? startChatGptLogin)()
  dependencies.writeStderr(`Sign in with ChatGPT in your browser:\n  ${login.url}\n`)
  ;(dependencies.openUrl ?? openInBrowser)(login.url)
  let interrupted = false
  const stop = dependencies.onSigint(() => {
    interrupted = true
    login.cancel()
  })
  try {
    await store.write(await login.tokens)
  } catch (cause) {
    if (interrupted) return 130
    throw cause
  } finally {
    stop()
  }
  dependencies.writeStdout("Signed in with ChatGPT.\n")
  return 0
}

const BROWSER_COMMANDS: Partial<Record<NodeJS.Platform, readonly [string, ...Array<string>]>> = {
  darwin: ["open"],
  linux: ["xdg-open"],
  win32: ["cmd", "/c", "start", ""]
}

const openInBrowser = (url: string): void => {
  const command = BROWSER_COMMANDS[process.platform]
  if (command === undefined) return
  const [program, ...args] = command
  const child = spawn(program, [...args, url], { detached: true, stdio: "ignore" })
  child.once("error", () => undefined)
  child.unref()
}
