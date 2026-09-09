#!/usr/bin/env node

import { parseConfig, usage } from "./config.js";
import { loadFleetConfig } from "./fleet-config.js";
import { serveFleet } from "./fleet-server.js";
import { serve } from "./server.js";

try {
  const config = parseConfig(process.argv.slice(2));
  if (config.fleetConfig)
    await serveFleet(
      await loadFleetConfig(config.fleetConfig, {
        clientRootsMode: config.clientRootsMode,
        ...(Object.keys(config.localRoots).length > 0
          ? { localRoots: config.localRoots }
          : {}),
      }),
      { server: config.selectedServer, route: config.selectedRoute },
    );
  else await serve(config);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage());
  process.exitCode = 1;
}
