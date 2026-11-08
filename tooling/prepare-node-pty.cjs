const fs = require("node:fs");
const path = require("node:path");

// Bun can extract node-pty's macOS prebuild without its executable bit, and
// then every terminal silently falls back to a pipe. The root postinstall
// runs this after every install.
for (const arch of ["arm64", "x64"]) {
  const helper = path.join(
    __dirname,
    "../apps/server-ts/node_modules/node-pty/prebuilds",
    `darwin-${arch}`,
    "spawn-helper"
  );
  if (!fs.existsSync(helper)) continue;
  fs.chmodSync(helper, fs.statSync(helper).mode | 0o111);
}
