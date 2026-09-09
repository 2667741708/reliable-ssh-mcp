import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { evaluatePolicy, groupAllowed } from "../src/policy.js";

const restricted = {
  name: "gpu",
  mode: "restricted",
  allowPrograms: ["git", "nvidia-smi"],
  denyPrograms: ["dd"],
  readOnlyPrograms: [],
  allowScripts: false,
  allowScriptHashes: [],
  allowTemplates: ["gpu_inventory"],
  toolGroups: ["core", "templates"],
};

test("exact Python path permission does not allow other interpreters or override denials", () => {
  const program = "/opt/example/venv/bin/python";
  const scoped = { ...restricted, allowProgramPaths: [program] };
  assert.equal(evaluatePolicy(scoped, "exec_argv", { program }).allowed, true);
  for (const other of ["python", "/usr/bin/python", program.toUpperCase()]) {
    assert.equal(evaluatePolicy(scoped, "exec_argv", { program: other }).allowed, false);
  }
  assert.equal(evaluatePolicy(restricted, "exec_argv", { program }).allowed, false);
  assert.equal(evaluatePolicy({ ...scoped, denyPrograms: ["python"] }, "exec_argv", { program }).allowed, false);
  assert.equal(evaluatePolicy({ ...scoped, mode: "readonly" }, "exec_argv", { program }).allowed, false);
});

test("restricted policy allows only configured programs", () => {
  assert.equal(
    evaluatePolicy(restricted, "exec_argv", { program: "/usr/bin/git" })
      .allowed,
    true,
  );
  assert.equal(
    evaluatePolicy(restricted, "exec_argv", { program: "rm" }).allowed,
    false,
  );
  assert.equal(
    evaluatePolicy(restricted, "exec_argv", { program: "dd" }).allowed,
    false,
  );
});

test("restricted policy gates scripts and templates", () => {
  assert.equal(
    evaluatePolicy(restricted, "run_bash_script", {}).allowed,
    false,
  );
  assert.equal(evaluatePolicy(restricted, "run_script", {}).allowed, false);
  assert.equal(
    evaluatePolicy(restricted, "run_template", { template: "gpu_inventory" })
      .allowed,
    true,
  );
  assert.equal(
    evaluatePolicy(restricted, "run_template", { template: "unknown" }).allowed,
    false,
  );
  assert.equal(groupAllowed(restricted, "core"), true);
  assert.equal(groupAllowed(restricted, "tunnels"), false);
});

test("restricted policy permits only hash-allowlisted Bash scripts", () => {
  const script = "printf 'approved\\n'";
  const scriptHash = createHash("sha256").update(script).digest("hex");
  const scripted = {
    ...restricted,
    allowScripts: true,
    allowScriptHashes: [scriptHash],
  };
  assert.equal(
    evaluatePolicy(scripted, "run_bash_script", { script }).allowed,
    true,
  );
  assert.equal(
    evaluatePolicy(scripted, "run_script", { script, shell: "auto" }).allowed,
    true,
  );
  assert.equal(
    evaluatePolicy(scripted, "run_bash_script", { script: "rm -rf /" }).allowed,
    false,
  );
});

test("readonly policy permits only declared read-only programs", () => {
  const readonly = {
    ...restricted,
    mode: "readonly",
    readOnlyPrograms: ["df"],
  };
  assert.equal(
    evaluatePolicy(readonly, "exec_argv", { program: "df" }).allowed,
    true,
  );
  assert.equal(
    evaluatePolicy(readonly, "exec_argv", { program: "git" }).allowed,
    false,
  );
  assert.equal(evaluatePolicy(readonly, "write_file", {}).allowed, false);
  assert.equal(evaluatePolicy(readonly, "run_script", {}).allowed, false);
  assert.equal(
    evaluatePolicy(readonly, "start_remote_session", {}).allowed,
    false,
  );
  assert.equal(
    evaluatePolicy(readonly, "onboard_discovered_host", {}).allowed,
    false,
  );
});
