import { createHash } from 'node:crypto';
import {
  chmodSync, chownSync, closeSync, copyFileSync, cpSync, existsSync, fsyncSync,
  lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const modeText = (mode) => (mode & 0o7777).toString(8).padStart(4, '0');
const expectedMarker = 'fireside-host-installer-production-v1\n';

function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && !path.isAbsolute(value)
    && !value.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function walk(root, relative = '') {
  const result = [];
  for (const name of readdirSync(path.join(root, relative))) {
    const child = path.posix.join(relative, name);
    const target = path.join(root, child);
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`bundle contains a symbolic link: ${child}`);
    if (stat.isDirectory()) result.push(...walk(root, child));
    else if (stat.isFile() && stat.nlink === 1) result.push(child);
    else throw new Error(`bundle contains an unsupported object: ${child}`);
  }
  return result;
}

export function verifyBundle(bundleRoot, { production = false } = {}) {
  const rootStat = lstatSync(bundleRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('bundle root must be a real directory');
  if ((rootStat.mode & 0o022) !== 0) throw new Error('bundle root is writable by another identity');
  if (production && (rootStat.uid !== 0 || rootStat.gid !== 0 || modeText(rootStat.mode) !== '0755')) {
    throw new Error('production bundle root metadata is invalid');
  }
  const manifestPath = path.join(bundleRoot, 'bundle-manifest.json');
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.nlink !== 1
    || modeText(manifestStat.mode) !== '0444' || (production && (manifestStat.uid !== 0 || manifestStat.gid !== 0))) {
    throw new Error('bundle manifest metadata is invalid');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('bundle manifest format is invalid');
  const expected = new Set(['bundle-manifest.json']);
  for (const entry of manifest.files) {
    if (!safeRelative(entry.path) || !/^0[4567][0-7][0-7]$/.test(entry.mode)
      || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0
      || expected.has(entry.path)) throw new Error('bundle manifest entry is invalid');
    expected.add(entry.path);
    const filename = path.join(bundleRoot, entry.path);
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== entry.size
      || modeText(stat.mode) !== entry.mode || (production && (stat.uid !== 0 || stat.gid !== 0))) {
      throw new Error(`bundle file metadata is invalid: ${entry.path}`);
    }
    if (sha256(readFileSync(filename)) !== entry.sha256) throw new Error(`bundle file digest is invalid: ${entry.path}`);
  }
  const actual = walk(bundleRoot).sort();
  const declared = [...expected].sort();
  if (actual.length !== declared.length || actual.some((item, index) => item !== declared[index])) {
    throw new Error('bundle contains an undeclared or missing file');
  }
  if (readFileSync(path.join(bundleRoot, 'HOST_INSTALLER_PRODUCTION_MODE'), 'utf8') !== expectedMarker) {
    throw new Error('production marker is invalid');
  }
  const definition = JSON.parse(readFileSync(path.join(bundleRoot, 'asset-list.json'), 'utf8'));
  if (definition.version !== 1 || !Array.isArray(definition.assets)) throw new Error('installed asset list is invalid');
  for (const asset of definition.assets) {
    if (!['base', 'https-layout'].includes(asset.profile) || !safeRelative(asset.bundle)
      || typeof asset.destination !== 'string' || !asset.destination.startsWith('/') || asset.destination.includes('..')
      || !/^0[4567][0-7][0-7]$/.test(asset.mode)) throw new Error('installed asset declaration is invalid');
    if (!expected.has(asset.bundle)) throw new Error(`installed asset is not manifested: ${asset.bundle}`);
  }
  return { manifest, definition };
}

