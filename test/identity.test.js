import assert from "node:assert/strict";
import test from "node:test";

import { verifyIdentity, identityCacheEntry, identityCacheValid } from "../src/identity.js";

const identity = {
  hostname: "a-MS-7E06",
  ip_addresses: ["192.0.2.77", "192.0.2.10"],
  gpus: [{ name: "NVIDIA GeForce RTX 4090", uuid: "GPU-example" }],
};

test("identity cache expires on TTL, stale liveness or connection generation change", () => {
  const client = { generation: 1, isFresh: () => true };
  const entry = identityCacheEntry(identity, client);
  assert.equal(identityCacheValid(entry, client), true);
  client.generation++;
  assert.equal(identityCacheValid(entry, client), false);
  client.generation--;
  client.isFresh = () => false;
  assert.equal(identityCacheValid(entry, client), false);
  client.isFresh = () => true;
  entry.verifiedAt -= 300001;
  assert.equal(identityCacheValid(entry, client), false);
});

test("verifyIdentity accepts matching host evidence", () => {
  assert.equal(
    verifyIdentity(identity, {
      expectedHostname: "a-MS-7E06",
      expectedIp: "192.0.2.10",
      expectedGpu: "RTX 4090",
    }),
    identity,
  );
});

test("verifyIdentity reports every mismatch", () => {
  assert.throws(
    () =>
      verifyIdentity(identity, {
        expectedHostname: "wrong-host",
        expectedIp: "192.0.2.20",
        expectedGpu: "RTX 5080",
      }),
    /hostname is.*IP 192\.0\.2\.20.*RTX 5080/u,
  );
});
