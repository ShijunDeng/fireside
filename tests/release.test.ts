import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmod, chown, cp, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const projectRoot = process.cwd();
const installScript = path.join(projectRoot, 'ops/install-release.sh');
const promoteScript = path.join(projectRoot, 'ops/promote-release.sh');
const releaseLib = path.join(projectRoot, 'ops/release-lib.sh');
const guardedBackupScript = path.join(projectRoot, 'ops/guarded-backup.sh');
const rollbackScript = path.join(projectRoot, 'ops/rollback-release.sh');

async function temporaryDirectory(prefix: string) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? projectRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
  });
}

async function waitForFile(filename: string, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await readFile(filename, 'utf8');
    } catch {
      await delay(20);
    }
  }
  throw new Error(`timed out waiting for ${filename}`);
}

async function writeExecutable(filename: string, contents: string) {
  await writeFile(filename, contents);
  await chmod(filename, 0o755);
}

async function createRelease(releasesRoot: string, commit: string, marker: string) {
  const release = path.join(releasesRoot, commit);
  await mkdir(path.join(release, 'server-build/server'), { recursive: true });
  await mkdir(path.join(release, 'server-build/dist'), { recursive: true });
  await mkdir(path.join(release, 'node_modules'), { recursive: true });
  await writeFile(path.join(release, 'server-build/server/index.js'), `// ${marker}\n`);
  await writeFile(path.join(release, 'server-build/server/app.js'), 'export const buildApp = () => {};\n');
  await writeFile(path.join(release, 'server-build/server/backup.js'), 'export const readDatabaseFingerprint = () => {};\n');
  await writeFile(path.join(release, 'server-build/server/backup-cli.js'), `// ${marker}\n`);
  await writeFile(path.join(release, 'server-build/server/preflight-cli.js'), `// ${marker}\n`);
  await writeFile(path.join(release, 'server-build/dist/index.html'), `<p>${marker}</p>\n`);
  await writeFile(path.join(release, 'package.json'), '{}\n');
  await writeFile(path.join(release, 'package-lock.json'), '{}\n');
  await writeFile(path.join(release, 'RELEASE_COMMIT'), `${commit}\n`);
  await writeFile(path.join(release, 'RELEASE_METADATA'), `schema=1\ncommit=${commit}\n`);
  execFileSync('bash', ['-c', `source "$1"; release_generate_manifest "$2"`, 'release-test', releaseLib, release]);
  return release;
}

function markHealthy(stateRoot: string, release: string, env: NodeJS.ProcessEnv) {
  execFileSync('bash', ['-c', 'source "$1"; release_mark_healthy "$2" "$3"', 'mark-healthy', releaseLib, stateRoot, release], { env });
}

function promotionEnvironment(root: string, hooks: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FIRESIDE_RELEASE_TEST_MODE: '1',
    FIRESIDE_RELEASES_ROOT: path.join(root, 'releases'),
    FIRESIDE_CURRENT_LINK: path.join(root, 'current'),
    FIRESIDE_PREVIOUS_LINK: path.join(root, 'previous'),
    FIRESIDE_RELEASE_STATE_ROOT: path.join(root, 'state'),
    FIRESIDE_BACKUP_DIRECTORY: path.join(root, 'backups'),
    FIRESIDE_DATABASE_PATH: path.join(root, 'data/fireside.db'),
    FIRESIDE_RELEASE_LOCK_FILE: path.join(root, 'release.lock'),
    FIRESIDE_RELEASE_GATE_LOCK_FILE: path.join(root, 'release-gate.lock'),
    FIRESIDE_PREFLIGHT_ROOT: root,
    FIRESIDE_RUNTIME_ROOT: path.join(root, 'runtime'),
    ...hooks,
  };
}

async function promotionFixture() {
  const root = await temporaryDirectory('fireside-release-promote-');
  const releasesRoot = path.join(root, 'releases');
  await mkdir(releasesRoot);
  await mkdir(path.join(root, 'state'));
  await mkdir(path.join(root, 'backups'));
  await mkdir(path.join(root, 'data'));
  const originCommit = '1'.repeat(40);
  const targetCommit = '2'.repeat(40);
  const previousCommit = '3'.repeat(40);
  const origin = await createRelease(releasesRoot, originCommit, 'origin');
  const target = await createRelease(releasesRoot, targetCommit, 'target');
  const previous = await createRelease(releasesRoot, previousCommit, 'previous');
  await symlink(origin, path.join(root, 'current'));
  await symlink(previous, path.join(root, 'previous'));

  const backupHook = path.join(root, 'backup-hook');
  const preflightHook = path.join(root, 'preflight-hook');
  const restartHook = path.join(root, 'restart-hook');
  const healthHook = path.join(root, 'health-hook');
  await writeExecutable(backupHook, `#!/usr/bin/env bash
set -eu
if test -e "$1/fireside-backup-20260902T120000000Z-aaaaaaaaaaaaaaaa.sqlite3"; then
  printf snapshot > "$1/fireside-backup-20260902T120001000Z-bbbbbbbbbbbbbbbb.sqlite3"
else
  printf snapshot > "$1/fireside-backup-20260902T120000000Z-aaaaaaaaaaaaaaaa.sqlite3"
fi
printf '%s\n' "$2" > "$1/runner-used"
`);
  await writeExecutable(preflightHook, `#!/usr/bin/env bash
set -eu
printf '%s\\n' '{"ok":true,"topicCount":1,"participantCount":0,"orderVersion":1,"revisionsSha256":"${'a'.repeat(64)}","sensitivePresenceSha256":"${'b'.repeat(64)}","businessDataSha256":"${'d'.repeat(64)}"}'
`);
  await writeExecutable(restartHook, '#!/usr/bin/env bash\nset -eu\nexit 0\n');
  await writeExecutable(healthHook, '#!/usr/bin/env bash\nset -eu\nexit 0\n');
  const stopHook = path.join(root, 'stop-hook');
  const watchdogHook = path.join(root, 'watchdog-hook');
  await writeExecutable(stopHook, '#!/usr/bin/env bash\nset -eu\nexit 0\n');
  await writeExecutable(watchdogHook, '#!/usr/bin/env bash\nset -eu\nexit 0\n');
  const env = promotionEnvironment(root, {
    FIRESIDE_RELEASE_BACKUP_HOOK: backupHook,
    FIRESIDE_RELEASE_PREFLIGHT_HOOK: preflightHook,
    FIRESIDE_RELEASE_RESTART_HOOK: restartHook,
    FIRESIDE_RELEASE_HEALTH_HOOK: healthHook,
    FIRESIDE_RELEASE_STOP_HOOK: stopHook,
    FIRESIDE_RELEASE_WATCHDOG_HOOK: watchdogHook,
  });
  return { root, env, originCommit, targetCommit, previousCommit, origin, target, previous };
}

async function bootstrapFixture() {
  const root = await temporaryDirectory('fireside-release-bootstrap-');
  const releasesRoot = path.join(root, 'releases');
  await mkdir(releasesRoot);
  await mkdir(path.join(root, 'state'));
  await mkdir(path.join(root, 'backups'));
  await mkdir(path.join(root, 'data'));
  const targetCommit = '4'.repeat(40);
  const target = await createRelease(releasesRoot, targetCommit, 'bootstrap-target');

  const backupHook = path.join(root, 'backup-hook');
  const preflightHook = path.join(root, 'preflight-hook');
  const restartHook = path.join(root, 'restart-hook');
  const healthHook = path.join(root, 'health-hook');
  const stopHook = path.join(root, 'stop-hook');
  const watchdogHook = path.join(root, 'watchdog-hook');
  await writeExecutable(backupHook, `#!/bin/bash
set -eu
cp -- "\${FIRESIDE_DATABASE_PATH:?}" "$1/fireside-backup-20260902T130000000Z-cccccccccccccccc.sqlite3"
printf '%s\n' "$2" > "$1/runner-used"
`);
  await writeExecutable(preflightHook, `#!/bin/bash
set -eu
if [[ ! -e $2 ]]; then printf '%s' 'empty-migrated' > "$2"; fi
printf '%s\n' '${JSON.stringify({
    ok: true,
    topicCount: 0,
    participantCount: 0,
    orderVersion: 0,
    revisionsSha256: 'a'.repeat(64),
    sensitivePresenceSha256: 'b'.repeat(64),
    businessDataSha256: 'd'.repeat(64),
  })}'
`);
  await writeExecutable(restartHook, '#!/bin/bash\nset -eu\nexit 0\n');
  await writeExecutable(healthHook, '#!/bin/bash\nset -eu\nexit 0\n');
  await writeExecutable(stopHook, '#!/bin/bash\nset -eu\nexit 0\n');
  await writeExecutable(watchdogHook, '#!/bin/bash\nset -eu\nexit 0\n');
  const env = promotionEnvironment(root, {
    FIRESIDE_RELEASE_BACKUP_HOOK: backupHook,
    FIRESIDE_RELEASE_PREFLIGHT_HOOK: preflightHook,
    FIRESIDE_RELEASE_RESTART_HOOK: restartHook,
    FIRESIDE_RELEASE_HEALTH_HOOK: healthHook,
    FIRESIDE_RELEASE_STOP_HOOK: stopHook,
    FIRESIDE_RELEASE_WATCHDOG_HOOK: watchdogHook,
  });
  return { root, env, targetCommit, target };
}

const rootReleaseHarnessUnavailable = typeof process.getuid === 'function' && process.getuid() !== 0;

