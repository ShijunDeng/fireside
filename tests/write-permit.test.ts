import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { readReleaseCommit, releaseWritePermitMatches } from '../server/write-permit.js';

const directories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fireside-write-permit-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('发布业务写许可', () => {
  it('只接受与当前 release commit 匹配的指定所有者 0444 普通单链接文件', async () => {
    const directory = await temporaryDirectory();
    const commit = 'a'.repeat(40);
    const marker = path.join(directory, 'writes-enabled');
    await writeFile(marker, `${commit}\n`, { mode: 0o444 });
    assert.equal(releaseWritePermitMatches(marker, commit, process.getuid?.() ?? 0), true);
    assert.equal(releaseWritePermitMatches(marker, 'b'.repeat(40), process.getuid?.() ?? 0), false);

    await chmod(marker, 0o644);
    assert.equal(releaseWritePermitMatches(marker, commit, process.getuid?.() ?? 0), false);
    await chmod(marker, 0o444);
    const hardlink = path.join(directory, 'hardlink');
    await link(marker, hardlink);
    assert.equal(releaseWritePermitMatches(marker, commit, process.getuid?.() ?? 0), false);
    await rm(hardlink);
    const symbolic = path.join(directory, 'symbolic');
    await symlink(marker, symbolic);
    assert.equal(releaseWritePermitMatches(symbolic, commit, process.getuid?.() ?? 0), false);
  });

  it('release commit marker 必须是单链接普通文件且有唯一换行', async () => {
    const directory = await temporaryDirectory();
    const commit = 'c'.repeat(40);
    await writeFile(path.join(directory, 'RELEASE_COMMIT'), `${commit}\n`);
    assert.equal(readReleaseCommit(directory), commit);
    await mkdir(path.join(directory, 'invalid'));
    await assert.rejects(async () => readReleaseCommit(path.join(directory, 'invalid')));
  });
});
