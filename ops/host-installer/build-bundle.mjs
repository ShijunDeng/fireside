#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, lstatSync, chmodSync, openSync, fsyncSync, closeSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output') {
  console.error('usage: build-bundle.mjs --output <new-directory>');
  process.exit(2);
}
const output = path.resolve(args[1]);
const parent = path.dirname(output);
const basename = path.basename(output);
if (!basename || basename === '.' || basename === '..') throw new Error('invalid bundle output');
try {
  statSync(output);
  throw new Error('bundle output already exists');
} catch (error) {
  if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) throw error;
}

const definition = JSON.parse(readFileSync(path.join(here, 'asset-list.json'), 'utf8'));
if (definition.version !== 1 || !Array.isArray(definition.assets)) throw new Error('invalid asset list');
const internal = [
  ['production-installer.mjs', 'production-installer.mjs', '0444'],
  ['installer-core.mjs', 'installer-core.mjs', '0444'],
  ['asset-list.json', 'asset-list.json', '0444'],
  ['HOST_INSTALLER_PRODUCTION_MODE', 'HOST_INSTALLER_PRODUCTION_MODE', '0444'],
  ['dispatcher.sh', 'dispatcher.sh', '0555'],
];
const sensitivePath = /(^|\/)(?:[^/]*\.env(?:\.[^/]*)?|[^/]*(?:priv(?:ate)?key|secret|token|certificate)[^/]*|[^/]+\.(?:key|pem|crt|cer|csr|p12|pfx))$/i;
const forbiddenContent = /-----BEGIN (?:[A-Z ]*PRIVATE KEY|CERTIFICATE|CERTIFICATE REQUEST)-----|github_pat_[A-Za-z0-9_]+/;
const seenBundle = new Set();
const seenDestination = new Set();

for (const asset of definition.assets) {
  if (!['base', 'https-layout'].includes(asset.profile)
    || typeof asset.source !== 'string' || typeof asset.bundle !== 'string'
    || typeof asset.destination !== 'string' || !asset.destination.startsWith('/')
    || !/^0[4567][0-7][0-7]$/.test(asset.mode)) throw new Error('invalid asset declaration');
  if (asset.source.startsWith('/') || asset.source.includes('..') || asset.bundle.startsWith('/') || asset.bundle.includes('..')) {
    throw new Error('asset path escapes its root');
  }
  if (sensitivePath.test(asset.source) || sensitivePath.test(asset.bundle)) throw new Error(`sensitive asset path rejected: ${asset.source}`);
  if (seenBundle.has(asset.bundle) || seenDestination.has(asset.destination)) throw new Error('duplicate bundle path or destination');
  seenBundle.add(asset.bundle);
  seenDestination.add(asset.destination);
}

const stage = mkdtempSync(path.join(parent, `.${basename}.stage.`));
const manifestFiles = [];
function addFile(source, relative, mode) {
  const sourceStat = lstatSync(source, { throwIfNoEntry: false });
  if (!sourceStat?.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1) throw new Error(`asset is not a regular single-link file: ${source}`);
  const data = readFileSync(source);
  if (forbiddenContent.test(data.toString('utf8'))) throw new Error(`sensitive material rejected: ${source}`);
  const target = path.join(stage, relative);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
  copyFileSync(source, target);
  chmodSync(target, Number.parseInt(mode, 8));
  manifestFiles.push({ path: relative, mode, size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
}

try {
  for (const [source, relative, mode] of internal) addFile(path.join(here, source), relative, mode);
  for (const asset of definition.assets) addFile(path.join(projectRoot, asset.source), asset.bundle, '0444');
  manifestFiles.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = `${JSON.stringify({ version: 1, files: manifestFiles }, null, 2)}\n`;
  const manifestPath = path.join(stage, 'bundle-manifest.json');
  writeFileSync(manifestPath, manifest, { mode: 0o444 });
  chmodSync(stage, 0o755);
  for (const file of [...manifestFiles.map((entry) => entry.path), 'bundle-manifest.json']) {
    const fd = openSync(path.join(stage, file), 'r');
    fsyncSync(fd);
    closeSync(fd);
  }
  const stageFd = openSync(stage, 'r');
  fsyncSync(stageFd);
  closeSync(stageFd);
  renameSync(stage, output);
  const parentFd = openSync(parent, 'r');
  fsyncSync(parentFd);
  closeSync(parentFd);
  console.log(JSON.stringify({ ok: true, output, files: manifestFiles.length + 1 }));
} catch (error) {
  rmSync(stage, { recursive: true, force: true });
  throw error;
}
