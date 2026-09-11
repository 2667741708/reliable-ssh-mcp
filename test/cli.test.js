import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

for (const flag of ["--help", "-h"]) {
  test(`${flag} prints usage and exits successfully`, () => {
    const result = spawnSync(process.execPath, ["src/index.js", flag], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: reliable-ssh-mcp/u);
    assert.equal(result.stderr, "");
  });
}
