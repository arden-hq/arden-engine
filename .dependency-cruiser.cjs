// Architecture rules for the engine workspaces. `bun run depcruise` fails on a
// violation that .dependency-cruiser-known-violations.json does not list;
// `just ratchet` drops fixed ones from that baseline and never adds any.
// Layer rules count type-only imports too (direction, not load order);
// only the cycle rule is limited to runtime edges.

const server = "^apps/server-ts/src/"
const effectModule = "(^|/)node_modules/(effect|@effect/[^/]+)/"

/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular-runtime",
      severity: "error",
      comment: "No runtime import cycle; type-only cycles are allowed (TOOLING-15).",
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ["type-only"] } }
    },
    {
      name: "libs-not-to-apps",
      severity: "error",
      comment: "Libraries never depend on an app (TOOLING-14).",
      from: { path: "^libs/" },
      to: { path: "^apps/" }
    },
    {
      name: "libs-declared-dependencies",
      severity: "error",
      comment: "A library's shipped code imports only packages its manifest lists as dependencies or peers (TOOLING-25).",
      from: { path: "^libs/[^/]+/src/" },
      to: { dependencyTypes: ["npm-dev", "npm-no-pkg", "npm-unknown", "unknown"], dependencyTypesNot: ["npm", "npm-peer", "npm-optional"] }
    },
    {
      name: "cross-workspace-relative",
      severity: "error",
      comment: "Reach another workspace through its package name, never ../../ (TOOLING-14).",
      from: { path: "^(apps|libs)/([^/]+)/" },
      to: {
        path: "^(apps|libs)/",
        pathNot: "^$1/$2/",
        // Relative specifiers only: a package-name import of a workspace lib
        // resolves through its `arden-source` condition into that lib's src.
        dependencyTypes: ["local"]
      }
    },
    {
      name: "src-not-to-tests",
      severity: "error",
      comment: "Shipped code never imports test code.",
      from: { path: "/(src|electron)/" },
      to: { path: "/(test|tests)/" }
    },
    {
      name: "loop-no-effect",
      severity: "error",
      comment: "@arden-hq/loop is Effect-free (D-123, LIBS-11).",
      from: { path: "^libs/loop/src/" },
      to: { path: effectModule }
    },
    {
      name: "loop-agent-not-to-providers",
      severity: "error",
      comment: "The agent talks to providers through src/contracts/ only (LIBS-08).",
      from: { path: "^libs/loop/src/agent/" },
      to: { path: "^libs/loop/src/providers/" }
    },
    {
      name: "loop-providers-not-to-runtime",
      severity: "error",
      comment: "Providers build on the provider kit and the root contracts, never the agent, tools or internals (LIBS-08).",
      from: { path: "^libs/loop/src/providers/" },
      to: { path: "^libs/loop/src/(agent|tools|internal)/" }
    },
    {
      name: "server-persistence-not-to-domain",
      severity: "error",
      comment: "Persistence sits below prompts, context, chat, tools and the domain modules (SRV-PERSIST, SRV-DOMAIN-05, SRV-TOOLS).",
      from: { path: `${server}persistence/` },
      to: { path: `${server}(prompts|context|chat|tools|automations|workflows|wiki|memory|research|storage|artifacts)/` }
    },
    {
      name: "server-port-not-to-sql",
      severity: "error",
      comment: "Persistence port folders stay storage-agnostic; SQL and SSE live in sqlite/ and schema/ (SRV-PERSIST).",
      from: { path: `${server}persistence/(?!sqlite/|schema/)[^/]+/` },
      to: { path: "(^|/)node_modules/effect/.*/unstable/(sql|encoding/Sse)" }
    },
    {
      name: "server-leaf-not-to-root",
      severity: "error",
      comment: "Contracts live in leaves; server.ts composes them (TOOLING-15).",
      from: { path: server, pathNot: `${server}(index|main|daemon)\\.ts$` },
      to: { path: `${server}server\\.ts$` }
    },
    {
      name: "server-tools-not-to-http",
      severity: "error",
      comment: "Tools never reach into HTTP handlers (SRV-TOOLS).",
      from: { path: `${server}tools/` },
      to: { path: `${server}http/` }
    },
    {
      name: "server-wiki-not-to-automations",
      severity: "error",
      comment: "Wiki does not depend on automations (SRV-DOMAIN-10).",
      from: { path: `${server}wiki/` },
      to: { path: `${server}(automations|persistence/automations)/` }
    },
    {
      name: "server-jobs-not-to-edges",
      severity: "error",
      comment: "Workflows and automations never reach the composition root, HTTP or tools (SRV-DOMAIN-15).",
      from: { path: `${server}(workflows|automations)/` },
      to: { path: `${server}(server\\.ts$|http/|tools/)` }
    }
  ],
  options: {
    doNotFollow: { path: "(^|/)node_modules/" },
    // Build output only; packages under node_modules keep their dist paths so rules can see them.
    exclude: { path: ["^(apps|libs)/[^/]+/dist/"] },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["arden-source", "import", "require", "types", "default"],
      extensions: [".ts", ".tsx", ".d.ts", ".js", ".cjs", ".mjs"]
    }
  }
}
