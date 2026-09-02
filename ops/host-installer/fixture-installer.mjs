#!/usr/bin/env node
import path from 'node:path';
import {
  FixtureAdapter, applyProfile, planProfile, validateProfileAssets, verifyBundle,
} from './installer-core.mjs';

const args = process.argv.slice(2);
let bundle = '';
let root = '';
let failAfter = 0;
while (args[0]?.startsWith('--')) {
  const option = args.shift();
  const value = args.shift();
  if (option === '--bundle') bundle = path.resolve(value ?? '');
  else if (option === '--root') root = path.resolve(value ?? '');
  else if (option === '--fail-after') failAfter = Number(value);
  else throw new Error(`unknown fixture option: ${option}`);
}
const [action, profile] = args;
if (!bundle || !root || !['plan', 'apply', 'verify'].includes(action) || !['base', 'https-layout'].includes(profile)) {
  console.error('usage: fixture-installer.mjs --bundle DIR --root DIR [--fail-after N] {plan|apply|verify} {base|https-layout}');
  process.exit(2);
}
try {
  const { definition } = verifyBundle(bundle);
  const adapter = new FixtureAdapter(root);
  if (action === 'plan') {
    const actions = planProfile(adapter, bundle, definition, profile);
    console.log(JSON.stringify({ ok: true, profile, actions: actions.map(({ type, asset, directory, account }) => ({ type, target: asset?.destination ?? directory?.destination ?? account?.name ?? null })) }));
  } else if (action === 'apply') {
    validateProfileAssets(bundle, definition, profile);
    const actions = applyProfile(adapter, bundle, definition, profile, { failAfter });
    console.log(JSON.stringify({ ok: true, profile, changed: actions.length > 0, actionCount: actions.length }));
  } else {
    const actions = planProfile(adapter, bundle, definition, profile);
    console.log(JSON.stringify({ ok: actions.length === 0, profile, pendingActions: actions.length }));
    process.exit(actions.length === 0 ? 0 : 1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'fixture installer failed');
  process.exit(2);
}
