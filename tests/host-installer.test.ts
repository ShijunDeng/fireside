import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builder = path.join(projectRoot, 'ops/host-installer/build-bundle.mjs');
const fixtureInstaller = path.join(projectRoot, 'ops/host-installer/fixture-installer.mjs');
const productionInstaller = path.join(projectRoot, 'ops/host-installer/production-installer.mjs');

type Result = ReturnType<typeof spawnSync>;

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Result {
  return spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    env: env ?? process.env,
  });
}

function output(result: Result): string {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function expectSuccess(result: Result): void {
  assert.equal(result.status, 0, output(result));
}

function makeWorkspace(): { workspace: string; bundle: string; fixture: string } {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'fireside-host-installer-test-'));
  const bundle = path.join(workspace, 'bundle');
  const fixture = path.join(workspace, 'fixture');
  expectSuccess(run(process.execPath, [builder, '--output', bundle]));
  return { workspace, bundle, fixture };
}

function invokeFixture(bundle: string, fixture: string, action: string, profile: string, extra: string[] = []): Result {
  return run(process.execPath, [fixtureInstaller, '--bundle', bundle, '--root', fixture, ...extra, action, profile]);
}

function walkFiles(root: string, relative = ''): string[] {
  return readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const child = path.posix.join(relative, entry.name);
    return entry.isDirectory() ? walkFiles(root, child) : [child];
  });
}

test('bundle is built from the explicit non-sensitive asset set and cannot overwrite output', (t) => {
  const { workspace, bundle } = makeWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const manifest = JSON.parse(readFileSync(path.join(bundle, 'bundle-manifest.json'), 'utf8')) as {
    version: number;
    files: Array<{ path: string; mode: string; size: number; sha256: string }>;
  };
  assert.equal(manifest.version, 1);
  const actual = walkFiles(bundle).sort();
  const declared = ['bundle-manifest.json', ...manifest.files.map((entry) => entry.path)].sort();
  assert.deepEqual(actual, declared);
  assert(!actual.includes('fixture-installer.mjs'), 'fixture path override CLI must remain source-only');

  const forbiddenPath = /(^|\/)(?:[^/]*\.env(?:\.[^/]*)?|[^/]*(?:private[_-]?key|secret|token|certificate)[^/]*|[^/]+\.(?:key|pem|crt|cer|csr|p12|pfx))$/i;
  const forbiddenBody = /-----BEGIN (?:[A-Z ]*PRIVATE KEY|CERTIFICATE|CERTIFICATE REQUEST)-----|github_pat_[A-Za-z0-9_]+/;
  for (const entry of manifest.files) {
    assert(!forbiddenPath.test(entry.path), `sensitive-looking bundle path: ${entry.path}`);
    const data = readFileSync(path.join(bundle, entry.path));
    assert.equal(data.length, entry.size);
    assert.equal(createHash('sha256').update(data).digest('hex'), entry.sha256);
    assert(!forbiddenBody.test(data.toString('utf8')), `sensitive material in ${entry.path}`);
    assert.equal((lstatSync(path.join(bundle, entry.path)).mode & 0o7777).toString(8).padStart(4, '0'), entry.mode);
  }
  assert.equal(lstatSync(bundle).mode & 0o7777, 0o755);
  expectSuccess(run('/bin/bash', ['-n', path.join(bundle, 'dispatcher.sh')]));

  const secondBuild = run(process.execPath, [builder, '--output', bundle]);
  assert.notEqual(secondBuild.status, 0);
  assert.match(output(secondBuild), /already exists/);
});