describe('版本化发布门禁', {
  skip: rootReleaseHarnessUnavailable ? 'controller fixtures require trusted root ownership semantics' : false,
}, () => {
  it('递归删除嵌套 npm .bin，但拒绝其余依赖链接', async () => {
    const root = await temporaryDirectory('fireside-release-dependency-links-');
    const dependencies = path.join(root, 'node_modules');
    const nestedBin = path.join(dependencies, 'one/node_modules/two/.bin');
    await mkdir(nestedBin, { recursive: true });
    await symlink('../command.js', path.join(nestedBin, 'command'));
    const unsupported = path.join(dependencies, 'one/runtime-link');
    await symlink('runtime.js', unsupported);

    const rejected = run('bash', [
      '-c',
      'source "$1"; release_sanitize_runtime_dependencies "$2"',
      'dependency-links',
      releaseLib,
      dependencies,
    ]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /unsupported symbolic link/);
    await assert.rejects(stat(nestedBin));
    assert.equal(await readlink(unsupported), 'runtime.js');

    await unlink(unsupported);
    const accepted = run('bash', [
      '-c',
      'source "$1"; release_sanitize_runtime_dependencies "$2"',
      'dependency-links',
      releaseLib,
      dependencies,
    ]);
    assert.equal(accepted.status, 0, accepted.stderr);
  });

  it('仅规范化链接全集位于 npm .bin 的显式 legacy release', async () => {
    const root = await temporaryDirectory('fireside-release-legacy-links-');
    const legacy = path.join(root, 'legacy');
    const dependencies = path.join(legacy, 'node_modules');
    const topBin = path.join(dependencies, '.bin');
    const nestedBin = path.join(dependencies, 'one/node_modules/.bin');
    await mkdir(topBin, { recursive: true });
    await mkdir(nestedBin, { recursive: true });
    await symlink('../command.js', path.join(topBin, 'command'));
    await symlink('../command.js', path.join(nestedBin, 'command'));

    const normalize = () => run('bash', [
      '-c',
      'source "$1"; release_normalize_explicit_legacy_dependencies "$2"',
      'legacy-links',
      releaseLib,
      legacy,
    ], { env: { ...process.env, FIRESIDE_RELEASE_TEST_MODE: '1' } });
    const normalized = normalize();
    assert.equal(normalized.status, 0, normalized.stderr);
    await assert.rejects(stat(topBin));
    await assert.rejects(stat(nestedBin));

    await mkdir(topBin, { recursive: true });
    await symlink('../command.js', path.join(topBin, 'command'));
    const outside = path.join(dependencies, 'runtime-link');
    await symlink('runtime.js', outside);
    const rejected = normalize();
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /outside npm command directories/);
    assert.equal(await readlink(path.join(topBin, 'command')), '../command.js');
    assert.equal(await readlink(outside), 'runtime.js');

    await writeFile(path.join(legacy, 'RELEASE_METADATA'), 'schema=1\n');
    const manifested = normalize();
    assert.notEqual(manifested.status, 0);
    assert.match(manifested.stderr, /cannot be normalized as legacy/);
  });

  it('从完整 commit 归档构建候选，不复制 ignored 陈旧产物且不切 current', async () => {
    const root = await temporaryDirectory('fireside-release-install-');
    const source = path.join(root, 'source');
    const releases = path.join(root, 'releases');
    await mkdir(source);
    await mkdir(releases);
    execFileSync('git', ['init', '-q'], { cwd: source });
    execFileSync('git', ['config', 'user.email', 'release@test.invalid'], { cwd: source });
    execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: source });
    await writeFile(path.join(source, '.gitignore'), 'server-build/\nnode_modules/\n');
    await writeFile(path.join(source, 'package.json'), '{}\n');
    await writeFile(path.join(source, 'package-lock.json'), '{}\n');
    await writeFile(path.join(source, 'tracked-marker'), 'from-commit\n');
    execFileSync('git', ['add', '.'], { cwd: source });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: source });
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', commit], { cwd: source });
    await writeFile(path.join(source, 'tracked-marker'), 'attacker-replacement\n');
    execFileSync('git', ['commit', '-qam', 'replacement'], { cwd: source });
    const replacement = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
    execFileSync('git', ['switch', '--detach', '-q', commit], { cwd: source });
    execFileSync('git', ['replace', commit, replacement], { cwd: source });
    const externalAttributes = path.join(root, 'attacker-attributes');
    await writeFile(externalAttributes, 'tracked-marker export-ignore\n');
    await writeFile(path.join(source, '.git/info/attributes'), 'tracked-marker export-ignore\n');
    execFileSync('git', ['config', 'core.attributesFile', externalAttributes], { cwd: source });
    const gitConfigSentinel = path.join(root, 'git-config-command-ran');
    const fakeSsh = path.join(root, 'fake-ssh');
    await writeExecutable(fakeSsh, `#!/bin/sh\ntouch '${gitConfigSentinel}'\nexit 1\n`);
    execFileSync('git', ['config', `url.ssh://attacker.invalid/.insteadOf`, `file://${source}`], { cwd: source });
    execFileSync('git', ['config', 'core.sshCommand', fakeSsh], { cwd: source });
    await mkdir(path.join(source, 'server-build/server'), { recursive: true });
    await writeFile(path.join(source, 'server-build/server/index.js'), '// STALE-IGNORED\n');

    const buildHook = path.join(root, 'build-hook');
    const preflightHook = path.join(root, 'preflight-hook');
    await writeExecutable(buildHook, `#!/usr/bin/env bash
set -eu
stage=$1
test ! -e "$stage/server-build/server/index.js"
grep -Fxq 'from-commit' "$stage/tracked-marker"
mkdir -p "$stage/server-build/server" "$stage/server-build/dist" \
  "$stage/node_modules/top/.bin" "$stage/node_modules/nested/node_modules/.bin"
printf '%s\n' '// FRESH-COMMIT-BUILD' > "$stage/server-build/server/index.js"
printf '%s\n' '// backup' > "$stage/server-build/server/backup-cli.js"
printf '%s\n' '// preflight' > "$stage/server-build/server/preflight-cli.js"
printf '%s\n' '<main>fresh</main>' > "$stage/server-build/dist/index.html"
ln -s ../command.js "$stage/node_modules/top/.bin/command"
ln -s ../command.js "$stage/node_modules/nested/node_modules/.bin/command"
`);
    await writeExecutable(preflightHook, '#!/usr/bin/env bash\nset -eu\nexit 0\n');
    const currentSentinel = path.join(root, 'current-sentinel');
    await writeFile(currentSentinel, 'unchanged');
    const installEnv = {
      ...process.env,
      FIRESIDE_RELEASE_TEST_MODE: '1',
      FIRESIDE_SOURCE_ROOT: source,
      FIRESIDE_RELEASES_ROOT: releases,
      FIRESIDE_RELEASE_LOCK_FILE: path.join(root, 'release.lock'),
      FIRESIDE_PREFLIGHT_ROOT: root,
      FIRESIDE_RELEASE_BUILD_HOOK: buildHook,
      FIRESIDE_RELEASE_PREFLIGHT_HOOK: preflightHook,
      FIRESIDE_RELEASE_AUTH_REMOTE: `file://${source}`,
      FIRESIDE_RELEASE_AUTH_REF: 'refs/remotes/origin/main',
    };
    const result = run('bash', [installScript, commit], { env: installEnv });
    assert.equal(result.status, 0, result.stderr);
    const installed = path.join(releases, commit);
    assert.match(await readFile(path.join(installed, 'server-build/server/index.js'), 'utf8'), /FRESH-COMMIT-BUILD/);
    assert.doesNotMatch(await readFile(path.join(installed, 'server-build/server/index.js'), 'utf8'), /STALE/);
    assert.equal(await readFile(path.join(installed, 'RELEASE_COMMIT'), 'utf8'), `${commit}\n`);
    assert.match(await readFile(path.join(installed, 'RELEASE_METADATA'), 'utf8'), new RegExp(`commit=${commit}`));
    assert.equal(await readFile(currentSentinel, 'utf8'), 'unchanged');
    await assert.rejects(readFile(gitConfigSentinel));
    await assert.rejects(stat(path.join(installed, 'node_modules/top/.bin')));
    await assert.rejects(stat(path.join(installed, 'node_modules/nested/node_modules/.bin')));

    await writeFile(path.join(source, 'tracked-marker'), 'unauthorized-next-commit\n');
    execFileSync('git', ['add', 'tracked-marker'], { cwd: source });
    execFileSync('git', ['commit', '-qm', 'not pushed'], { cwd: source });
    const unauthorized = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
    const rejected = run('bash', [installScript, unauthorized], { env: installEnv });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /not authorized/);
    await assert.rejects(readFile(path.join(releases, unauthorized, 'RELEASE_COMMIT')));
  });

  it('install 在主锁内发现未完成 transaction 或 active 时在构建和创建 release 前失败关闭', async () => {
    for (const residual of ['transaction', 'active'] as const) {
      const root = await temporaryDirectory(`fireside-release-install-${residual}-`);
      const source = path.join(root, 'source');
      const releases = path.join(root, 'releases');
      const stateRoot = path.join(root, 'state');
      const runtimeRoot = path.join(root, 'runtime');
      await mkdir(source);
      await mkdir(releases);
      await mkdir(stateRoot);
      await mkdir(runtimeRoot);
      await mkdir(path.join(root, 'backups'));
      await mkdir(path.join(root, 'data'));
      execFileSync('git', ['init', '-q'], { cwd: source });
      execFileSync('git', ['config', 'user.email', 'release@test.invalid'], { cwd: source });
      execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: source });
      await writeFile(path.join(source, 'package.json'), '{}\n');
      await writeFile(path.join(source, 'package-lock.json'), '{}\n');
      await writeFile(path.join(source, 'tracked-marker'), `${residual}\n`);
      execFileSync('git', ['add', '.'], { cwd: source });
      execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: source });
      execFileSync('git', ['branch', '-M', 'main'], { cwd: source });
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();

      const buildRan = path.join(root, 'build-ran');
      const buildHook = path.join(root, 'build-hook');
      const preflightHook = path.join(root, 'preflight-hook');
      await writeExecutable(buildHook, `#!/usr/bin/env bash
set -eu
touch '${buildRan}'
stage=$1
mkdir -p "$stage/server-build/server" "$stage/server-build/dist" "$stage/node_modules"
printf '%s\n' '// index' > "$stage/server-build/server/index.js"
printf '%s\n' '// backup' > "$stage/server-build/server/backup-cli.js"
printf '%s\n' '// preflight' > "$stage/server-build/server/preflight-cli.js"
printf '%s\n' '<main>fresh</main>' > "$stage/server-build/dist/index.html"
`);
      await writeExecutable(preflightHook, '#!/usr/bin/env bash\nset -eu\nexit 0\n');

      const residualPath = residual === 'transaction'
        ? path.join(stateRoot, 'transaction')
        : path.join(runtimeRoot, 'release-active');
      const residualContents = residual === 'transaction'
        ? `version=1
from=${'1'.repeat(40)}
to=${'2'.repeat(40)}
original_previous=${'3'.repeat(40)}
mode=promote
phase=prepared
`
        : `${'a'.repeat(32)}\n`;
      await writeFile(residualPath, residualContents);

      const installEnv: NodeJS.ProcessEnv = {
        ...process.env,
        FIRESIDE_RELEASE_TEST_MODE: '1',
        FIRESIDE_SOURCE_ROOT: source,
        FIRESIDE_RELEASES_ROOT: releases,
        FIRESIDE_CURRENT_LINK: path.join(root, 'current'),
        FIRESIDE_PREVIOUS_LINK: path.join(root, 'previous'),
        FIRESIDE_RELEASE_STATE_ROOT: stateRoot,
        FIRESIDE_RUNTIME_ROOT: runtimeRoot,
        FIRESIDE_BACKUP_DIRECTORY: path.join(root, 'backups'),
        FIRESIDE_DATABASE_PATH: path.join(root, 'data/fireside.db'),
        FIRESIDE_RELEASE_LOCK_FILE: path.join(root, 'release.lock'),
        FIRESIDE_RELEASE_GATE_LOCK_FILE: path.join(root, 'release-gate.lock'),
        FIRESIDE_PREFLIGHT_ROOT: root,
        FIRESIDE_RELEASE_BUILD_HOOK: buildHook,
        FIRESIDE_RELEASE_PREFLIGHT_HOOK: preflightHook,
        FIRESIDE_RELEASE_AUTH_REMOTE: `file://${source}`,
        FIRESIDE_RELEASE_AUTH_REF: 'refs/heads/main',
      };
      const result = run('bash', [installScript, commit], { env: installEnv });
      assert.equal(result.status, 4, `${residual}: ${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /transaction|release-active|release active/i);
      assert.equal(await readFile(residualPath, 'utf8'), residualContents, `${residual} evidence changed`);
      await assert.rejects(readFile(buildRan), `${residual}: build hook ran before fail-closed check`);
      await assert.rejects(stat(path.join(releases, commit)), `${residual}: immutable release was created`);
      assert.deepEqual(await readdir(releases), [], `${residual}: staging release paths were left behind`);
    }
  });

  it('候选通过后才切 current，并把原健康版本记录为 previous', async () => {
    const fixture = await promotionFixture();
    const result = run('bash', [promoteScript, fixture.targetCommit], { env: fixture.env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readlink(path.join(fixture.root, 'current')), fixture.target);
    assert.equal(await readlink(path.join(fixture.root, 'previous')), fixture.origin);
    await assert.rejects(readFile(path.join(fixture.root, 'state/transaction')));
    assert.match(await readFile(path.join(fixture.root, `state/${fixture.targetCommit}.healthy`), 'utf8'), new RegExp(fixture.targetCommit));
  });

  it('prepared journal 先于 watchdog 就绪，守护启动失败在 active/revoke/current 前安全清理', async () => {
    const fixture = await promotionFixture();
    const observedPrepared = path.join(fixture.root, 'watchdog-observed-prepared');
    const watchdog = path.join(fixture.root, 'failing-watchdog');
    await writeExecutable(watchdog, `#!/bin/bash
set -eu
grep -q '^phase=prepared$' '${path.join(fixture.root, 'state/transaction')}'
test ! -e '${path.join(fixture.root, 'runtime/release-active')}'
test "$(readlink '${path.join(fixture.root, 'current')}')" = '${fixture.origin}'
touch '${observedPrepared}'
exit 1
`);
    fixture.env.FIRESIDE_RELEASE_WATCHDOG_HOOK = watchdog;
    const result = run('bash', [promoteScript, fixture.targetCommit], { env: fixture.env });
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.equal(await readFile(observedPrepared, 'utf8'), '');
    assert.equal(await readlink(path.join(fixture.root, 'current')), fixture.origin);
    assert.equal(await readlink(path.join(fixture.root, 'previous')), fixture.previous);
    await assert.rejects(readFile(path.join(fixture.root, 'state/transaction')));
    await assert.rejects(readFile(path.join(fixture.root, 'runtime/release-active')));
  });

  it('干净主机显式 bootstrap 建立首个 current 和数据库，重复调用拒绝且 previous 仍为空', async () => {
    const fixture = await bootstrapFixture();
    const result = run('bash', [promoteScript, '--bootstrap', fixture.targetCommit], { env: fixture.env });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(await readlink(path.join(fixture.root, 'current')), fixture.target);
    await assert.rejects(readlink(path.join(fixture.root, 'previous')));
    assert.equal(await readFile(path.join(fixture.root, 'data/fireside.db'), 'utf8'), 'empty-migrated');
    await assert.rejects(readFile(path.join(fixture.root, 'state/transaction')));
    assert.match(await readFile(path.join(fixture.root, `state/${fixture.targetCommit}.healthy`), 'utf8'), new RegExp(fixture.targetCommit));

    const beforeDatabase = await readFile(path.join(fixture.root, 'data/fireside.db'));
    const repeated = run('bash', [promoteScript, '--bootstrap', fixture.targetCommit], { env: fixture.env });
    assert.equal(repeated.status, 2, repeated.stderr);
    assert.match(repeated.stderr, /requires current and previous pointers to be absent/);
    assert.deepEqual(await readFile(path.join(fixture.root, 'data/fireside.db')), beforeDatabase);
    assert.equal((await readdir(path.join(fixture.root, 'backups'))).filter((entry) => entry.endsWith('.sqlite3')).length, 0);
  });

  it('已有业务库 bootstrap 健康失败时保留一致备份并恢复无 current 的原始数据', async () => {
    const fixture = await bootstrapFixture();
    const databasePath = path.join(fixture.root, 'data/fireside.db');
    await writeFile(databasePath, 'existing-business-data');
    const failingHealth = path.join(fixture.root, 'failing-health');
    await writeExecutable(failingHealth, '#!/bin/bash\nset -eu\nprintf hot > "${FIRESIDE_DATABASE_PATH:?}-journal"\nexit 1\n');
    fixture.env.FIRESIDE_RELEASE_HEALTH_HOOK = failingHealth;

    const result = run('bash', [promoteScript, '--bootstrap', fixture.targetCommit], { env: fixture.env });
    assert.equal(result.status, 3, `${result.stdout}\n${result.stderr}`);
    await assert.rejects(readlink(path.join(fixture.root, 'current')));
    await assert.rejects(readlink(path.join(fixture.root, 'previous')));
    assert.equal(await readFile(databasePath, 'utf8'), 'existing-business-data');
    assert.equal(await readFile(path.join(fixture.root, 'backups/fireside-backup-20260902T130000000Z-cccccccccccccccc.sqlite3'), 'utf8'), 'existing-business-data');
    await assert.rejects(readFile(path.join(fixture.root, 'state/transaction')));
    await assert.rejects(readFile(path.join(fixture.root, `state/${fixture.targetCommit}.healthy`)));
    await assert.rejects(readFile(`${databasePath}-journal`));
    assert.equal((await readdir(path.join(fixture.root, 'data'))).some((entry) => entry.startsWith('fireside.db.bootstrap')), false);
  });

  it('已有业务库可以完成首次 bootstrap，并把备份身份写入受控事务', async () => {
    const fixture = await bootstrapFixture();
    const databasePath = path.join(fixture.root, 'data/fireside.db');
    await writeFile(databasePath, 'existing-business-data');
    const result = run('bash', [promoteScript, '--bootstrap', fixture.targetCommit], { env: fixture.env });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(await readFile(databasePath, 'utf8'), 'existing-business-data');
    assert.equal(await readlink(path.join(fixture.root, 'current')), fixture.target);
    assert.equal((await readdir(path.join(fixture.root, 'data'))).some((entry) => entry.startsWith('fireside.db.bootstrap')), false);
  });

  it('无主库时拒绝真实 hot rollback journal，且不改变证据或创建指针', async () => {
    const fixture = await bootstrapFixture();
    const databasePath = path.join(fixture.root, 'data/fireside.db');
    const child = spawn(process.execPath, ['-e', `
const Database = require('better-sqlite3');
const db = new Database(process.argv[1]);
db.pragma('journal_mode = DELETE');
db.pragma('synchronous = FULL');
db.pragma('cache_size = 8');
db.exec('CREATE TABLE values_table (id INTEGER PRIMARY KEY, value BLOB);');
const insert = db.prepare('INSERT INTO values_table(value) VALUES (randomblob(1024))');
db.transaction(() => { for (let index = 0; index < 3000; index += 1) insert.run(); })();
db.exec('BEGIN IMMEDIATE');
db.prepare('UPDATE values_table SET value = randomblob(2048)').run();
process.stdout.write('ready\\n');
setInterval(() => {}, 1000);
`, databasePath], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.stdout!.once('data', () => resolve());
    });
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const journalPath = `${databasePath}-journal`;
    const evidence = await readFile(journalPath);
    assert.ok(evidence.length > 512);
    await rename(databasePath, path.join(fixture.root, 'original-main-evidence'));

    const result = run('bash', [promoteScript, '--bootstrap', fixture.targetCommit], { env: fixture.env });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /orphan database sidecar/);
    assert.deepEqual(await readFile(journalPath), evidence);
    await assert.rejects(readFile(databasePath));
    await assert.rejects(readlink(path.join(fixture.root, 'current')));
    assert.equal((await readdir(path.join(fixture.root, 'backups'))).filter((entry) => entry.endsWith('.sqlite3')).length, 0);
  });

  it('开机 recovery 把中断 bootstrap 的 current 和主库恢复为操作前状态', async () => {
    const fixture = await bootstrapFixture();
    const databasePath = path.join(fixture.root, 'data/fireside.db');
    const backupName = 'fireside-backup-20260902T130000000Z-cccccccccccccccc.sqlite3';
    const backupPath = path.join(fixture.root, 'backups', backupName);
    const backupContents = 'original-before-bootstrap';
    await writeFile(backupPath, backupContents);
    const backupSha256 = execFileSync('sha256sum', [backupPath], { encoding: 'utf8' }).split(/\s+/)[0];
    await writeFile(databasePath, 'partially-migrated');
    await symlink(fixture.target, path.join(fixture.root, 'current'));
    await writeFile(path.join(fixture.root, 'state/transaction'), `version=2
from=none
to=${fixture.targetCommit}
original_previous=none
mode=bootstrap
phase=switched
database_backup=${backupName}
transaction_id=${'a'.repeat(32)}
owner_pid=1
owner_starttime=1
owner_boot_id=00000000-0000-0000-0000-000000000000
lock_identity=1:1
permit_commit=none
permit_purpose=none
permit_generation=0
permit_state=none
database_backup_size=${Buffer.byteLength(backupContents)}
database_backup_sha256=${backupSha256}
`);

    const recovered = run('bash', [promoteScript, '--recover', '--boot'], { env: fixture.env });
    assert.equal(recovered.status, 0, recovered.stderr);
    await assert.rejects(readlink(path.join(fixture.root, 'current')));
    assert.equal(await readFile(databasePath, 'utf8'), 'original-before-bootstrap');
    await assert.rejects(readFile(path.join(fixture.root, 'state/transaction')));
    const repeated = run('bash', [promoteScript, '--recover', '--boot'], { env: fixture.env });
    assert.equal(repeated.status, 0, repeated.stderr);
  });

  it('bootstrap 备份内容身份损坏时在触碰 current 或主库前失败并保留 journal', async () => {
    const fixture = await bootstrapFixture();
    const databasePath = path.join(fixture.root, 'data/fireside.db');
    const backupName = 'fireside-backup-20260902T130000000Z-cccccccccccccccc.sqlite3';
    const backupPath = path.join(fixture.root, 'backups', backupName);
    const originalBackup = 'original-before-bootstrap';
    await writeFile(backupPath, originalBackup);
    const backupSha256 = execFileSync('sha256sum', [backupPath], { encoding: 'utf8' }).split(/\s+/)[0];
    await writeFile(databasePath, 'last-valid-migrated-database');
    await symlink(fixture.target, path.join(fixture.root, 'current'));
    const journal = path.join(fixture.root, 'state/transaction');
    await writeFile(journal, `version=2
from=none
to=${fixture.targetCommit}
original_previous=none
mode=bootstrap
phase=switched
database_backup=${backupName}
transaction_id=${'b'.repeat(32)}
owner_pid=1
owner_starttime=1
owner_boot_id=00000000-0000-0000-0000-000000000000
lock_identity=1:1
permit_commit=none
permit_purpose=none
permit_generation=0
permit_state=none
database_backup_size=${Buffer.byteLength(originalBackup)}
database_backup_sha256=${backupSha256}
`);
    await writeFile(backupPath, 'corrupted');

    const recovered = run('bash', [promoteScript, '--recover', '--boot'], { env: fixture.env });
    assert.equal(recovered.status, 4, recovered.stderr);
    assert.equal(await readlink(path.join(fixture.root, 'current')), fixture.target);
    assert.equal(await readFile(databasePath, 'utf8'), 'last-valid-migrated-database');
    assert.match(await readFile(journal, 'utf8'), /phase=switched/);
  });

  it('显式 rollback 使用同一门禁，成功后 previous 可撤销本次回滚', async () => {
    const fixture = await promotionFixture();
    const promoted = run('bash', [promoteScript, fixture.targetCommit], { env: fixture.env });
    assert.equal(promoted.status, 0, promoted.stderr);
    const rolledBack = run('bash', [promoteScript, '--rollback', fixture.originCommit], { env: fixture.env });
    assert.equal(rolledBack.status, 0, rolledBack.stderr);
    assert.equal(await readlink(path.join(fixture.root, 'current')), fixture.origin);
    assert.equal(await readlink(path.join(fixture.root, 'previous')), fixture.target);
  });

  it('rollback --previous 在主锁内解析当时的上一健康版本', async () => {
    const fixture = await promotionFixture();
    const promoted = run('bash', [promoteScript, fixture.targetCommit], { env: fixture.env });
    assert.equal(promoted.status, 0, promoted.stderr);
    const rolledBack = run('bash', [rollbackScript, '--previous'], { env: fixture.env });
    assert.equal(rolledBack.status, 0, rolledBack.stderr);
    assert.equal(await readlink(path.join(fixture.root, 'current')), fixture.origin);
    assert.equal(await readlink(path.join(fixture.root, 'previous')), fixture.target);
  });

  it('首次 promote 使用 target 安全备份器，rollback 使用调用前 current 备份器', async () => {
    const fixture = await promotionFixture();
    const promoted = run('bash', [promoteScript, fixture.targetCommit], { env: fixture.env });
    assert.equal(promoted.status, 0, promoted.stderr);
    assert.equal((await readFile(path.join(fixture.root, 'backups/runner-used'), 'utf8')).trim(), fixture.target);
    const rolledBack = run('bash', [promoteScript, '--rollback', fixture.originCommit], { env: fixture.env });
    assert.equal(rolledBack.status, 0, rolledBack.stderr);
    assert.equal((await readFile(path.join(fixture.root, 'backups/runner-used'), 'utf8')).trim(), fixture.target);
  });

  it('候选健康失败会返回 3、自动恢复 current 且保持原 previous', async () => {
    const fixture = await promotionFixture();
    const failingHealth = path.join(fixture.root, 'failing-health');
    await writeExecutable(failingHealth, `#!/usr/bin/env bash
set -eu
case "$1" in
  *${fixture.targetCommit}) exit 1 ;;
  *) exit 0 ;;
