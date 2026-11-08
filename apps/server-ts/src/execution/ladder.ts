export interface Rung<In, Out> {
  readonly name: string
  readonly answer: (input: In) => Out | undefined
}

export const firstAnswer = <In, Out>(
  rungs: ReadonlyArray<Rung<In, Out>>,
  input: In
): Out | undefined => {
  for (const rung of rungs) {
    const answer = rung.answer(input)
    if (answer !== undefined) return answer
  }
  return undefined
}