const baseDirectories = [
  ['/opt/fireside', 'root', 'root', '0755'],
  ['/opt/fireside/releases', 'root', 'root', '0755'],
  ['/var/lib/fireside', 'fireside', 'fireside', '0700'],
  ['/var/lib/fireside-release', 'root', 'root', '0700'],
  ['/var/backups/fireside', 'root', 'root', '0700'],
  ['/etc/fireside-release', 'root', 'root', '0700'],
  ['/usr/local/libexec/fireside-release', 'root', 'root', '0755'],
  ['/var/lib/fireside-host-installer', 'root', 'root', '0700'],
];
const httpsDirectories = [
  ['/etc/fireside-nginx', 'root', 'root', '0755'],
  ['/etc/fireside-tls', 'root', 'root', '0700'],
  ['/var/lib/fireside-https', 'www-data', 'www-data', '0700'],
  ['/usr/local/libexec/fireside-tls-installer', 'root', 'root', '0755'],
];
const baseAccounts = [
  { name: 'fireside', group: 'fireside', home: '/nonexistent', shell: '/usr/sbin/nologin', create: true },
  { name: 'fireside-build', group: 'fireside-build', home: '/nonexistent', shell: '/usr/sbin/nologin', create: true },
];

export function desiredProfile(definition, profile) {
  if (!['base', 'https-layout'].includes(profile)) throw new Error('profile must be base or https-layout');
  return {
    accounts: profile === 'base' ? baseAccounts : [{ name: 'www-data', create: false }],
    directories: (profile === 'base' ? baseDirectories : httpsDirectories)
      .map(([destination, owner, group, mode]) => ({ destination, owner, group, mode })),
    files: definition.assets.filter((asset) => asset.profile === profile),
  };
}

export function planProfile(adapter, bundleRoot, definition, profile) {
  const desired = desiredProfile(definition, profile);
  const actions = [];
  for (const account of desired.accounts) {
    const current = adapter.inspectAccount(account.name);
    if (!current) {
      if (!account.create) throw new Error(`required host account is missing: ${account.name}`);
      actions.push({ type: 'create-account', account });
    } else if (account.create && (current.system !== true || current.group !== account.group
      || current.home !== account.home || current.shell !== account.shell || current.supplementaryGroups.length !== 0)) {
      throw new Error(`existing host account is incompatible: ${account.name}`);
    }
  }
  for (const directory of desired.directories) {
    const current = adapter.inspectPath(directory.destination);
    if (!current) actions.push({ type: 'create-directory', directory });
    else if (current.type !== 'directory' || current.owner !== directory.owner || current.group !== directory.group || current.mode !== directory.mode) {
      throw new Error(`existing directory metadata is incompatible: ${directory.destination}`);
    }
  }
  let unitsChanged = false;
  for (const asset of desired.files) {
    const source = path.join(bundleRoot, asset.bundle);
    const current = adapter.inspectPath(asset.destination);
    const digest = sha256(readFileSync(source));
    if (!current) {
      actions.push({ type: 'install-file', asset, source, digest });
      unitsChanged ||= Boolean(asset.unit);
    } else {
      if (current.type !== 'file' || current.links !== 1 || current.owner !== 'root' || current.group !== 'root' || current.mode !== asset.mode) {
        throw new Error(`existing managed file metadata is incompatible: ${asset.destination}`);
      }
      if (current.digest !== digest) {
        actions.push({ type: 'replace-file', asset, source, digest });
        unitsChanged ||= Boolean(asset.unit);
      }
    }
  }
  if (unitsChanged) actions.push({ type: 'daemon-reload' });
  return actions;
}