esac
`);
    fixture.env.FIRESIDE_RELEASE_HEALTH_HOOK = failingHealth;
    const result = run('bash', [promoteScript, fixture.targetCommit], { env: fixture.env });
    assert.equal(result.status, 3, `${result.stdout}\n${result.stderr}`);
    assert.equal(await readlink(path.join(fixture.root, 'current')), fixture.origin);
    assert.equal(await readlink(path.join(fixture.root, 'previous')), fixture.previous);
    await assert.rejects(readFile(path.join(fixture.root, 'state/transaction')));
  });

  it('健康标记 digest 读取失败不会被 printf 掩盖或登记当前版本', async () => {
    const fixture = await promotionFixture();
    const breakDigest = path.join(fixture.root, 'break-digest');
    const broken = path.join(fixture.root, 'digest-broken');
    await writeExecutable(breakDigest, `#!/bin/bash
set -eu
if test "$1" = '${fixture.origin}' && test ! -e '${broken}'; then
  rm -f '${path.join(fixture.origin, 'RELEASE_MANIFEST.sha256')}'
  touch '${broken}'
fi
exit 0
`);
    fixture.env.FIRESIDE_RELEASE_HEALTH_HOOK = breakDigest;
    const result = run('bash', [promoteScript, fixture.targetCommit], { env: fixture.env });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /manifest digest cannot be read/);
    assert.equal(await readlink(path.join(fixture.root, 'current')), fixture.origin);
    assert.equal(await readlink(path.join(fixture.root, 'previous')), fixture.previous);
    await assert.rejects(readFile(path.join(fixture.root, `state/${fixture.originCommit}.healthy`)));
  });

  it('manifest 篡改和候选预检失败都在切换前拒绝', async () => {
    const tampered = await promotionFixture();
    await writeFile(path.join(tampered.target, 'server-build/server/index.js'), '// tampered\n');
    const manifestFailure = run('bash', [promoteScript, tampered.targetCommit], { env: tampered.env });
    assert.equal(manifestFailure.status, 2, manifestFailure.stderr);
    assert.equal(await readlink(path.join(tampered.root, 'current')), tampered.origin);

    const preflight = await promotionFixture();
    const failingPreflight = path.join(preflight.root, 'failing-preflight');
    await writeExecutable(failingPreflight, '#!/usr/bin/env bash\nexit 1\n');
    preflight.env.FIRESIDE_RELEASE_PREFLIGHT_HOOK = failingPreflight;
    const preflightFailure = run('bash', [promoteScript, preflight.targetCommit], { env: preflight.env });
    assert.equal(preflightFailure.status, 2, preflightFailure.stderr);
    assert.equal(await readlink(path.join(preflight.root, 'current')), preflight.origin);
    assert.equal(await readlink(path.join(preflight.root, 'previous')), preflight.previous);

    const empty = await promotionFixture();
    const emptyPreflight = path.join(empty.root, 'empty-preflight');
    await writeExecutable(emptyPreflight, '#!/usr/bin/env bash\nexit 0\n');
    empty.env.FIRESIDE_RELEASE_PREFLIGHT_HOOK = emptyPreflight;
    const emptyFailure = run('bash', [promoteScript, empty.targetCommit], { env: empty.env });
    assert.equal(emptyFailure.status, 2, emptyFailure.stderr);
    assert.equal(await readlink(path.join(empty.root, 'current')), empty.origin);
  });

  it('manifest 复算器尾部遇到非法路径时保留失败状态而不接受合法前缀', async () => {
    const fixture = await promotionFixture();
    await writeFile(path.join(fixture.target, 'zz-invalid\npath'), 'must be rejected');
    const result = run('bash', [promoteScript, fixture.targetCommit], { env: fixture.env });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /manifest mismatch/);
    assert.equal(await readlink(path.join(fixture.root, 'current')), fixture.origin);
    assert.equal(await readlink(path.join(fixture.root, 'previous')), fixture.previous);
  });

  it('候选迁移在 revision/presence 不变但业务内容变化时拒绝', async () => {
    const fixture = await promotionFixture();
    const changedFingerprint = path.join(fixture.root, 'changed-fingerprint');
    await writeExecutable(changedFingerprint, `#!/usr/bin/env bash
