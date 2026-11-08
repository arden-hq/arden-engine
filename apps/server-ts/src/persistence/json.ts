import { Schema } from "effect"

export const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json)

export type JsonObject = (typeof JsonObjectSchema)["Type"]

export const isJsonObject = Schema.is(JsonObjectSchema)

export const jsonText = (value: Schema.Json | undefined): string =>
  typeof value === "string" ? value : ""
