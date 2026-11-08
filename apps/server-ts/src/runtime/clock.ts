export const currentMillis = (): number => Date.now()

export const iso = (epochMillis: number): string => new Date(epochMillis).toISOString()

export const currentIso = (): string => iso(Date.now())