set -eu
hash='${'d'.repeat(64)}'
if test "$1" = '${fixture.target}' && test "$3" = migrate; then hash='${'c'.repeat(64)}'; fi
printf '%s\\n' "{\\"ok\\":true,\\"topicCount\\":1,\\"participantCount\\":0,\\"orderVersion\\":1,\\"revisionsSha256\\":\\"${'a'.repeat(64)}\\",\\"sensitivePresenceSha256\\":\\"${'b'.repeat(64)}\\",\\"businessDataSha256\\":\\"$hash\\"}"
`);
    fixture.env.FIRESIDE_RELEASE_PREFLIGHT_HOOK = changedFingerprint;
    const result = run('bash', [promoteScript, fixture.targetCommit], { env: fixture.env });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /changed protected business fingerprints/);
    assert.equal(await readlink(path.join(fixture.root, 'current')), fixture.origin);
    assert.equal(await readlink(path.join(fixture.root, 'previous')), fixture.previous);
  });

  it('未完成事务在下一次命令前恢复调用前 current 与 previous', async () => {
    const fixture = await promotionFixture();
    await writeFile(path.join(fixture.root, 'state/transaction'), `version=1
from=${fixture.originCommit}
to=${fixture.targetCommit}
original_previous=${fixture.previousCommit}
mode=promote
phase=switched
`);
    await writeFile(path.join(fixture.root, 'current.tmp'), 'unrelated');
    await (async () => {
      const current = path.join(fixture.root, 'current');
      await import('node:fs/promises').then(({ unlink }) => unlink(current));
      await symlink(fixture.target, current);
    })();
    const result = run('bash', [promoteScript, '--recover'], { env: fixture.env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readlink(path.join(fixture.root, 'current')), fixture.origin);
    assert.equal(await readlink(path.join(fixture.root, 'previous')), fixture.previous);
    await assert.rejects(readFile(path.join(fixture.root, 'state/transaction')));
  });

  it('孤儿事务 owner 的 leader 退出后仍须清空同 PGID 的 TERM 免疫子进程才恢复', async () => {
    const fixture = await promotionFixture();
    const lockFile = fixture.env.FIRESIDE_RELEASE_LOCK_FILE!;
    await writeFile(lockFile, '');
    await chmod(lockFile, 0o600);

    const childPidFile = path.join(fixture.root, 'orphan-child-pid');
    const ownerPidFile = path.join(fixture.root, 'orphan-owner-pid');
    const ownerScript = path.join(fixture.root, 'orphan-owner');
    await writeExecutable(ownerScript, `#!/bin/bash
