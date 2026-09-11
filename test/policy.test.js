import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { evaluatePolicy, groupAllowed } from "../src/policy.js";
import { renderTemplate } from "../src/templates.js";

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
  assert.equal(
    evaluatePolicy(readonly, "exec_argv", { program: "/tmp/df" }).allowed,
    false,
  );
  assert.equal(
    evaluatePolicy(
      { ...readonly, readOnlyPrograms: ["/usr/bin/df"] },
      "exec_argv",
      { program: "/usr/bin/df" },
    ).allowed,
    true,
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

test("readonly exec uses built-in positive argv profiles and fails closed", () => {
  const readonly = {
    ...restricted,
    mode: "readonly",
    readOnlyPrograms: ["find", "sed", "journalctl", "ip", "git", "systemctl", "nvidia-smi"],
  };

  for (const args of [
    ["/tmp", "-delete"],
    ["/tmp", "-exec", "rm", "{}", ";"],
    ["/tmp", "-execdir", "rm", "{}", ";"],
    ["/tmp", "-ok", "rm", "{}", ";"],
  ]) {
    const result = evaluatePolicy(readonly, "exec_argv", { program: "find", args });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /no built-in profile exists/u);
    assert.equal(result.code, "READONLY_PROFILE_UNAVAILABLE");
    assert.equal(result.suggestedTool, undefined);
    assert.match(result.nextStep, /code-reviewed and tested/u);
  }

  for (const request of [
    { program: "sed", args: ["-i", "s/a/b/", "file"] },
    { program: "sed", args: ["w", "/tmp/output"] },
    { program: "journalctl", args: ["--vacuum-time=1s"] },
    { program: "journalctl", args: ["--rotate"] },
    { program: "ip", args: ["link", "set", "eth0", "down"] },
  ]) {
    assert.equal(evaluatePolicy(readonly, "exec_argv", request).allowed, false);
  }
});

test("readonly profiles reject mutating subcommands and options", () => {
  const readonly = {
    ...restricted,
    mode: "readonly",
    readOnlyPrograms: ["git", "systemctl", "nvidia-smi"],
  };

  for (const args of [
    ["clean", "-fd"], ["reset", "--hard"], ["checkout", "main"],
    ["config", "user.name", "attacker"], ["diff"], ["show"], ["log"],
  ]) {
    assert.equal(evaluatePolicy(readonly, "exec_argv", { program: "git", args }).allowed, false);
  }
  assert.equal(evaluatePolicy(readonly, "exec_argv", { program: "git", args: ["status", "--short"] }).allowed, false);
  assert.equal(evaluatePolicy(readonly, "exec_argv", {
    program: "git",
    args: ["--no-pager", "--no-optional-locks", "status", "--short"],
  }).allowed, true);
  assert.equal(evaluatePolicy(readonly, "exec_argv", {
    program: "git",
    args: ["--no-pager", "rev-parse", "--show-toplevel"],
  }).allowed, true);

  for (const option of ["--root=/tmp", "--image=/tmp/disk", "--runtime", "--preset-mode=full", "--what=users", "--who=test"]) {
    const result = evaluatePolicy(readonly, "exec_argv", { program: "systemctl", args: ["status", option] });
    assert.equal(result.allowed, false);
    assert.equal(result.code, "READONLY_PROFILE_DENIED");
    assert.equal(result.suggestedTool, undefined);
    assert.match(result.nextStep, /dedicated read-only tool/u);
  }

  for (const args of [["restart", "sshd"], ["enable", "sshd"]]) {
    assert.equal(evaluatePolicy(readonly, "exec_argv", { program: "systemctl", args }).allowed, false);
  }
  assert.equal(evaluatePolicy(readonly, "exec_argv", { program: "systemctl", args: ["status", "sshd"] }).allowed, true);

  for (const args of [["-pl", "100"], ["-pm", "1"], ["--gpu-reset"]]) {
    assert.equal(evaluatePolicy(readonly, "exec_argv", { program: "nvidia-smi", args }).allowed, false);
  }
  assert.equal(evaluatePolicy(readonly, "exec_argv", { program: "nvidia-smi", args: ["-L"] }).allowed, true);
});

test("readonly profiles reject environment overrides and stdin", () => {
  const readonly = {
    ...restricted,
    mode: "readonly",
    readOnlyPrograms: ["git", "df"],
  };
  assert.equal(evaluatePolicy(readonly, "exec_argv", {
    program: "git", args: ["status"], env: { GIT_EXTERNAL_DIFF: "/tmp/run-me" },
  }).allowed, false);
  assert.equal(evaluatePolicy(readonly, "exec_argv", {
    program: "df", stdin: "unexpected",
  }).allowed, false);
});

test("readonly template rendering preserves the same safe argv invariant", () => {
  const readonly = {
    ...restricted,
    mode: "readonly",
    readOnlyPrograms: ["git"],
    allowTemplates: ["safe_status", "unsafe_reset"],
  };
  const safe = renderTemplate({
    name: "safe_status",
    program: "git",
    args: ["--no-pager", "--no-optional-locks", "status", "--short", "--branch"],
    env: {},
    parameters: [],
  }, {});
  const unsafe = renderTemplate({
    name: "unsafe_reset",
    program: "git",
    args: ["reset", "--hard"],
    env: {},
    parameters: [],
  }, {});

  assert.equal(evaluatePolicy(readonly, "run_template", { template: "safe_status" }).allowed, true);
  assert.equal(evaluatePolicy(readonly, "exec_argv", safe).allowed, true);
  assert.equal(evaluatePolicy(readonly, "run_template", { template: "unsafe_reset" }).allowed, true);
  assert.equal(evaluatePolicy(readonly, "exec_argv", unsafe).allowed, false);
});