export function applyProfile(adapter, bundleRoot, definition, profile, { failAfter = 0 } = {}) {
  const actions = planProfile(adapter, bundleRoot, definition, profile);
  adapter.begin();
  try {
    actions.forEach((action, index) => {
      if (failAfter > 0 && index + 1 === failAfter) throw new Error(`injected fixture failure at action ${failAfter}`);
      if (action.type === 'create-account') adapter.createAccount(action.account);
      else if (action.type === 'create-directory') adapter.createDirectory(action.directory);
      else if (action.type === 'install-file' || action.type === 'replace-file') adapter.installFile(action.asset, action.source);
      else if (action.type === 'daemon-reload') adapter.daemonReload();
    });
    adapter.commit();
    return actions;
  } catch (error) {
    adapter.rollback();
    throw error;
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' }, ...options });
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed`);
  return result.stdout.trim();
}

export function validateProfileAssets(bundleRoot, definition, profile) {
  const assets = definition.assets.filter((asset) => asset.profile === profile);
  for (const asset of assets) {
    const source = path.join(bundleRoot, asset.bundle);
    if (/\.(?:sh)$/.test(asset.destination) || asset.destination.endsWith('/fireside-release')) run('/bin/bash', ['-n', source]);
    if (/\.(?:mjs|js)$/.test(asset.destination)) run('/usr/bin/node', ['--check', source]);
  }
  const units = assets.filter((asset) => asset.unit).map((asset) => path.join(bundleRoot, asset.bundle));
  if (units.length) run('/usr/bin/systemd-analyze', ['verify', ...units]);
}

function ensureParent(target) {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
}

export class FixtureAdapter {
  constructor(root) {
    this.root = path.resolve(root);
    mkdirSync(this.root, { recursive: true });
    this.statePath = path.join(this.root, '.fireside-host-fixture-state.json');
    this.state = existsSync(this.statePath)
      ? JSON.parse(readFileSync(this.statePath, 'utf8'))
      : { accounts: { root: { system: true, group: 'root', home: '/root', shell: '/bin/sh', supplementaryGroups: [] }, 'www-data': { system: true, group: 'www-data', home: '/nonexistent', shell: '/usr/sbin/nologin', supplementaryGroups: [] } }, metadata: {}, daemonReloads: 0 };
    this.snapshot = null;
  }

  target(destination) { return path.join(this.root, destination.slice(1)); }
  save() { writeFileSync(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 }); }
  inspectAccount(name) { return this.state.accounts[name] ?? null; }
  inspectPath(destination) {
    const target = this.target(destination);
    if (!existsSync(target) && !lstatExists(target)) return null;
    const stat = lstatSync(target);
    const metadata = this.state.metadata[destination] ?? { owner: 'root', group: 'root' };
    return {
      type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'special',
      owner: metadata.owner, group: metadata.group, mode: modeText(stat.mode), links: stat.nlink,
      ...(stat.isFile() ? { digest: sha256(readFileSync(target)) } : {}),
    };
  }
  createAccount(account) {
    this.state.accounts[account.name] = { system: true, group: account.group, home: account.home, shell: account.shell, supplementaryGroups: [] };
    this.save();
  }
  createDirectory(directory) {
    const target = this.target(directory.destination);
    ensureParent(target);
    mkdirSync(target, { mode: Number.parseInt(directory.mode, 8) });
    chmodSync(target, Number.parseInt(directory.mode, 8));
    this.state.metadata[directory.destination] = { owner: directory.owner, group: directory.group };
    this.save();
  }
  installFile(asset, source) {
    const target = this.target(asset.destination);
    ensureParent(target);
    const temporary = `${target}.host-install-${process.pid}`;
    copyFileSync(source, temporary);
    chmodSync(temporary, Number.parseInt(asset.mode, 8));
    renameSync(temporary, target);
    this.state.metadata[asset.destination] = { owner: 'root', group: 'root' };
    this.save();
  }
  daemonReload() { this.state.daemonReloads += 1; this.save(); }
  begin() {
    this.save();
    this.snapshot = mkdtempSync(path.join(os.tmpdir(), 'fireside-host-fixture-snapshot-'));
    cpSync(this.root, path.join(this.snapshot, 'root'), { recursive: true, dereference: false });
  }
  commit() { rmSync(this.snapshot, { recursive: true, force: true }); this.snapshot = null; }
  rollback() {
    rmSync(this.root, { recursive: true, force: true });
    cpSync(path.join(this.snapshot, 'root'), this.root, { recursive: true, dereference: false });
    rmSync(this.snapshot, { recursive: true, force: true });
    this.snapshot = null;
    this.state = JSON.parse(readFileSync(this.statePath, 'utf8'));
  }
}

function lstatExists(target) {
  try { lstatSync(target); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

export class ProductionAdapter {
  constructor() { this.undo = []; }
  inspectAccount(name) {
    const passwd = spawnSync('/usr/bin/getent', ['passwd', name], { encoding: 'utf8' });
    if (passwd.status === 2) return null;
    if (passwd.status !== 0) throw new Error(`cannot inspect account: ${name}`);
    const fields = passwd.stdout.trim().split(':');
    const primaryGroup = run('/usr/bin/id', ['-gn', name]);
    const allGroups = run('/usr/bin/id', ['-Gn', name]).split(/\s+/).filter(Boolean);
    return { system: Number(fields[2]) < 1000 && Number(fields[2]) !== 0, group: primaryGroup, home: fields[5], shell: fields[6], supplementaryGroups: allGroups.filter((group) => group !== primaryGroup) };
  }
  identityId(name, group = false) {
    if (name === 'root') return 0;
    return Number(run(group ? '/usr/bin/getent' : '/usr/bin/id', group ? ['group', name] : ['-u', name]).split(':')[2] ?? run('/usr/bin/id', ['-u', name]));
  }
  inspectPath(destination) {
    if (!lstatExists(destination)) return null;
    const stat = lstatSync(destination);
    const owner = stat.uid === 0 ? 'root' : run('/usr/bin/id', ['-nu', String(stat.uid)]);
    const group = stat.gid === 0 ? 'root' : run('/usr/bin/getent', ['group', String(stat.gid)]).split(':')[0];
    return { type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'special', owner, group, mode: modeText(stat.mode), links: stat.nlink, ...(stat.isFile() ? { digest: sha256(readFileSync(destination)) } : {}) };
  }
  createAccount(account) {
    if (spawnSync('/usr/bin/getent', ['group', account.group]).status !== 0) run('/usr/sbin/groupadd', ['--system', account.group]);
    run('/usr/sbin/useradd', ['--system', '--gid', account.group, '--home-dir', account.home, '--no-create-home', '--shell', account.shell, account.name]);
  }
  createDirectory(directory) {
    mkdirSync(directory.destination, { mode: Number.parseInt(directory.mode, 8) });
    const uid = directory.owner === 'root' ? 0 : Number(run('/usr/bin/id', ['-u', directory.owner]));
    const gid = directory.group === 'root' ? 0 : Number(run('/usr/bin/getent', ['group', directory.group]).split(':')[2]);
    chownSync(directory.destination, uid, gid);
    chmodSync(directory.destination, Number.parseInt(directory.mode, 8));
  }
  installFile(asset, source) {
    ensureParent(asset.destination);
    const existed = lstatExists(asset.destination);
    const old = existed ? { data: readFileSync(asset.destination), mode: statSync(asset.destination).mode & 0o7777 } : null;
    this.undo.push(() => {
      if (!old) { if (lstatExists(asset.destination)) unlinkSync(asset.destination); return; }
      writeAtomic(asset.destination, old.data, old.mode);
    });
    writeAtomic(asset.destination, readFileSync(source), Number.parseInt(asset.mode, 8));
  }
  daemonReload() { run('/usr/bin/systemctl', ['daemon-reload']); }
  begin() { this.undo = []; }
  commit() { this.undo = []; }
  rollback() { for (const undo of this.undo.reverse()) undo(); this.undo = []; }
}

function writeAtomic(destination, data, mode) {
  const temporary = `${destination}.host-install-${process.pid}`;
  const fd = openSync(temporary, 'wx', mode);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  chownSync(temporary, 0, 0);
  chmodSync(temporary, mode);
  renameSync(temporary, destination);
  const directoryFd = openSync(path.dirname(destination), 'r');
  fsyncSync(directoryFd);
  closeSync(directoryFd);
}