set -u
child_pid_file=$1
trap 'exit 0' TERM
/bin/bash -c 'trap "" TERM HUP INT; printf "%s\\n" "$$" > "$1"; while :; do sleep 60; done' orphan-child "$child_pid_file" &
while [[ ! -s $child_pid_file ]]; do sleep 0.01; done
while :; do sleep 60; done
`);
    const launched = run('/bin/bash', ['-c', `
/usr/bin/setsid "$1" "$2" </dev/null >/dev/null 2>&1 &
printf '%s\n' "$!" > "$3"
`, 'orphan-launcher', ownerScript, childPidFile, ownerPidFile]);
    assert.equal(launched.status, 0, launched.stderr);
    const ownerPid = Number((await waitForFile(ownerPidFile)).trim());
    assert.ok(Number.isSafeInteger(ownerPid) && ownerPid > 1, 'setsid owner did not expose a pid');

    try {
      const childPid = Number((await waitForFile(childPidFile)).trim());
      assert.ok(Number.isSafeInteger(childPid) && childPid > 1);
      const ownerStat = await readFile(`/proc/${ownerPid}/stat`, 'utf8');
      const ownerFields = ownerStat.slice(ownerStat.lastIndexOf(') ') + 2).trim().split(/\s+/);
      assert.equal(Number(ownerFields[2]), ownerPid, 'owner must lead its process group');
      assert.equal(Number(ownerFields[3]), ownerPid, 'owner must lead its session');
      const ownerStarttime = ownerFields[19];
      assert.match(ownerStarttime, /^[0-9]+$/);
      const ownerBootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
      const lockIdentity = execFileSync('stat', ['-c', '%d:%i', lockFile], { encoding: 'utf8' }).trim();
      const transactionId = 'd'.repeat(32);
      const journal = path.join(fixture.root, 'state/transaction');
      await writeFile(journal, `version=2
from=${fixture.originCommit}
to=${fixture.targetCommit}
original_previous=${fixture.previousCommit}
mode=promote
phase=prepared
database_backup=none
transaction_id=${transactionId}
owner_pid=${ownerPid}
owner_starttime=${ownerStarttime}
owner_boot_id=${ownerBootId}
lock_identity=${lockIdentity}
permit_commit=none
permit_purpose=none
permit_generation=0
permit_state=none
database_backup_size=none
database_backup_sha256=none
`);
      await mkdir(path.join(fixture.root, 'runtime'), { recursive: true });
      await writeFile(path.join(fixture.root, 'runtime/release-active'), `${transactionId}\n`);

      const continuedTooEarly = path.join(fixture.root, 'continued-before-pgid-empty');
      const groupGuardHook = path.join(fixture.root, 'group-guard-hook');
      await writeExecutable(groupGuardHook, `#!/usr/bin/env bash
set -eu
for stat_file in /proc/[0-9]*/stat; do
  process_group=$(awk '{print $5}' "$stat_file" 2>/dev/null || true)
  if [[ $process_group == '${ownerPid}' ]]; then
    printf '%s\n' "$stat_file" > '${continuedTooEarly}'
    exit 91
  fi
done
exit 0
`);
      fixture.env.FIRESIDE_RELEASE_STOP_HOOK = groupGuardHook;
      fixture.env.FIRESIDE_RELEASE_RESTART_HOOK = groupGuardHook;

      const recovered = run('bash', [promoteScript, '--recover'], { env: fixture.env });
      assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
      await assert.rejects(readFile(continuedTooEarly), 'recovery continued while the orphan process group was populated');
      await assert.rejects(readFile(`/proc/${childPid}/stat`), 'TERM-immune child survived successful recovery');
      await assert.rejects(readFile(journal));
    } finally {
      try {
        process.kill(-ownerPid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  });

  it('owner leader 在恢复前已死仍须清空记录 session 的后代', async () => {
    const fixture = await promotionFixture();
    const lockFile = fixture.env.FIRESIDE_RELEASE_LOCK_FILE!;
    await writeFile(lockFile, '');
    await chmod(lockFile, 0o600);
    const childPidFile = path.join(fixture.root, 'leader-dead-child-pid');
    const owner = spawn('/usr/bin/setsid', ['/bin/bash', '-c', `
set -u
/bin/bash -c 'trap "" TERM HUP INT; printf "%s\\n" "$$" > "$1"; while :; do sleep 60; done' leader-dead-child "$1" &
while [[ ! -s $1 ]]; do sleep 0.01; done
while :; do sleep 60; done
`, 'leader-dead-owner', childPidFile], { stdio: 'ignore' });
    assert.ok(owner.pid);
    const ownerPid = owner.pid;
    try {
      const childPid = Number((await waitForFile(childPidFile)).trim());
      const ownerStat = await readFile(`/proc/${ownerPid}/stat`, 'utf8');
      const ownerFields = ownerStat.slice(ownerStat.lastIndexOf(') ') + 2).trim().split(/\s+/);
      const ownerStarttime = ownerFields[19];
      const ownerBootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
      const lockIdentity = execFileSync('stat', ['-c', '%d:%i', lockFile], { encoding: 'utf8' }).trim();
      const transactionId = 'f'.repeat(32);
      const journal = path.join(fixture.root, 'state/transaction');
      await writeFile(journal, `version=2
from=${fixture.originCommit}
to=${fixture.targetCommit}
original_previous=${fixture.previousCommit}
mode=promote
phase=prepared
database_backup=none
transaction_id=${transactionId}
owner_pid=${ownerPid}
owner_starttime=${ownerStarttime}
owner_boot_id=${ownerBootId}
lock_identity=${lockIdentity}
permit_commit=none
permit_purpose=none
permit_generation=0
permit_state=none
database_backup_size=none
database_backup_sha256=none
`);
      await mkdir(path.join(fixture.root, 'runtime'), { recursive: true });
      await writeFile(path.join(fixture.root, 'runtime/release-active'), `${transactionId}\n`);
      process.kill(ownerPid, 'SIGKILL');
      await new Promise<void>((resolve) => owner.once('exit', () => resolve()));

      const continuedTooEarly = path.join(fixture.root, 'leader-dead-group-still-live');
      const groupGuardHook = path.join(fixture.root, 'leader-dead-group-guard');
      await writeExecutable(groupGuardHook, `#!/bin/bash
set -eu
for stat_file in /proc/[0-9]*/stat; do
  process_group=$(awk '{print $5}' "$stat_file" 2>/dev/null || true)
  if [[ $process_group == '${ownerPid}' ]]; then touch '${continuedTooEarly}'; exit 91; fi
done
`);
      fixture.env.FIRESIDE_RELEASE_STOP_HOOK = groupGuardHook;
      fixture.env.FIRESIDE_RELEASE_RESTART_HOOK = groupGuardHook;
      const recovered = run('bash', [promoteScript, '--recover'], { env: fixture.env });
      assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
      await assert.rejects(readFile(continuedTooEarly));
      await assert.rejects(readFile(`/proc/${childPid}/stat`));
      await assert.rejects(readFile(journal));
    } finally {
      try {
        process.kill(-ownerPid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  });

  it('previous 指针持久化失败也会回退，不留下半成功发布', async () => {
    const fixture = await promotionFixture();
    const syncHook = path.join(fixture.root, 'sync-hook');
    const failedOnce = path.join(fixture.root, 'sync-failed-once');
    await writeExecutable(syncHook, `#!/usr/bin/env bash
set -eu
current=$(readlink -f '${path.join(fixture.root, 'current')}')
previous=$(readlink -f '${path.join(fixture.root, 'previous')}' 2>/dev/null || true)
if test "$current" = '${fixture.target}' && test "$previous" = '${fixture.origin}' && test ! -e '${failedOnce}'; then
  touch '${failedOnce}'
  exit 1
fi
exit 0
`);
    fixture.env.FIRESIDE_RELEASE_SYNC_HOOK = syncHook;
    const result = run('bash', [promoteScript, fixture.targetCommit], { env: fixture.env });
    assert.equal(result.status, 3, `${result.stdout}\n${result.stderr}`);
    assert.equal(await readlink(path.join(fixture.root, 'current')), fixture.origin);
    assert.equal(await readlink(path.join(fixture.root, 'previous')), fixture.previous);
    await assert.rejects(readFile(path.join(fixture.root, 'state/transaction')));
  });

  it('previous=none 删除失败时返回致命恢复状态并保留事务证据', async () => {
    const fixture = await promotionFixture();
    await unlink(path.join(fixture.root, 'previous'));
    await mkdir(path.join(fixture.root, 'previous'));
    await unlink(path.join(fixture.root, 'current'));
    await symlink(fixture.target, path.join(fixture.root, 'current'));
    const transaction = path.join(fixture.root, 'state/transaction');
    await writeFile(transaction, `version=1
from=${fixture.originCommit}
to=${fixture.targetCommit}
original_previous=none
mode=promote
phase=switched
`);
    const result = run('bash', [promoteScript, '--recover'], { env: fixture.env });
    assert.equal(result.status, 4, result.stderr);
    assert.equal(await readlink(path.join(fixture.root, 'current')), fixture.origin);
    assert.equal(await readFile(transaction, 'utf8').then((value) => value.includes('phase=switched')), true);
  });

  it('开机 recovery 只恢复持久指针，不启动服务并保持幂等', async () => {
    const fixture = await promotionFixture();
    await writeFile(path.join(fixture.root, 'state/transaction'), `version=1
