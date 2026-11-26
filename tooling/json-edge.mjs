import { readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"

export const parseJson = (text) => {
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new Error(`Not valid JSON (${text.slice(0, 80)})`, { cause })
  }
}

export const readJsonFileSync = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch (cause) {
    throw new Error(`Cannot read JSON from ${file}`, { cause })
  }
}

export const readJsonFile = async (file) => {
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch (cause) {
    throw new Error(`Cannot read JSON from ${file}`, { cause })
  }
}

export const responseJson = (response) => response.json()
