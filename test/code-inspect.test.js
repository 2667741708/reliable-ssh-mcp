import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectLines, inspectSearch, readInspectionQuery } from "../src/code-inspect.js";

test("numbered inspection handles mixed line endings without shell parsing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reliable-inspect-"));
  try {
    await writeFile(path.join(root, "sample.js"), "one\r\ntwo\nthree\r\n", "utf8");
    const result = await inspectLines(root, { file: "sample.js", start: 2, end: 3 });
    assert.equal(result.text, "2: two\n3: three");
    assert.equal(result.total_lines, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("query-file search keeps regex metacharacters out of the command line", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reliable-inspect-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "a.js"), "alpha | beta\ntransportError('closed')\n", "utf8");
    await writeFile(path.join(root, "query.json"), JSON.stringify({
      mode: "regex", patterns: ["alpha \\| beta", "transportError\\("], paths: ["src"], extensions: ["js"],
    }), "utf8");
    const query = await readInspectionQuery(root, "query.json");
    const result = await inspectSearch(root, query);
    assert.equal(result.files_scanned, 1);
    assert.deepEqual(result.matches.map((item) => item.line), [1, 2]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("literal search treats regex syntax as ordinary text", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reliable-inspect-"));
  try {
    await writeFile(path.join(root, "sample.txt"), "value.*here\nVALUE other\n", "utf8");
    const result = await inspectSearch(root, {
      mode: "literal", patterns: ["value.*"], paths: ["sample.txt"], case_sensitive: false,
    });
    assert.equal(result.match_count, 1);
    assert.equal(result.matches[0].line, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("inspection rejects absolute and escaping paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reliable-inspect-"));
  try {
    await assert.rejects(inspectLines(root, { file: path.resolve(root, "x") }), /project-relative/);
    await assert.rejects(inspectLines(root, { file: "../x" }), /escapes/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