from=${fixture.originCommit}
to=${fixture.targetCommit}
original_previous=${fixture.previousCommit}
mode=promote
phase=healthy
`);
    const current = path.join(fixture.root, 'current');
    await import('node:fs/promises').then(({ unlink }) => unlink(current));
    await symlink(fixture.target, current);
    const mustNotRun = path.join(fixture.root, 'must-not-run');
    await writeExecutable(mustNotRun, '#!/usr/bin/env bash\nexit 99\n');
    fixture.env.FIRESIDE_RELEASE_RESTART_HOOK = mustNotRun;
    fixture.env.FIRESIDE_RELEASE_HEALTH_HOOK = mustNotRun;
    const recovered = run('bash', [promoteScript, '--recover', '--boot'], { env: fixture.env });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(await readlink(current), fixture.origin);
    assert.equal(await readlink(path.join(fixture.root, 'previous')), fixture.previous);
    const repeated = run('bash', [promoteScript, '--recover', '--boot'], { env: fixture.env });
    assert.equal(repeated.status, 0, repeated.stderr);
  });

  it('无事务冷启动从健康 current 重建 selector 与按 commit 绑定的写许可', async () => {
    const fixture = await promotionFixture();
    markHealthy(path.join(fixture.root, 'state'), fixture.origin, fixture.env);
    const gated = run('bash', [promoteScript, '--service-gate'], { env: fixture.env });
    assert.equal(gated.status, 0, gated.stderr);
    assert.equal(await readlink(path.join(fixture.root, 'runtime/current')), fixture.origin);
    assert.equal((await readFile(path.join(fixture.root, 'runtime/writes-enabled'), 'utf8')).trim(), fixture.originCommit);
    assert.equal((await stat(path.join(fixture.root, 'runtime/writes-enabled'))).mode & 0o777, 0o444);
  });

  it('冷启动 current 的健康标记不匹配时 Node 与运行 selector 都失败关闭', async () => {
    const fixture = await promotionFixture();
    await writeFile(path.join(fixture.root, `state/${fixture.originCommit}.healthy`), `${fixture.originCommit} ${'0'.repeat(64)}\n`);
    const gated = run('bash', [promoteScript, '--service-gate'], { env: fixture.env });
    assert.equal(gated.status, 4, gated.stderr);
    await assert.rejects(readlink(path.join(fixture.root, 'runtime/current')));
    await assert.rejects(readFile(path.join(fixture.root, 'runtime/writes-enabled')));
  });

  it('独立 service gate 见旧 MainPID 仍在时保留事务并快速失败', async () => {
    const fixture = await promotionFixture();
    markHealthy(path.join(fixture.root, 'state'), fixture.origin, fixture.env);
    const journal = path.join(fixture.root, 'state/transaction');
    await unlink(path.join(fixture.root, 'current'));
    await symlink(fixture.target, path.join(fixture.root, 'current'));
    await writeFile(journal, `version=1
