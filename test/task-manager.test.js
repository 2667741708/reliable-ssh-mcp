import assert from "node:assert/strict";
import test from "node:test";

import { TaskManager } from "../src/task-manager.js";

async function waitFor(manager, id, status) {
  for (let count = 0; count < 100; count += 1) {
    const task = manager.get(id);
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Task ${id} did not reach ${status}`);
}

test("background task reports progress and completion", async () => {
  const manager = new TaskManager();
  const started = manager.start("copy", "server", async ({ update }) => {
    update({ stage: "copying", progress: 50 });
    return { bytes: 42 };
  });
  const completed = await waitFor(manager, started.id, "completed");
  assert.equal(completed.progress, 100);
  assert.deepEqual(completed.result, { bytes: 42 });
});

test("background task can be cancelled", async () => {
  const manager = new TaskManager();
  const started = manager.start("copy", "server", ({ signal }) => {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    );
  });
  manager.cancel(started.id);
  const cancelled = await waitFor(manager, started.id, "cancelled");
  assert.equal(cancelled.stage, "cancelled");
});
