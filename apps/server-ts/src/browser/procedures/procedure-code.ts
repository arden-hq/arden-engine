import { parseSnapshotNode } from "../../persistence/browser-procedures/snapshot-line.js"
import { procedureStart } from "../../persistence/browser-procedures/start.js"
import {
  PAGE_TEXT_MAX_CHARS,
  type StoredProcedure
} from "../../persistence/browser-procedures/model.js"

export const procedureCode = (
  procedure: Pick<StoredProcedure, "id" | "revision" | "spec" | "evidence">
): string => `
const input = args.input;
const tab_ref = args.tab_ref, profile_ref = args.profile_ref, origin = args.origin;
const normal = (value) => String(value).replace(/\\s+/g, " ").trim().replace(/:$/, "").trim().toLowerCase();
const pageText = (p) => String(p?.data?.page?.text ?? p?.data?.text ?? p?.content ?? "");
const unescape = (text) => { try { return JSON.parse('"' + text + '"'); } catch { return text; } };
${parseSnapshotNode.toString()}
const nodes = (p) => pageText(p).split("\\n").flatMap((line) => {
  const n = parseSnapshotNode(line);
  return n ? [{ role: n.role, name: unescape(n.name ?? ""), value: n.value ?? "", ref: n.ref && "@" + n.ref }] : [];
});
const visibleText = (p) => pageText(p).split("\\n").map((line) => {
  const n = parseSnapshotNode(line);
  return n ? [n.name === undefined ? "" : unescape(n.name), n.value ?? ""].filter(Boolean).join(" ") : line;
}).join("\\n");
const pageOrigin = (p) => {
  const view = p?.data?.page ?? p?.data ?? {};
  try { return new URL(view.origin ?? view.tab?.url).origin; } catch { return undefined; }
};
const control = (p, role, name) => {
  const view = p?.data?.page ?? p?.data ?? {};
  const found = nodes(p).find((n) => n.role === role && n.ref && normal(n.name) === normal(name));
  if (found) return { node_ref: found.ref, snapshot_ref: view.snapshot_ref };
  throw new Error("The page no longer shows " + role + " " + JSON.stringify(name) + "; inspect the page.");
};
let page = await tools.call("browser_snapshot", { tab_ref, max_chars: ${PAGE_TEXT_MAX_CHARS} });
for (const c of ${JSON.stringify(procedureStart(procedure.evidence.at(-1))?.controls ?? [])}) control(page, c.role, c.name);
const result = await (async (input, page) => {\n${procedure.spec.code}\n})(input, page);
await tools.call("browser_procedure_verify", {});
page = await tools.call("browser_snapshot", { tab_ref, mode: "text", max_chars: ${PAGE_TEXT_MAX_CHARS} });
const verification = await (async (input, result, page) => {\n${procedure.spec.verify}\n})(input, result, page);
if (!verification || verification.ok !== true || typeof verification.evidence !== "string" || verification.evidence.length === 0) throw new Error("The saved procedure's result was not confirmed. Read the current page before continuing.");
const fields = ${JSON.stringify(procedure.spec.outputs)};
if (!result || typeof result !== "object" || Array.isArray(result) || fields.some(f => result[f.name] === undefined ? f.required : typeof result[f.name] !== f.type)) throw new Error("The saved procedure returned an invalid result.");
return {procedure_verified:true,procedure_id:${JSON.stringify(procedure.id)},revision:${procedure.revision},result,evidence:verification.evidence};`
