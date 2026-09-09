import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const text = z.string().trim().min(1);
const capacity = z.number().finite().positive();
const serverInfoSchema = z.object({
  description: text.optional(),
  cpu: text.optional(),
  memoryGb: capacity.optional(),
  storageTb: capacity.optional(),
  gpus: z.array(z.object({
    model: text,
    count: z.number().int().positive(),
    memoryGbPerGpu: capacity.optional(),
  }).strict()).optional(),
  os: text.optional(),
  notes: text.optional(),
  usageGuidance: text.optional(),
  source: text.optional(),
  verifiedAt: z.string().datetime({ offset: true }).optional(),
}).strict();

// Inventory is descriptive data only; it never controls identity or policy.
export function loadServerInfo(config, baseDirectory = process.cwd()) {
  if (config.serverInfo !== undefined && config.serverInfoFile !== undefined) {
    throw new Error("Use either serverInfo or serverInfoFile, not both");
  }
  let raw = config.serverInfo;
  if (config.serverInfoFile !== undefined) {
    const file = text.parse(config.serverInfoFile);
    raw = JSON.parse(readFileSync(path.resolve(baseDirectory, file), "utf8").replace(/^\uFEFF/u, ""));
  }
  return raw === undefined ? undefined : serverInfoSchema.parse(raw);
}

export function publicServerInfo(config) {
  return {
    name: config.hostName ?? config.name,
    route: config.routeName,
    connection_id: config.name,
    ssh_target: config.sshTarget,
    server_info: config.serverInfo ?? null,
    information_kind: "configured_inventory_not_live_status",
    expected_hostname: config.expectedHostname,
    expected_ip: config.expectedIp,
    expected_gpu: config.expectedGpu,
  };
}
