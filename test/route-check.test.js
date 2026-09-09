import assert from "node:assert/strict";
import test from "node:test";

import {
  parseEffectiveHostname,
  validateEffectiveRoute,
} from "../src/route-check.js";

test("route check reads the effective OpenSSH HostName", () => {
  const output = "user a\nhostname 192.0.2.13\nport 22\n";
  assert.equal(parseEffectiveHostname(output), "192.0.2.13");
  assert.equal(
    validateEffectiveRoute(output, {
      sshTarget: "example-gpu",
      expectedIp: "192.0.2.13",
    }),
    "192.0.2.13",
  );
});

test("route check rejects a stale MCP expected IP", () => {
  assert.throws(
    () =>
      validateEffectiveRoute("hostname 192.0.2.13\n", {
        sshTarget: "example-gpu",
        expectedIp: "192.0.2.103",
      }),
    /SSH route mismatch/u,
  );
});

test("route check supports a public NAT route and a private remote identity IP", () => {
  assert.equal(
    validateEffectiveRoute("hostname 198.51.100.20\n", {
      sshTarget: "cloud",
      expectedIp: "10.0.0.20",
      expectedRouteHost: "198.51.100.20",
    }),
    "198.51.100.20",
  );
});
