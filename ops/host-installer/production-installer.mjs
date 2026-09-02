#!/usr/bin/node
import { lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  ProductionAdapter, applyProfile, planProfile, validateProfileAssets, verifyBundle,
} from './installer-core.mjs';

const fixedBundle = '/usr/local/libexec/fireside-host-installer';
const fixedEntry = '/usr/local/sbin/fireside-host-install';

for (const name of Object.keys(process.env)) {
  if (name.startsWith('FIRESIDE_HOST_INSTALL')) {
    console.error('production host installer rejects path and test overrides');
    process.exit(2);
  }
}
if (process.getuid?.() !== 0) {
  console.error('production host installer requires root');
  process.exit(2);
}
const entryStat = lstatSync(fixedEntry);
if (!entryStat.isFile() || entryStat.isSymbolicLink() || entryStat.nlink !== 1
  || entryStat.uid !== 0 || entryStat.gid !== 0 || (entryStat.mode & 0o7777) !== 0o755) {
  console.error('production dispatcher metadata is invalid');
  process.exit(2);
}

function commandExists(command, args = ['--version']) {
  const result = spawnSync(command, args, { stdio: 'ignore', env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' } });
  return result.status === 0;
}

function sensitiveMetadata(filename, mode) {
  try {
    const stat = lstatSync(filename);
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
      && stat.uid === 0 && stat.gid === 0 && (stat.mode & 0o7777) === Number.parseInt(mode, 8);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

try {
  const { definition } = verifyBundle(fixedBundle, { production: true });
  const [action, profile] = process.argv.slice(2);
  const adapter = new ProductionAdapter();
  if (action === 'check' && profile === undefined) {
    const dependencies = {
      node: commandExists('/usr/bin/node'),
      npm: commandExists('/usr/bin/npm'),
      git: commandExists('/usr/bin/git'),
      ssh: commandExists('/usr/bin/ssh', ['-V']),
      systemd: commandExists('/usr/bin/systemd-analyze', ['--version']),
      curl: commandExists('/usr/bin/curl'),
      nginx: commandExists('/usr/sbin/nginx', ['-v']),
    };
    console.log(JSON.stringify({ ok: Object.values(dependencies).every(Boolean), dependencies }));
    process.exit(Object.values(dependencies).every(Boolean) ? 0 : 1);
  }
  if (!['base', 'https-layout'].includes(profile)) throw new Error('usage: fireside-host-install {plan|apply|verify} {base|https-layout}');
  if (action === 'plan') {
    const actions = planProfile(adapter, fixedBundle, definition, profile);
    console.log(JSON.stringify({ ok: true, profile, actions: actions.map(({ type, asset, directory, account }) => ({ type, target: asset?.destination ?? directory?.destination ?? account?.name ?? null })) }));
  } else if (action === 'apply') {
    validateProfileAssets(fixedBundle, definition, profile);
    const actions = applyProfile(adapter, fixedBundle, definition, profile);
    console.log(JSON.stringify({ ok: true, profile, changed: actions.length > 0, actionCount: actions.length }));
  } else if (action === 'verify') {
    const actions = planProfile(adapter, fixedBundle, definition, profile);
    if (actions.length) throw new Error(`${profile} layout differs from the manifested installation`);
    if (profile === 'base') {
      const environmentReady = sensitiveMetadata('/etc/fireside.env', '0600');
      const deployKeyReady = sensitiveMetadata('/etc/fireside-release/github_readonly_ed25519', '0600');
      console.log(JSON.stringify({ ok: environmentReady && deployKeyReady, profile, layout: 'ready', environment: environmentReady ? 'metadata-ready' : 'missing-or-invalid', deployKey: deployKeyReady ? 'metadata-ready' : 'missing-or-invalid' }));
      process.exit(environmentReady && deployKeyReady ? 0 : 1);
    } else {
      const certificatePresent = sensitiveMetadata('/etc/fireside-tls/fullchain.pem', '0644');
      const privateKeyPresent = sensitiveMetadata('/etc/fireside-tls/privkey.pem', '0600');
      console.log(JSON.stringify({ ok: true, profile, layout: 'ready', tls: certificatePresent && privateKeyPresent ? 'materials-present-not-validated-by-layout-installer' : 'awaiting-explicit-tls-installer' }));
    }
  } else {
    throw new Error('usage: fireside-host-install {check|plan|apply|verify} [base|https-layout]');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'host installer failed');
  process.exit(2);
}
