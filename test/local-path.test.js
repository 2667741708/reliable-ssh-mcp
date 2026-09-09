import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  commitDownloadedFile,
  commitDownloadedDirectory,
  inspectLocalRoots,
  prepareDownloadDirectory,
  prepareDownloadPath,
  resolveUploadPath,
  selectLocalRoot,
} from "../src/local-path.js";

test("local transfer paths must be relative and stay inside a named root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reliable-ssh-root-"));
  try {
    const source = path.join(root, "source.txt");
    await writeFile(source, "content", "utf8");
    const selected = selectLocalRoot({ project: root });
    assert.equal(selected.name, "project");

    const upload = await resolveUploadPath(selected.path, "source.txt");
    assert.equal(upload.path, source);
    assert.equal(upload.size, 7);

    await assert.rejects(
      resolveUploadPath(root, source),
      /Absolute local paths are not allowed/u,
    );
    await assert.rejects(
      resolveUploadPath(root, path.join("..", "outside.txt")),
      /outside/u,
    );
    assert.throws(
      () => selectLocalRoot({ project: root }, "shared"),
      /Unknown local root shared/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file downloads are staged, atomically published, and never overwrite", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reliable-ssh-root-"));
  try {
    const prepared = await prepareDownloadPath(
      root,
      path.join("nested", "download.txt"),
      true,
    );
    await writeFile(prepared.temporary, "downloaded", "utf8");
    const committed = await commitDownloadedFile(
      prepared.temporary,
      prepared.destination,
    );
    assert.equal(committed.path, path.join(root, "nested", "download.txt"));
    assert.equal(await readFile(committed.path, "utf8"), "downloaded");

    await assert.rejects(
      prepareDownloadPath(root, path.join("nested", "download.txt"), false),
      /do not overwrite/u,
    );
    assert.equal(await readFile(committed.path, "utf8"), "downloaded");
    await assert.rejects(
      prepareDownloadPath(root, path.resolve(root, "absolute.txt"), false),
      /Absolute local paths are not allowed/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("list_local_roots data reports unavailable roots without hiding others", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reliable-ssh-root-"));
  try {
    const roots = await inspectLocalRoots({
      project: root,
      shared: path.join(root, "missing"),
    });
    assert.equal(roots[0].available, true);
    assert.equal(roots[1].available, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("directory downloads publish a completed staging directory without overwrite", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reliable-ssh-root-"));
  try {
    const prepared = await prepareDownloadDirectory(
      root,
      path.join("downloads", "snapshot"),
      true,
    );
    await mkdir(path.join(prepared.staging, "payload"));
    await writeFile(
      path.join(prepared.staging, "payload", "result.txt"),
      "complete",
      "utf8",
    );
    await commitDownloadedDirectory(prepared.staging, prepared.destination);
    assert.equal(
      await readFile(
        path.join(prepared.destination, "payload", "result.txt"),
        "utf8",
      ),
      "complete",
    );
    await assert.rejects(
      prepareDownloadDirectory(
        root,
        path.join("downloads", "snapshot"),
        false,
      ),
      /do not overwrite/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
