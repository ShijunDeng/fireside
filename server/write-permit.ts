import { constants as fsConstants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';

const COMMIT = /^[0-9a-f]{40}$/;

export function readReleaseCommit(releaseRoot: string) {
  const filename = path.join(releaseRoot, 'RELEASE_COMMIT');
  const descriptor = openSync(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = fstatSync(descriptor);
    const value = readFileSync(descriptor, 'utf8');
    const commit = value.endsWith('\n') ? value.slice(0, -1) : '';
    if (!info.isFile() || info.nlink !== 1 || !COMMIT.test(commit)) {
      throw new Error('production release commit marker is invalid');
    }
    return commit;
  } finally {
    closeSync(descriptor);
  }
}

export function releaseWritePermitMatches(
  permitPath: string,
  expectedCommit: string,
  expectedOwnerUid = 0,
) {
  if (!path.isAbsolute(permitPath) || !COMMIT.test(expectedCommit)) return false;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(permitPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== expectedOwnerUid || (info.mode & 0o777) !== 0o444) {
      return false;
    }
    return readFileSync(descriptor, 'utf8') === `${expectedCommit}\n`;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
