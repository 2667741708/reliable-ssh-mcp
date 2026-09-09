const NAME = /^[A-Za-z0-9_-]+$/u;
const ROUTE_FIELDS = new Set([
  "sshTarget", "sshFlavor", "sshCommand", "scpCommand", "remotePython",
  "passwordFile", "hostKey", "proxyJump", "proxyCommand", "identityFile",
  "knownHostsFile", "hostKeyAlias", "expectedIp", "expectedRouteHost",
  "poolSize", "connectTimeoutSec", "commandTimeoutSec", "transferTimeoutSec",
  "maxOutputBytes", "keepaliveIntervalSec", "heartbeatIntervalSec", "auditLog",
]);
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(label + " must be an object");
  return value;
}
function name(value, label) {
  if (typeof value !== "string" || !NAME.test(value))
    throw new Error("Invalid " + label + ": " + value);
}
export function compileRegistry(raw, validate) {
  object(raw.servers, "servers");
  const servers = Object.create(null);
  const hosts = Object.create(null);
  const connections = Object.create(null);
  const aliases = Object.create(null);
  if (![1, 2].includes(raw.version)) throw new Error("Fleet configuration version must be 1 or 2");
  for (const [hostName, entry] of Object.entries(raw.servers)) {
    name(hostName, "server name");
    object(entry, "Server " + hostName);
    if (raw.version === 1) {
      servers[hostName] = validate(hostName, entry);
      continue;
    }
    const { routes, defaultRoute, ...shared } = entry;
    object(routes, "Routes for " + hostName);
    for (const field of ROUTE_FIELDS) {
      if (Object.hasOwn(shared, field))
        throw new Error(hostName + "." + field + " belongs inside a route");
    }
    if (!Object.hasOwn(routes, defaultRoute))
      throw new Error("Unknown defaultRoute for " + hostName);
    const host = { name: hostName, defaultRoute, routes: Object.create(null) };
    for (const [routeName, route] of Object.entries(routes)) {
      name(routeName, "route name");
      object(route, "Route " + hostName + "/" + routeName);
      for (const field of Object.keys(route)) {
        if (field !== "aliases" && !ROUTE_FIELDS.has(field))
          throw new Error("Route cannot override shared server field: " + field);
      }
      const { aliases: routeAliases = [], ...transport } = route;
      if (!Array.isArray(routeAliases)) throw new Error("Route aliases must be an array");
      const id = hostName + "@" + routeName;
      const selected = validate(id, { ...shared, ...transport });
      Object.assign(selected, { hostName, routeName });
      host.routes[routeName] = selected;
      connections[id] = selected;
      for (const alias of routeAliases) {
        name(alias, "alias");
        if (Object.hasOwn(raw.servers, alias) || Object.hasOwn(aliases, alias))
          throw new Error("Conflicting server alias: " + alias);
        aliases[alias] = { server: hostName, route: routeName };
      }
    }
    hosts[hostName] = host;
    servers[hostName] = host.routes[defaultRoute];
  }
  if (!Object.keys(servers).length) throw new Error("Fleet configuration requires at least one server");
  function resolveServer(requested, requestedRoute) {
    if (Object.hasOwn(connections, requested)) {
      const selected = connections[requested];
      if (requestedRoute !== undefined && requestedRoute !== selected.routeName)
        throw new Error("Connection ID conflicts with requested route");
      return selected;
    }
    const alias = aliases[requested];
    if (alias && requestedRoute !== undefined && requestedRoute !== alias.route)
      throw new Error("Legacy alias conflicts with requested route");
    const hostName = alias?.server ?? requested;
    const host = hosts[hostName];
    if (host) {
      const route = requestedRoute ?? alias?.route ?? host.defaultRoute;
      if (!Object.hasOwn(host.routes, route)) throw new Error("Unknown route " + route + " for " + hostName);
      return host.routes[route];
    }
    if (Object.hasOwn(servers, hostName)) {
      if (requestedRoute !== undefined) throw new Error("Server has no named routes: " + hostName);
      return servers[hostName];
    }
    throw new Error("Unknown server " + requested + ". Use list_servers first.");
  }
  return { servers, hosts, connections, aliases, resolveServer };
}
export function resolveFleetServer(fleet, server, route) {
  if (fleet.resolveServer) return fleet.resolveServer(server, route);
  if (route !== undefined) throw new Error("This server has no named routes");
  if (!Object.hasOwn(fleet.servers, server)) throw new Error("Unknown server " + server + ". Use list_servers first.");
  return fleet.servers[server];
}
export function routeCapabilities(selected) {
  const openssh = selected.sshFlavor !== "plink";
  return {
    command_and_file_io: true,
    session_password: !openssh,
    upload_download: openssh,
    tunnels: openssh,
    note: openssh ? undefined : "Plink supports command/file tools. Upload/download and tunnel adapters require an OpenSSH route in this version.",
  };
}
export function publicConnection(selected) {
  return {
    connection_id: selected.name,
    route: selected.routeName,
    ssh_target: selected.sshTarget,
    ssh_flavor: selected.sshFlavor ?? "openssh",
    proxy_jump: selected.proxyJump,
    proxy_command_configured: Boolean(selected.proxyCommand),
    expected_ip: selected.expectedIp,
    expected_route_host: selected.expectedRouteHost,
    capabilities: routeCapabilities(selected),
  };
}
export function registryRows(fleet, fixed) {
  const entries = fixed ? [fixed] : Object.values(fleet.servers);
  return entries.map((item) => {
    const hostName = item.hostName ?? item.name;
    const host = fleet.hosts?.[hostName];
    return {
      name: hostName,
      ...publicConnection(item),
      default_route: fixed ? item.routeName : host?.defaultRoute,
      routes: (fixed ? [item] : Object.values(host?.routes ?? { default: item })).map(publicConnection),
      aliases: Object.entries(fleet.aliases ?? {}).filter(([, target]) =>
        target.server === hostName && (!fixed || target.route === fixed.routeName)
      ).map(([alias, target]) => ({ name: alias, route: target.route })),
      server_info: item.serverInfo ?? null,
      mode: item.mode,
      tool_groups: item.toolGroups,
      pool_size: item.poolSize,
      expected_hostname: item.expectedHostname,
      expected_gpu: item.expectedGpu,
    };
  });
}
const PLINK_UNSUPPORTED = new Set([
  "upload_file", "download_file", "upload_directory", "download_directory",
  "start_local_forward", "start_socks_proxy", "start_named_forward", "restart_tunnel",
]);
export function assertTransportSupported(selected, tool) {
  if (selected.sshFlavor === "plink" && PLINK_UNSUPPORTED.has(tool))
    throw new Error(tool + " is not adapted to Plink. Select an explicitly configured OpenSSH route; no operation was sent.");
}
