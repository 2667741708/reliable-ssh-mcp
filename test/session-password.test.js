import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { SessionPassword, assertPasswordChangeIdle } from "../src/session-password.js";
import { summarizeToolArguments } from "../src/audit.js";
import { createReliableSshServer } from "../src/server.js";
import { createFleetServer } from "../src/fleet-server.js";
import { parseConfig } from "../src/config.js";
import { persistentCommandArgs } from "../src/connection-pool.js";
import { plinkArgs } from "../src/plink-args.js";

function config() {
  return parseConfig(["--ssh-target", "user@192.0.2.10", "--ssh-flavor", "plink", "--ssh-command", "plink.exe", "--host-key", "ssh-ed25519 AAAA"]);
}

test("Plink preserves explicit bastion command and refuses silent direct routing", () => {
  const selected = { ...config(), proxyCommand: 'ssh -W 192.0.2.10:22 bastion' };
  assert.ok(plinkArgs(selected, ['python3 -']).includes(selected.proxyCommand));
  assert.ok(plinkArgs(selected, ['python3 -']).includes('-proxycmd'));
  assert.throws(() => plinkArgs({ ...config(), proxyJump: 'bastion' }, []), /ProxyJump/);
});

test("private session file rotates, restores startup credentials, and stays out of argv/audit", () => {
  const selected = { ...config(), passwordFile: "original-password-file" };
  const store = new SessionPassword(selected);
  try {
    store.set("first-password");
    const first = selected.passwordFile;
    assert.equal(readFileSync(first, "utf8"), "first-password\n");
    if (process.platform !== "win32") assert.equal(statSync(first).mode & 0o777, 0o600);
    const args = persistentCommandArgs(selected, "python3 -");
    assert.ok(args.includes("-batch"));
    assert.ok(args.includes("-hostkey"));
    assert.ok(args.includes("-pwfile"));
    assert.ok(!JSON.stringify(args).includes("first-password"));
    const audit = JSON.stringify(summarizeToolArguments("provide_connection_password", { password: "first-password" }));
    assert.ok(!audit.includes("first-password"));
    assert.ok(!audit.includes("sha256"));
    store.set("second-password");
    assert.equal(existsSync(first), false);
    const second = selected.passwordFile;
    assert.throws(() => store.set("bad\npassword"), /without newline/);
    assert.equal(readFileSync(second, "utf8"), "second-password\n");
    store.clear();
    assert.equal(existsSync(second), false);
    assert.equal(selected.passwordFile, "original-password-file");
  } finally { store.clear(); }
});

test("rejects unsupported transports and unpinned hosts before storing secrets", () => {
  assert.throws(() => new SessionPassword({ sshFlavor: "openssh" }).set("secret"), /Plink/);
  assert.throws(() => new SessionPassword({ sshFlavor: "plink" }).set("secret"), /pinned/);
  assert.throws(() => assertPasswordChangeIdle({ starting: Promise.resolve() }), /in-flight/);
  assert.throws(() => assertPasswordChangeIdle({ status: () => ({ sessions: [{ in_flight: 1 }] }) }), /in-flight/);
});

test("single-server password entry works before identity and cleanup does not alter remote password", async () => {
  const selected = config();
  let invocations = 0;
  const fake = { invoke: async () => {
    invocations++;
    assert.equal(readFileSync(selected.passwordFile, "utf8"), "interactive-secret\n");
    return { hostname: "test", ip_addresses: ["192.0.2.10"], gpus: [] };
  }, close() {} };
  const server = createReliableSshServer(selected, fake);
  try {
    const supplied = await server._registeredTools.provide_connection_password.handler({ password: "interactive-secret" });
    assert.ok(!supplied.isError);
    assert.equal(invocations, 0);
    assert.ok(!JSON.stringify(supplied).includes("interactive-secret"));
    const result = await server._registeredTools.probe_identity.handler({ force: true });
    assert.ok(!result.isError);
    assert.equal(invocations, 1);
    const file = selected.passwordFile;
    await server._registeredTools.clear_connection_password.handler({});
    assert.equal(existsSync(file), false);
    assert.equal(selected.passwordFile, undefined);
  } finally { await server.close(); }
});

test("fleet credentials stay scoped per server and respect connection tool groups", async () => {
  const a = { ...config(), name: "a", toolGroups: ["connections"], mode: "readonly" };
  const b = { ...config(), name: "b", toolGroups: [], mode: "readonly" };
  const runtime = createFleetServer({ servers: { a, b } });
  try {
    const tool = runtime.server._registeredTools.provide_connection_password.handler;
    assert.ok(!(await tool({ server: "a", password: "a-secret" })).isError);
    const file = a.passwordFile;
    assert.equal(b.passwordFile, undefined);
    assert.ok((await tool({ server: "b", password: "b-secret" })).isError);
    runtime.close();
    assert.equal(existsSync(file), false);
  } finally { runtime.close(); await runtime.server.close(); }
});
