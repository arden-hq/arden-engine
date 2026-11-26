export interface MarketplaceSkillAddress {
  readonly source: string
  readonly name: string
}

export const marketplaceSkillId = (address: MarketplaceSkillAddress): string =>
  `${address.source}/${address.name}`

export const splitMarketplaceSkillId = (id: string): MarketplaceSkillAddress | undefined => {
  const separator = id.lastIndexOf("/")
  return separator <= 0
    ? undefined
    : { source: id.slice(0, separator), name: id.slice(separator + 1) }
}
