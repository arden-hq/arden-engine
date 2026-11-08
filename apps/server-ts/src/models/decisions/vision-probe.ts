import { encodePng } from "../../lib/png.js"
import type { DecisionInput, DecisionResult } from "./questions.js"

export const decisionVisionProbe = (): Pick<DecisionInput, "images" | "questions"> => ({
  images: [image(false), image(true)],
  questions: {
    first: {
      kind: "choice",
      instructions: "In the FIRST attached image, which side contains the red rectangle?",
      options: [
        { value: "left", description: "Left half" },
        { value: "right", description: "Right half" }
      ]
    },
    second: {
      kind: "choice",
      instructions: "In the SECOND attached image, which side contains the red rectangle?",
      options: [
        { value: "left", description: "Left half" },
        { value: "right", description: "Right half" }
      ]
    }
  }
})

export const readsProbeImages = (result: DecisionResult): boolean =>
  result.answers.first?.kind === "choice" &&
  result.answers.first.value === "left" &&
  result.answers.second?.kind === "choice" &&
  result.answers.second.value === "right"

const image = (right: boolean): DecisionInput["images"][number] => {
  const size = 320
  const pixels = new Uint8Array(size * size * 4).fill(255)
  for (let y = 80; y < 240; y++) {
    for (let x = right ? 180 : 20; x < (right ? 300 : 140); x++) {
      const index = (y * size + x) * 4
      pixels[index + 1] = 0
      pixels[index + 2] = 0
    }
  }
  return {
    mediaType: "image/png",
    data: encodePng({ width: size, height: size, pixels }).toString("base64")
  }
}