from=${fixture.originCommit}
to=${fixture.targetCommit}
original_previous=${fixture.previousCommit}
mode=promote
phase=switched
`);
    const mainPidHook = path.join(fixture.root, 'main-pid-hook');
    await writeExecutable(mainPidHook, '#!/bin/bash\nprintf \'%s\\n\' 424242\n');
    fixture.env.FIRESIDE_RELEASE_MAIN_PID_HOOK = mainPidHook;

    const startedAt = Date.now();
    const refused = run('bash', [promoteScript, '--service-gate'], { env: fixture.env });
    assert.equal(refused.status, 4, refused.stderr);
    assert.ok(Date.now() - startedAt < 2_000, 'gate waited instead of handing recovery to the watchdog');
    assert.equal(await readlink(path.join(fixture.root, 'current')), fixture.target);
    assert.match(await readFile(journal, 'utf8'), /phase=switched/);

    await writeExecutable(mainPidHook, '#!/bin/bash\nprintf \'%s\\n\' 0\n');
    const stoppedGate = run('bash', [promoteScript, '--service-gate'], { env: fixture.env });
    assert.equal(stoppedGate.status, 0, stoppedGate.stderr);
    assert.equal(await readlink(path.join(fixture.root, 'current')), fixture.origin);
    await assert.rejects(readFile(journal));
  });

  it('备份 runner 在共享锁内复核健康 selector、许可和无事务状态', async () => {
    const fixture = await promotionFixture();
    const sentinel = path.join(fixture.root, 'backups/guarded-ran');
    await writeFile(path.join(fixture.origin, 'server-build/server/backup-cli.js'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'origin');\n`);
    execFileSync('bash', ['-c', 'source "$1"; release_generate_manifest "$2"', 'manifest', releaseLib, fixture.origin]);
    markHealthy(path.join(fixture.root, 'state'), fixture.origin, fixture.env);
    const gated = run('bash', [promoteScript, '--service-gate'], { env: fixture.env });
    assert.equal(gated.status, 0, gated.stderr);
    const backup = run('bash', [guardedBackupScript], { env: fixture.env });
    assert.equal(backup.status, 0, backup.stderr);
    assert.equal(await readFile(sentinel, 'utf8'), 'origin');

    await unlink(sentinel);
    await writeFile(path.join(fixture.root, 'runtime/release-active'), 'blocked\n');
    const refused = run('bash', [guardedBackupScript], { env: fixture.env });
    assert.equal(refused.status, 4, refused.stderr);
    await assert.rejects(readFile(sentinel));
  });

  it('主锁与 gate mutex 都不会泄露给持久化 hook 子进程', async () => {
    const fixture = await promotionFixture();
    const noInheritedLocks = path.join(fixture.root, 'no-inherited-locks');
    await writeExecutable(noInheritedLocks, `#!/bin/bash
set -eu
test ! -e /proc/$$/fd/8
test ! -e /proc/$$/fd/9
`);
    fixture.env.FIRESIDE_RELEASE_SYNC_HOOK = noInheritedLocks;
    const promoted = run('bash', [promoteScript, fixture.targetCommit], { env: fixture.env });
    assert.equal(promoted.status, 0, `${promoted.stdout}\n${promoted.stderr}`);

    await rm(path.join(fixture.root, 'runtime'), { recursive: true, force: true });
    const gated = run('bash', [promoteScript, '--service-gate'], { env: fixture.env });
    assert.equal(gated.status, 0, gated.stderr);
  });

  it('固定原子文件目标为异常类型时保留证据并拒绝假成功', async () => {
    const transactionFixture = await promotionFixture();
    const transactionPath = path.join(transactionFixture.root, 'state/transaction');
    await mkdir(transactionPath);
    const transactionGate = run('bash', [promoteScript, '--service-gate'], { env: transactionFixture.env });
    assert.equal(transactionGate.status, 4, transactionGate.stderr);
    assert.deepEqual(await readdir(transactionPath), []);

    const permitFixture = await promotionFixture();
    markHealthy(path.join(permitFixture.root, 'state'), permitFixture.origin, permitFixture.env);
    await mkdir(path.join(permitFixture.root, 'runtime'), { recursive: true });
    const permitPath = path.join(permitFixture.root, 'runtime/writes-enabled');
    await mkdir(permitPath);
    const permitGate = run('bash', [promoteScript, '--service-gate'], { env: permitFixture.env });
    assert.equal(permitGate.status, 4, permitGate.stderr);
    assert.deepEqual(await readdir(permitPath), []);

    const markerFixture = await promotionFixture();
    const markerPath = path.join(markerFixture.root, `state/${markerFixture.originCommit}.healthy`);
    await mkdir(markerPath);
    assert.throws(() => markHealthy(path.join(markerFixture.root, 'state'), markerFixture.origin, markerFixture.env));
    assert.deepEqual(await readdir(markerPath), []);
  });

  it('清理 committed 事务前先验证 active，异常时不删唯一 journal', async () => {
    const fixture = await promotionFixture();
    const journal = path.join(fixture.root, 'state/transaction');
    const active = path.join(fixture.root, 'runtime/release-active');
    await unlink(path.join(fixture.root, 'current'));
    await symlink(fixture.target, path.join(fixture.root, 'current'));
    await unlink(path.join(fixture.root, 'previous'));
    await symlink(fixture.origin, path.join(fixture.root, 'previous'));
    markHealthy(path.join(fixture.root, 'state'), fixture.target, fixture.env);
    await writeFile(journal, `version=1
from=${fixture.originCommit}
to=${fixture.targetCommit}
original_previous=${fixture.previousCommit}
mode=promote
phase=committed
`);
    await mkdir(path.dirname(active), { recursive: true });
    await mkdir(active);

    const refused = run('bash', [promoteScript, '--recover'], { env: fixture.env });
    assert.equal(refused.status, 4, refused.stderr);
    assert.match(await readFile(journal, 'utf8'), /phase=committed/);
    assert.ok((await stat(active)).isDirectory());

    await rm(active, { recursive: true });
    await writeFile(active, `${'e'.repeat(32)}\n`);
    const recovered = run('bash', [promoteScript, '--recover'], { env: fixture.env });
    assert.equal(recovered.status, 0, recovered.stderr);
    await assert.rejects(readFile(journal));
    await assert.rejects(readFile(active));
    assert.equal(await readlink(path.join(fixture.root, 'runtime/current')), fixture.target);
    assert.equal((await readFile(path.join(fixture.root, 'runtime/writes-enabled'), 'utf8')).trim(), fixture.targetCommit);
  });

  it('release 根目录不可由应用遍历时 gate 不发布运行态', async () => {
    const fixture = await promotionFixture();
    markHealthy(path.join(fixture.root, 'state'), fixture.origin, fixture.env);
    await chmod(path.join(fixture.root, 'releases'), 0o700);
    const refused = run('bash', [promoteScript, '--service-gate'], { env: fixture.env });
    assert.equal(refused.status, 4, refused.stderr);
    await assert.rejects(readlink(path.join(fixture.root, 'runtime/current')));
    await chmod(path.join(fixture.root, 'releases'), 0o755);
    const accepted = run('bash', [promoteScript, '--service-gate'], { env: fixture.env });
    assert.equal(accepted.status, 0, accepted.stderr);
  });

  it('维护锁被占用时稳定返回 75，所有指针保持不变', async () => {
    const fixture = await promotionFixture();
    const holder = spawn('flock', ['-x', fixture.env.FIRESIDE_RELEASE_LOCK_FILE!, 'sleep', '5']);
    try {
      await delay(150);
      const result = run('bash', [promoteScript, fixture.targetCommit], { env: fixture.env });
      assert.equal(result.status, 75, result.stderr);
      assert.equal(await readlink(path.join(fixture.root, 'current')), fixture.origin);
      assert.equal(await readlink(path.join(fixture.root, 'previous')), fixture.previous);
    } finally {
      holder.kill('SIGTERM');
    }
  });

  it('维护锁不依赖 umask，修正为所有者 0600 并拒绝链接', async () => {
    const root = await temporaryDirectory('fireside-release-lock-mode-');
    const lockFile = path.join(root, 'release.lock');
    await writeFile(lockFile, '');
    await chmod(lockFile, 0o644);
    const prepared = run('bash', ['-c', 'umask 022; source "$1"; release_prepare_lock_file "$2" "$(id -u)" "$(id -g)"; stat -c %a "$2"', 'lock-mode', releaseLib, lockFile]);
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(prepared.stdout.trim(), '600');
    if (process.getuid?.() === 0) {
      const nobody = run('runuser', ['-u', 'nobody', '--', 'bash', '-c', 'exec 8<"$1"', 'lock-open', lockFile]);
      assert.notEqual(nobody.status, 0, 'nobody unexpectedly opened the root-only release lock');
    }

    const symlinkLock = path.join(root, 'symlink.lock');
    await symlink(lockFile, symlinkLock);
    const rejectedSymlink = run('bash', ['-c', 'source "$1"; release_prepare_lock_file "$2" "$(id -u)" "$(id -g)"', 'lock-symlink', releaseLib, symlinkLock]);
    assert.notEqual(rejectedSymlink.status, 0);
    const hardlinkLock = path.join(root, 'hardlink.lock');
    execFileSync('ln', [lockFile, hardlinkLock]);
    const rejectedHardlink = run('bash', ['-c', 'source "$1"; release_prepare_lock_file "$2" "$(id -u)" "$(id -g)"', 'lock-hardlink', releaseLib, lockFile]);
    assert.notEqual(rejectedHardlink.status, 0);
  });

  it('开机 recovery 有界等待已经在途的维护锁，而不是让应用依赖启动失败', async () => {
    const fixture = await promotionFixture();
    await writeFile(path.join(fixture.root, 'state/transaction'), `version=1
from=${fixture.originCommit}
to=${fixture.targetCommit}
original_previous=${fixture.previousCommit}
mode=promote
phase=prepared
`);
    const acquired = path.join(fixture.root, 'boot-lock-acquired');
    const holder = spawn('flock', [
      '-x',
      fixture.env.FIRESIDE_RELEASE_LOCK_FILE!,
      'bash',
      '-c',
      `touch '${acquired}'; sleep 0.4`,
    ]);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await readFile(acquired);
        break;
      } catch {
        await delay(20);
      }
    }
    await readFile(acquired);
    const startedAt = Date.now();
    const result = run('bash', [promoteScript, '--recover', '--boot'], { env: fixture.env });
    const elapsed = Date.now() - startedAt;
    assert.equal(result.status, 0, result.stderr);
    assert.ok(elapsed >= 150, `boot recovery should wait for the lock, elapsed=${elapsed}`);
    assert.equal(await readlink(path.join(fixture.root, 'current')), fixture.origin);
    holder.kill('SIGTERM');
  });

  it('preflight 临时目录创建失败时不复制备份、不触碰指针或根路径', async () => {
    const fixture = await promotionFixture();
    fixture.env.FIRESIDE_PREFLIGHT_ROOT = path.join(fixture.root, 'missing', 'nested');
    const result = run('bash', [promoteScript, fixture.targetCommit], { env: fixture.env });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /sensitive preflight parent|cannot create the isolated promotion preflight directory/);
    assert.equal(await readlink(path.join(fixture.root, 'current')), fixture.origin);
    assert.equal(await readlink(path.join(fixture.root, 'previous')), fixture.previous);
    await assert.rejects(readFile('/fireside.db'));
  });

  it('敏感 preflight stage 清理失败时不写事务或切换版本', async () => {
    const fixture = await promotionFixture();
    const cleanupFailure = path.join(fixture.root, 'cleanup-failure');
    await writeExecutable(cleanupFailure, '#!/bin/bash\nexit 1\n');
    fixture.env.FIRESIDE_RELEASE_CLEANUP_HOOK = cleanupFailure;
    const result = run('bash', [promoteScript, fixture.targetCommit], { env: fixture.env });
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /cannot remove the isolated promotion preflight directory/);
    assert.match(result.stderr, /manual cleanup is required/);
    assert.equal(await readlink(path.join(fixture.root, 'current')), fixture.origin);
    assert.equal(await readlink(path.join(fixture.root, 'previous')), fixture.previous);
    await assert.rejects(readFile(path.join(fixture.root, 'state/transaction')));
    assert.equal((await readdir(path.join(fixture.root, 'sensitive-preflight')))
      .filter((entry) => entry.startsWith('promote.')).length, 1);
  });

  it('敏感 preflight 孤儿在 root-only 父目录中隔离并由下一主锁入口清理', async () => {
    const fixture = await promotionFixture();
    await chmod(fixture.root, 0o755);
    const sensitiveRoot = path.join(fixture.root, 'sensitive-preflight');
    const orphan = path.join(sensitiveRoot, `promote.${fixture.targetCommit}.AbCd1234`);
    const secret = path.join(orphan, 'fireside.db');
    await mkdir(orphan, { recursive: true, mode: 0o700 });
    await chmod(sensitiveRoot, 0o700);
    await writeFile(secret, 'unique-private-business-value');
    const buildUid = Number(execFileSync('id', ['-u', 'fireside-build'], { encoding: 'utf8' }).trim());
    const buildGid = Number(execFileSync('id', ['-g', 'fireside-build'], { encoding: 'utf8' }).trim());
    await chown(orphan, buildUid, buildGid);

    const exposed = run('runuser', ['-u', 'fireside-build', '--', 'head', '-c', '1', secret]);
    assert.notEqual(exposed.status, 0, 'build identity traversed the root-only sensitive preflight parent');
    markHealthy(path.join(fixture.root, 'state'), fixture.origin, fixture.env);
    const gated = run('bash', [promoteScript, '--service-gate'], { env: fixture.env });
    assert.equal(gated.status, 0, gated.stderr);
    await assert.rejects(stat(orphan));

    const installSource = await readFile(installScript, 'utf8');
    assert.match(installSource, /InaccessiblePaths=.*sensitive_preflight_root/);
    assert.match(installSource, /fireside-sensitive-preflight-install/);
    assert.match(await readFile(promoteScript, 'utf8'), /fireside-sensitive-preflight-release/);
  });

  it('Git 读取隔离 HOME/XDG/调用变量并覆盖仓库本地 fsmonitor', async () => {
    const root = await temporaryDirectory('fireside-release-git-config-');
    const repository = path.join(root, 'repository');
    const home = path.join(root, 'home');
    const xdg = path.join(root, 'xdg/git');
    const sentinel = path.join(root, 'fsmonitor-ran');
    const hook = path.join(root, 'fsmonitor');
    await mkdir(repository);
    await mkdir(home);
    await mkdir(xdg, { recursive: true });
    await writeExecutable(hook, `#!/bin/sh\ntouch '${sentinel}'\nexit 1\n`);
    const config = `[core]\n\tfsmonitor = ${hook}\n`;
    await writeFile(path.join(home, '.gitconfig'), config);
    await writeFile(path.join(xdg, 'config'), config);
    execFileSync('git', ['init', '-q'], { cwd: repository });
    await writeFile(path.join(repository, 'tracked'), 'value\n');
    execFileSync('git', ['add', 'tracked'], { cwd: repository });
    execFileSync('git', ['-c', 'user.name=Release Test', '-c', 'user.email=release@test.invalid', 'commit', '-qm', 'fixture'], { cwd: repository });
    execFileSync('git', ['config', 'core.fsmonitor', hook], { cwd: repository });

    const result = run('bash', ['-c', 'source "$1"; release_sanitize_environment; release_git -C "$2" status --porcelain', 'git-isolation', releaseLib, repository], {
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: path.dirname(xdg),
        TMPDIR: root,
        GIT_CONFIG_PARAMETERS: `'core.fsmonitor=${hook}'`,
        GIT_EXEC_PATH: path.join(root, 'fake-git-exec'),
        GIT_TRACE: sentinel,
        ALL_PROXY: 'http://127.0.0.1:9',
        DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/attacker-bus',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(readFile(sentinel));
  });

  it('权威私库 fetch 固定 SSH 443、专用身份与 host pin', async () => {
    const result = run('bash', [
      '-c',
      'source "$1"; ssh_command=$(release_authoritative_ssh_command); eval "$ssh_command -G ssh.github.com"',
      'authoritative-ssh',
      releaseLib,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const config = result.stdout;
    assert.match(config, /^user git$/m);
    assert.match(config, /^hostname ssh\.github\.com$/m);
    assert.match(config, /^port 443$/m);
    assert.match(config, /^batchmode yes$/m);
    assert.match(config, /^identitiesonly yes$/m);
    assert.match(config, /^identityagent none$/m);
    assert.match(config, /^identityfile none$/m);
    assert.match(config, /^certificatefile none$/m);
    assert.match(config, /^stricthostkeychecking true$/m);
    assert.match(config, /^userknownhostsfile \/etc\/fireside-release\/github_known_hosts$/m);
    assert.match(config, /^globalknownhostsfile \/dev\/null$/m);
    assert.match(config, /^updatehostkeys false$/m);
    assert.match(config, /^verifyhostkeydns false$/m);
    assert.match(config, /^passwordauthentication no$/m);
    assert.match(config, /^kbdinteractiveauthentication no$/m);
    assert.match(config, /^numberofpasswordprompts 0$/m);
    assert.match(config, /^clearallforwardings yes$/m);
    assert.match(config, /^permitlocalcommand no$/m);
    assert.match(config, /^requesttty false$/m);
    assert.match(config, /^controlmaster false$/m);

    const releaseLibSource = await readFile(releaseLib, 'utf8');
    assert.match(releaseLibSource, /IdentityFile=none -i \/etc\/fireside-release\/github_readonly_ed25519/);
    assert.match(releaseLibSource, /KnownHostsCommand=none/);
    assert.match(releaseLibSource, /ProxyCommand=none -o ProxyJump=none/);
    assert.doesNotMatch(releaseLibSource, /\/root\/\.ssh/);
    const installSource = await readFile(installScript, 'utf8');
    assert.match(installSource, /ssh:\/\/git@ssh\.github\.com:443\/ShijunDeng\/fireside\.git/);
    assert.match(installSource, /release_git_authoritative_fetch "\$\{auth_repo\}"/);
    assert.doesNotMatch(installSource, /https:\/\/github\.com\/ShijunDeng\/fireside\.git/);
    assert.equal(
      await readFile(path.join(projectRoot, 'ops/controller-assets/github_known_hosts'), 'utf8'),
      '[ssh.github.com]:443 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n',
    );
  });

  it('socket 与 service 必须各自 active，任一单边 active 都不通过', () => {
    const script = `
source "$1"
fake_systemctl() {
  local unit=\${*: -1}
  if [[ \${unit} == fireside.socket ]]; then [[ \${SOCKET_STATE} == active ]];
  else [[ \${SERVICE_STATE} == active ]]; fi
}
release_units_are_active fake_systemctl
`;
    for (const [socketState, serviceState, expected] of [
      ['active', 'inactive', 1],
      ['inactive', 'active', 1],
      ['active', 'active', 0],
    ] as const) {
      const result = run('bash', ['-c', script, 'unit-state', releaseLib], {
        env: { ...process.env, SOCKET_STATE: socketState, SERVICE_STATE: serviceState },
      });
      assert.equal(result.status, expected, `${socketState}/${serviceState}: ${result.stderr}`);
    }
  });

  it('回环健康请求显式绕过调用者代理', async () => {
    const root = await temporaryDirectory('fireside-release-health-proxy-');
    const targetLog = path.join(root, 'target.log');
    const proxyLog = path.join(root, 'proxy.log');
    const startServer = async (log: string, body: string) => {
      const child = spawn(process.execPath, ['-e', `
const http = require('node:http');
const fs = require('node:fs');
const server = http.createServer((_request, response) => {
  fs.appendFileSync(process.argv[1], 'request\\n');
  response.writeHead(200, {'content-type': 'application/json'});
  response.end(process.argv[2]);
});
server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
`, log, body], { stdio: ['ignore', 'pipe', 'inherit'] });
      const port = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.stdout!.once('data', (chunk) => resolve(Number(String(chunk).trim())));
      });
      return { child, port };
    };
    const target = await startServer(targetLog, '{"ok":true}');
    const proxy = await startServer(proxyLog, '{"ok":true}');
    try {
      const result = run('bash', ['-c', 'source "$1"; release_sanitize_environment; release_fetch_health "$2"', 'health-proxy', releaseLib, `http://127.0.0.1:${target.port}/api/health`], {
        env: {
          ...process.env,
          http_proxy: `http://127.0.0.1:${proxy.port}`,
          HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
          ALL_PROXY: `http://127.0.0.1:${proxy.port}`,
          NO_PROXY: '',
        },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '{"ok":true}');
      assert.match(await readFile(targetLog, 'utf8'), /request/);
      await assert.rejects(readFile(proxyLog));
    } finally {
      target.child.kill('SIGTERM');
      proxy.child.kill('SIGTERM');
    }
  });

  it('按 URL push 后显式 fetch 才更新 tracking ref', async () => {
    const root = await temporaryDirectory('fireside-release-push-flow-');
    const source = path.join(root, 'source');
    const remote = path.join(root, 'remote.git');
    await mkdir(source);
    execFileSync('git', ['init', '-q', '--bare', remote]);
    execFileSync('git', ['init', '-q'], { cwd: source });
    execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: source });
    execFileSync('git', ['config', 'user.email', 'release@test.invalid'], { cwd: source });
    await writeFile(path.join(source, 'value'), 'one\n');
    execFileSync('git', ['add', 'value'], { cwd: source });
    execFileSync('git', ['commit', '-qm', 'one'], { cwd: source });
    execFileSync('git', ['push', remote, 'HEAD:main'], { cwd: source });
    execFileSync('git', ['fetch', remote, 'refs/heads/main:refs/remotes/origin/main'], { cwd: source });
    await writeFile(path.join(source, 'value'), 'two\n');
    execFileSync('git', ['commit', '-qam', 'two'], { cwd: source });
    const second = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
    execFileSync('git', ['push', remote, 'HEAD:main'], { cwd: source });
    const stale = execFileSync('git', ['rev-parse', 'refs/remotes/origin/main'], { cwd: source, encoding: 'utf8' }).trim();
    assert.notEqual(stale, second);
    execFileSync('git', ['fetch', remote, 'refs/heads/main:refs/remotes/origin/main'], { cwd: source });
    assert.equal(execFileSync('git', ['rev-parse', 'refs/remotes/origin/main'], { cwd: source, encoding: 'utf8' }).trim(), second);
  });

  it('工作树脚本不能作为生产 root 入口', () => {
    const result = run('bash', [installScript, 'a'.repeat(40)], {
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'FIRESIDE_RELEASE_TEST_MODE')),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /installed root-owned controller/);
  });

  it('生产模式控制器和子脚本在读取路径或执行 hook 前拒绝全部测试覆盖', async () => {
    const root = await temporaryDirectory('fireside-production-controller-');
    const controller = path.join(root, 'controller');
    await mkdir(controller);
    for (const filename of [
      'fireside-release',
      'install-release.sh',
      'promote-release.sh',
      'rollback-release.sh',
      'release-lib.sh',
      'release-status.sh',
      'guarded-backup.sh',
    ]) {
      await cp(path.join(projectRoot, 'ops', filename), path.join(controller, filename));
    }
    await writeFile(path.join(controller, 'CONTROLLER_PRODUCTION_MODE'), 'fireside-release-production-v1\n');

    const sentinel = path.join(root, 'hook-ran');
    const maliciousHook = path.join(root, 'malicious-hook');
    await writeExecutable(maliciousHook, `#!/usr/bin/env bash\ntouch '${sentinel}'\n`);
    const maliciousBin = path.join(root, 'malicious-bin');
    await mkdir(maliciousBin);
    await writeExecutable(path.join(maliciousBin, 'readlink'), `#!/bin/sh\ntouch '${sentinel}'\nexec /usr/bin/readlink "$@"\n`);
    await writeExecutable(path.join(maliciousBin, 'bash'), `#!/bin/sh\ntouch '${sentinel}'\nexec /bin/bash "$@"\n`);
    const maliciousStartup = path.join(root, 'malicious-startup');
    await writeFile(maliciousStartup, `touch '${sentinel}'\n`);
    const maliciousEnv = {
      ...process.env,
      PATH: `${maliciousBin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      BASH_ENV: maliciousStartup,
      ENV: maliciousStartup,
      FIRESIDE_RELEASE_TEST_MODE: '1',
      FIRESIDE_RELEASES_ROOT: path.join(root, 'attacker-releases'),
      FIRESIDE_SOURCE_ROOT: path.join(root, 'attacker-source'),
      FIRESIDE_RELEASE_BUILD_HOOK: maliciousHook,
      FIRESIDE_RELEASE_PREFLIGHT_HOOK: maliciousHook,
      FIRESIDE_RELEASE_RESTART_HOOK: maliciousHook,
      FIRESIDE_RELEASE_HEALTH_HOOK: maliciousHook,
      FIRESIDE_RELEASE_SYNC_HOOK: maliciousHook,
    };

    for (const invocation of [
      ['fireside-release', 'status'],
      ['install-release.sh', 'a'.repeat(40)],
      ['promote-release.sh', 'a'.repeat(40)],
      ['rollback-release.sh', '--previous'],
      ['release-status.sh'],
      ['guarded-backup.sh'],
    ]) {
      const [filename, ...args] = invocation;
      const result = run(path.join(controller, filename), args, { env: maliciousEnv });
      assert.equal(result.status, 2, `${filename}: ${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /test overrides are disabled/);
    }
    await assert.rejects(readFile(sentinel));

    const pathOnly = run(path.join(controller, 'fireside-release'), ['status'], {
      env: {
        ...process.env,
        FIRESIDE_RELEASES_ROOT: path.join(root, 'attacker-releases'),
      },
    });
    assert.equal(pathOnly.status, 2, pathOnly.stderr);
    assert.match(pathOnly.stderr, /test overrides are disabled/);
  });

  it('全部运维脚本通过 Bash 语法检查', () => {
    for (const script of [
      'ops/fireside-release',
      'ops/install-release.sh',
      'ops/promote-release.sh',
      'ops/rollback-release.sh',
      'ops/release-lib.sh',
      'ops/release-status.sh',
      'ops/guarded-backup.sh',
    ]) {
      const result = run('bash', ['-n', path.join(projectRoot, script)]);
      assert.equal(result.status, 0, `${script}: ${result.stderr}`);
    }
  });

  it('recovery 是失败可阻断且每次开机只运行一次的依赖', async () => {
    const service = await readFile(path.join(projectRoot, 'ops/fireside.service'), 'utf8');
    const backup = await readFile(path.join(projectRoot, 'ops/fireside-backup.service'), 'utf8');
    const recovery = await readFile(path.join(projectRoot, 'ops/fireside-release-recover.service'), 'utf8');
    const runtimeGate = await readFile(path.join(projectRoot, 'ops/fireside-runtime-gate.service'), 'utf8');
    const backupGate = await readFile(path.join(projectRoot, 'ops/fireside-backup-gate.service'), 'utf8');
    assert.match(service, /^Requires=.*fireside-release-recover\.service/m);
    assert.match(service, /^After=.*fireside-release-recover\.service/m);
    assert.doesNotMatch(service, /^Wants=.*fireside-release-recover\.service/m);
    assert.match(recovery, /^Type=oneshot$/m);
    assert.match(recovery, /^RemainAfterExit=yes$/m);
    assert.match(recovery, /^Before=fireside\.service$/m);
    assert.match(backup, /^Requires=.*fireside-release-recover\.service.*fireside-backup-gate\.service/m);
    assert.match(backup, /^After=.*fireside-release-recover\.service.*fireside-backup-gate\.service/m);
    assert.match(service, /^Requires=.*fireside-runtime-gate\.service/m);
    assert.match(service, /^WorkingDirectory=-\/run\/fireside-runtime\/current$/m);
    assert.match(backup, /^WorkingDirectory=-\/run\/fireside-runtime\/current$/m);
    assert.match(runtimeGate, /^Type=oneshot$/m);
    assert.match(runtimeGate, /^ExecStart=\/usr\/local\/sbin\/fireside-release gate service$/m);
    assert.match(backupGate, /^Type=oneshot$/m);
    assert.match(backupGate, /^ExecStart=\/usr\/local\/sbin\/fireside-release gate backup$/m);
    assert.doesNotMatch(runtimeGate, /^EnvironmentFile=/m);
    assert.doesNotMatch(backupGate, /^EnvironmentFile=/m);
    assert.match(backup, /^ReadOnlyPaths=\/run$/m);
    assert.doesNotMatch(backup, /^ReadWritePaths=\/run$/m);
    assert.match(await readFile(promoteScript, 'utf8'), /systemd-notify --pid=parent --ready/);
  });
});
