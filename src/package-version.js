import { readFileSync } from "node:fs";

const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

export const PACKAGE_VERSION = packageMetadata.version;
