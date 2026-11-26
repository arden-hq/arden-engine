export type Agrees<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

export type Assert<T extends true> = T
