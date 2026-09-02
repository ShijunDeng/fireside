import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const projectRoot = process.cwd();
const dispatcherPath = path.join(projectRoot, 'ops/tls-installer/dispatcher.sh');
const installerPath = path.join(projectRoot, 'ops/tls-installer/install.sh');

describe('TLS 材料安装器', () => {
  it('脚本语法有效且生产入口固定', async () => {
    for (const filename of [dispatcherPath, installerPath]) {
      const syntax = spawnSync('bash', ['-n', filename], { encoding: 'utf8' });
      assert.equal(syntax.status, 0, syntax.stderr);
    }
    const dispatcher = await readFile(dispatcherPath, 'utf8');
    assert.match(dispatcher, /expected_entry=\/usr\/local\/sbin\/fireside-tls-install/);
    assert.match(dispatcher, /\/usr\/local\/libexec\/fireside-tls-installer\/install\.sh/);
    assert.match(dispatcher, /flock -E 75 -x -n/);
  });

  it('只安装新域名且完整校验证书、密钥和失败回滚', async () => {
    const installer = await readFile(installerPath, 'utf8');
    assert.match(installer, /readonly domain=firesidechat\.cn/);
    assert.doesNotMatch(installer, /readonly domain=fireside\.show/);
    assert.match(installer, /openssl x509[^\n]+-checkhost "\$\{domain\}"/);
    assert.match(installer, /openssl verify[^\n]+-purpose sslserver/);
    assert.match(installer, /openssl pkey[^\n]+-noout -check/);
    assert.match(installer, /cmp -s "\$\{work\}\/certificate\.pub" "\$\{work\}\/private-key\.pub"/);
    assert.match(installer, /private key source mode must be 0600/);
    assert.match(installer, /mv -fT[^\n]+fullchain\.pem/);
    assert.match(installer, /rollback\(\)/);
    assert.match(installer, /for _attempt in 1 2 3 4 5 6 7 8 9 10/);
    assert.match(installer, /curl --fail --silent --max-time 3/);
    assert.match(installer, /sleep 0\.5/);
    assert.doesNotMatch(installer, /cat\s+.*private/i);
  });
});
