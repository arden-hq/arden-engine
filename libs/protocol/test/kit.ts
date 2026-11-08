export const collect = async <T>(source: AsyncIterable<T>): Promise<Array<T>> => {
  const items: Array<T> = []
  for await (const item of source) items.push(item)
  return items
}
