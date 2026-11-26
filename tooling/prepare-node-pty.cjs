const fs = require("node:fs");
const path = require("node:path");

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
