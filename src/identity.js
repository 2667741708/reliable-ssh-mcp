export function identityCacheValid(entry, client, ttlMs = 300000) {
  if (!entry || Date.now() - entry.verifiedAt >= ttlMs) return false;
  return typeof client.isFresh !== "function" ||
    (entry.generation === client.generation && client.isFresh());
}

export function identityCacheEntry(identity, client) {
  return { identity, verifiedAt: Date.now(), generation: client.generation };
}

export function verifyIdentity(identity, expected) {
  const problems = [];

  if (
    expected.expectedHostname &&
    identity.hostname !== expected.expectedHostname
  ) {
    problems.push(
      `hostname is ${JSON.stringify(identity.hostname)}, expected ${JSON.stringify(expected.expectedHostname)}`,
    );
  }

  if (
    expected.expectedIp &&
    !identity.ip_addresses.includes(expected.expectedIp)
  ) {
    problems.push(
      `IP ${expected.expectedIp} is absent from ${identity.ip_addresses.join(", ") || "the remote address list"}`,
    );
  }

  if (expected.expectedGpu) {
    const needle = expected.expectedGpu.toLocaleLowerCase("en-US");
    const matches = identity.gpus.some((gpu) =>
      gpu.name.toLocaleLowerCase("en-US").includes(needle),
    );
    if (!matches) {
      problems.push(
        `no GPU name contains ${JSON.stringify(expected.expectedGpu)}`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Remote identity verification failed: ${problems.join("; ")}`,
    );
  }

  return identity;
}