test('base fixture application is convergent and installs no release or runtime state', (t) => {
  const { workspace, bundle, fixture } = makeWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const plan = invokeFixture(bundle, fixture, 'plan', 'base');
  expectSuccess(plan);
  assert(JSON.parse(String(plan.stdout)).actions.length > 0);

  const first = invokeFixture(bundle, fixture, 'apply', 'base');
  expectSuccess(first);
  assert.equal(JSON.parse(String(first.stdout)).changed, true);
  expectSuccess(invokeFixture(bundle, fixture, 'verify', 'base'));

  const second = invokeFixture(bundle, fixture, 'apply', 'base');
  expectSuccess(second);
  assert.deepEqual(JSON.parse(String(second.stdout)), {
    ok: true,
    profile: 'base',
    changed: false,
    actionCount: 0,
  });

  const state = JSON.parse(readFileSync(path.join(fixture, '.fireside-host-fixture-state.json'), 'utf8'));
  assert.equal(state.daemonReloads, 1);
  assert.equal(state.accounts.fireside.shell, '/usr/sbin/nologin');
  assert.equal(state.accounts['fireside-build'].supplementaryGroups.length, 0);
  assert(existsSync(path.join(fixture, 'usr/local/sbin/fireside-release')));
  assert.equal(existsSync(path.join(fixture, 'opt/fireside/current')), false);
  assert.equal(existsSync(path.join(fixture, 'var/lib/fireside/fireside.db')), false);
  assert.equal(existsSync(path.join(fixture, 'etc/fireside.env')), false);
  assert.equal(existsSync(path.join(fixture, 'etc/fireside-release/github_readonly_ed25519')), false);
});

test('https-layout is convergent and leaves unreadable sentinels and TLS material untouched', (t) => {
  const { workspace, bundle, fixture } = makeWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const sentinel = path.join(fixture, 'home/operator/key.key');
  mkdirSync(path.dirname(sentinel), { recursive: true });
  writeFileSync(sentinel, 'fixture sentinel: do not inspect\n', { mode: 0o000 });

  const first = invokeFixture(bundle, fixture, 'apply', 'https-layout');
  expectSuccess(first);
  assert.equal(JSON.parse(String(first.stdout)).changed, true);
  expectSuccess(invokeFixture(bundle, fixture, 'verify', 'https-layout'));
  const second = invokeFixture(bundle, fixture, 'apply', 'https-layout');
  expectSuccess(second);
  assert.equal(JSON.parse(String(second.stdout)).actionCount, 0);

  assert.equal(lstatSync(sentinel).mode & 0o7777, 0o000);
  assert(existsSync(path.join(fixture, 'etc/fireside-nginx/nginx.conf')));
  assert(existsSync(path.join(fixture, 'etc/systemd/system/fireside-https.service')));
  assert(existsSync(path.join(fixture, 'usr/local/sbin/fireside-tls-install')));
  assert(existsSync(path.join(fixture, 'usr/local/libexec/fireside-tls-installer/install.sh')));
  assert.equal(existsSync(path.join(fixture, 'etc/fireside-tls/fullchain.pem')), false);
  assert.equal(existsSync(path.join(fixture, 'etc/fireside-tls/privkey.pem')), false);
});

test('fixture transaction restores its pre-apply plan after an injected failure', (t) => {
  const { workspace, bundle, fixture } = makeWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const before = invokeFixture(bundle, fixture, 'plan', 'base');
  expectSuccess(before);
  const beforeActions = JSON.parse(String(before.stdout)).actions;
  const failed = invokeFixture(bundle, fixture, 'apply', 'base', ['--fail-after', '4']);
  assert.notEqual(failed.status, 0);
  assert.match(output(failed), /injected fixture failure/);
  assert.equal(existsSync(path.join(fixture, 'opt/fireside/releases')), false);
  assert.equal(existsSync(path.join(fixture, 'usr/local/sbin/fireside-release')), false);

  const after = invokeFixture(bundle, fixture, 'plan', 'base');
  expectSuccess(after);
  assert.deepEqual(JSON.parse(String(after.stdout)).actions, beforeActions);
});

