/**
 * Compile-time agreement between a schema's inferred type and the hand-written
 * wire type that names it. `Agrees` is true only when each is assignable to the
 * other; `Assert` fails the build otherwise. Every large event union pairs its
 * schema and its type through these two, so drift between them is a type error
 * in this package, never a surprise in a consumer.
 */
export type Agrees<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

export type Assert<T extends true> = T
