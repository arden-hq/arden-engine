export interface SnapshotNode {
  readonly indent: string
  readonly role: string
  readonly name: string | undefined
  readonly attrs: string | undefined
  readonly ref: string | undefined
  readonly headLength: number
  readonly valueAt: number
  readonly value: string | undefined
}

export function parseSnapshotNode(line: string): SnapshotNode | undefined {
  const head = /^(\s*- )([A-Za-z]+)(?: "((?:[^"\\]|\\.)*)")?(?: \[([^\]\n]*)\])?/.exec(line)
  if (head === null || head[1] === undefined || head[2] === undefined) return undefined
  const attrs = head[4]
  const ref =
    attrs === undefined ? undefined : /(?:^|[\s,])ref=(e[1-9][0-9]*)(?:$|[\s,\]])/.exec(attrs)?.[1]
  const rest = line.slice(head[0].length)
  const valueAt = rest.startsWith(": ") ? head[0].length + 2 : -1
  return {
    indent: head[1],
    role: head[2],
    name: head[3],
    attrs,
    ref,
    headLength: head[0].length,
    valueAt,
    value: valueAt < 0 ? undefined : line.slice(valueAt)
  }
}
