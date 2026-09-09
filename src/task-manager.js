import { randomUUID } from "node:crypto";

export class TaskManager {
  constructor() {
    this.tasks = new Map();
  }

  start(type, server, work) {
    const id = randomUUID();
    const controller = new AbortController();
    const task = {
      id,
      type,
      server,
      status: "running",
      stage: "starting",
      progress: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      controller,
    };
    this.tasks.set(id, task);
    const update = (patch) => {
      Object.assign(task, patch, { updated_at: new Date().toISOString() });
    };
    Promise.resolve()
      .then(() => {
        if (controller.signal.aborted)
          throw controller.signal.reason ?? new Error("Task cancelled");
        return work({ signal: controller.signal, update });
      })
      .then((result) =>
        update({
          status: "completed",
          stage: "completed",
          progress: 100,
          result,
        }),
      )
      .catch((error) => {
        const cancelled = controller.signal.aborted;
        update({
          status: cancelled ? "cancelled" : "failed",
          stage: cancelled ? "cancelled" : "failed",
          error: String(error.message ?? error).slice(0, 1000),
        });
      });
    return this.public(task);
  }

  public(task) {
    const { controller: _controller, ...visible } = task;
    return structuredClone(visible);
  }

  get(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Unknown task ${id}`);
    return this.public(task);
  }

  list(server) {
    return [...this.tasks.values()]
      .filter((task) => !server || task.server === server)
      .map((task) => this.public(task));
  }

  cancel(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Unknown task ${id}`);
    if (task.status === "running")
      task.controller.abort(new Error("Cancelled by MCP caller"));
    return this.public(task);
  }
}
