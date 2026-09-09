import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  effectiveLocalRoots,
  mergeClientRoots,
} from "../src/client-roots.js";

test("client file roots become portable named local roots", () => {
  const project = path.resolve("client-project");
  const shared = path.resolve("client-shared");
  const roots = mergeClientRoots({}, [
    { uri: pathToFileURL(project).href, name: "My Project" },
    { uri: pathToFileURL(shared).href, name: "Shared Data" },
    { uri: "https://example.invalid/not-local", name: "remote" },
  ]);

  assert.deepEqual(roots, {
    project,
    client_Shared_Data: shared,
  });
});

test("fallback mode never widens explicitly configured roots", async () => {
  let requests = 0;
  const configured = { project: path.resolve("explicit-project") };
  const mcpServer = {
    server: {
      getClientCapabilities: () => ({ roots: { listChanged: true } }),
      listRoots: async () => {
        requests += 1;
        return { roots: [] };
      },
    },
  };

  assert.deepEqual(
    await effectiveLocalRoots(mcpServer, configured, "fallback"),
    configured,
  );
  assert.equal(requests, 0);
});

test("merge mode keeps explicit roots and adds client roots", async () => {
  const clientPath = path.resolve("client-extra");
  const configured = { project: path.resolve("explicit-project") };
  const mcpServer = {
    server: {
      getClientCapabilities: () => ({ roots: {} }),
      listRoots: async () => ({
        roots: [{ uri: pathToFileURL(clientPath).href, name: "extra" }],
      }),
    },
  };

  assert.deepEqual(await effectiveLocalRoots(mcpServer, configured, "merge"), {
    ...configured,
    client_extra: clientPath,
  });
});