test('fixture planning rejects symlinks, special objects, wrong modes, and multiply-linked files', (t) => {
  const { workspace, bundle } = makeWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const symlinkRoot = path.join(workspace, 'symlink-root');
  mkdirSync(path.join(symlinkRoot, 'etc'), { recursive: true });
  mkdirSync(path.join(symlinkRoot, 'outside'));
  symlinkSync(path.join(symlinkRoot, 'outside'), path.join(symlinkRoot, 'etc/fireside-release'));
  const symlinkPlan = invokeFixture(bundle, symlinkRoot, 'plan', 'base');
  assert.notEqual(symlinkPlan.status, 0);
  assert.match(output(symlinkPlan), /directory metadata is incompatible/);

  const specialRoot = path.join(workspace, 'special-root');
  mkdirSync(path.join(specialRoot, 'etc'), { recursive: true });
  expectSuccess(run('/usr/bin/mkfifo', [path.join(specialRoot, 'etc/fireside-release')]));
  const specialPlan = invokeFixture(bundle, specialRoot, 'plan', 'base');
  assert.notEqual(specialPlan.status, 0);
  assert.match(output(specialPlan), /directory metadata is incompatible/);

  const modeRoot = path.join(workspace, 'mode-root');
  expectSuccess(invokeFixture(bundle, modeRoot, 'apply', 'base'));
  chmodSync(path.join(modeRoot, 'etc/fireside-release'), 0o755);
  const modePlan = invokeFixture(bundle, modeRoot, 'plan', 'base');
  assert.notEqual(modePlan.status, 0);
  assert.match(output(modePlan), /directory metadata is incompatible/);

  const ownerRoot = path.join(workspace, 'owner-root');
  expectSuccess(invokeFixture(bundle, ownerRoot, 'apply', 'base'));
  const ownerStatePath = path.join(ownerRoot, '.fireside-host-fixture-state.json');
  const ownerState = JSON.parse(readFileSync(ownerStatePath, 'utf8'));
  ownerState.metadata['/etc/fireside-release'].owner = 'operator';
  writeFileSync(ownerStatePath, `${JSON.stringify(ownerState, null, 2)}\n`, { mode: 0o600 });
  const ownerPlan = invokeFixture(bundle, ownerRoot, 'plan', 'base');
  assert.notEqual(ownerPlan.status, 0);
  assert.match(output(ownerPlan), /directory metadata is incompatible/);

  const linkRoot = path.join(workspace, 'link-root');
  expectSuccess(invokeFixture(bundle, linkRoot, 'apply', 'base'));
  linkSync(
    path.join(linkRoot, 'usr/local/sbin/fireside-release'),
    path.join(linkRoot, 'usr/local/sbin/fireside-release-second-link'),
  );
  const linkPlan = invokeFixture(bundle, linkRoot, 'plan', 'base');
  assert.notEqual(linkPlan.status, 0);
  assert.match(output(linkPlan), /managed file metadata is incompatible/);
});

test('manifest verification rejects tampering and undeclared files', (t) => {
  const first = makeWorkspace();
  const second = makeWorkspace();
  t.after(() => {
    rmSync(first.workspace, { recursive: true, force: true });
    rmSync(second.workspace, { recursive: true, force: true });
  });

  const markerPath = path.join(first.bundle, 'HOST_INSTALLER_PRODUCTION_MODE');
  const marker = readFileSync(markerPath);
  marker[0] ^= 1;
  writeFileSync(markerPath, marker);
  const digestFailure = invokeFixture(first.bundle, first.fixture, 'plan', 'base');
  assert.notEqual(digestFailure.status, 0);
  assert.match(output(digestFailure), /digest is invalid/);

  writeFileSync(path.join(second.bundle, 'undeclared-file'), 'not in manifest\n', { mode: 0o444 });
  const undeclaredFailure = invokeFixture(second.bundle, second.fixture, 'plan', 'base');
  assert.notEqual(undeclaredFailure.status, 0);
  assert.match(output(undeclaredFailure), /undeclared or missing file/);
});

test('production installer rejects every path or fixture override before fixed-path work', () => {
  const overrideNames = [
    'FIRESIDE_HOST_INSTALL_ROOT',
    'FIRESIDE_HOST_INSTALL_BUNDLE',
    'FIRESIDE_HOST_INSTALL_FAIL_AFTER',
  ];
  for (const name of overrideNames) {
    const result = run(process.execPath, [productionInstaller, 'plan', 'base'], {
      ...process.env,
      [name]: '/tmp/must-not-be-used',
    });
    assert.equal(result.status, 2);
    assert.match(output(result), /rejects path and test overrides/);
  }
});
