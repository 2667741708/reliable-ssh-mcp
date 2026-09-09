import assert from "node:assert/strict";
import test from "node:test";

import { renderTemplate } from "../src/templates.js";

test("template rendering preserves parameters as argv data", () => {
  const rendered = renderTemplate(
    {
      program: "git",
      args: ["show", "{{revision}}:{{path}}"],
      cwd: "{{repository}}",
      env: {},
      parameters: ["revision", "path", "repository"],
    },
    {
      revision: "HEAD; rm -rf /",
      path: "file with spaces",
      repository: "/tmp/project",
    },
  );
  assert.deepEqual(rendered.args, ["show", "HEAD; rm -rf /:file with spaces"]);
  assert.equal(rendered.cwd, "/tmp/project");
});

test("template rendering rejects missing and unexpected parameters", () => {
  const template = {
    program: "df",
    args: ["{{path}}"],
    env: {},
    parameters: ["path"],
  };
  assert.throws(() => renderTemplate(template, {}), /Missing/u);
  assert.throws(
    () => renderTemplate(template, { path: "/", extra: "x" }),
    /Unexpected/u,
  );
});
