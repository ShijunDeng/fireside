import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const projectRoot = process.cwd();
const nginxTemplate = path.join(projectRoot, 'ops/fireside-https.nginx.conf');
const serviceTemplate = path.join(projectRoot, 'ops/fireside-https.service');

describe('独立 HTTPS 入口', () => {
  it('只监听 443、固定回环 upstream，且不加载系统站点', async () => {
    const config = await readFile(nginxTemplate, 'utf8');

    assert.match(config, /listen 0\.0\.0\.0:443 ssl http2;/);
    assert.match(config, /listen \[::\]:443 ssl http2;/);
    assert.doesNotMatch(config, /listen\s+(?:[^;]*:)?80(?:\s|;)/);
    assert.doesNotMatch(config, /^\s*include\s+\/etc\/nginx\//m);
    assert.doesNotMatch(config, /^\s*include\s+.*(?:sites-enabled|conf\.d\/)/m);
    assert.match(config, /server_name firesidechat\.cn www\.firesidechat\.cn;/);
    assert.match(config, /if \(\$host = www\.firesidechat\.cn\)[\s\S]*return 308 https:\/\/firesidechat\.cn\$request_uri;/);
    assert.match(config, /if \(\$host != firesidechat\.cn\)/);
    assert.doesNotMatch(config, /server_name fireside\.show;/);
    assert.match(config, /proxy_pass http:\/\/127\.0\.0\.1:80;/);
    assert.match(config, /ssl_protocols TLSv1\.2 TLSv1\.3;/);
    assert.doesNotMatch(config, /ssl_protocols[^;]*(?:TLSv1(?:\s|;)|TLSv1\.1)/);
    assert.match(config, /access_log off;/);
    assert.doesNotMatch(config, /access_log\s+\/dev\/(?:stdout|stderr)/);
    assert.match(config, /proxy_request_buffering off;/);
    assert.match(config, /proxy_set_header X-Forwarded-For \$remote_addr;/);
  });

  it('通过 systemd credential 向非 root Nginx 提供 root-only 密钥', async () => {
    const service = await readFile(serviceTemplate, 'utf8');
    const config = await readFile(nginxTemplate, 'utf8');

    assert.match(service, /^User=www-data$/m);
    assert.match(service, /^Group=www-data$/m);
    assert.match(service, /^LoadCredential=fullchain\.pem:\/etc\/fireside-tls\/fullchain\.pem$/m);
    assert.match(service, /^LoadCredential=privkey\.pem:\/etc\/fireside-tls\/privkey\.pem$/m);
    assert.match(service, /^AmbientCapabilities=CAP_NET_BIND_SERVICE$/m);
    assert.match(service, /^CapabilityBoundingSet=CAP_NET_BIND_SERVICE$/m);
    assert.match(service, /^NoNewPrivileges=true$/m);
    assert.match(service, /^ProtectSystem=strict$/m);
    assert.match(service, /^ProtectHome=true$/m);
    assert.match(service, /^PrivateDevices=true$/m);
    assert.match(config, /ssl_certificate \/run\/credentials\/fireside-https\.service\/fullchain\.pem;/);
    assert.match(config, /ssl_certificate_key \/run\/credentials\/fireside-https\.service\/privkey\.pem;/);
    assert.doesNotMatch(config, /\/etc\/fireside-tls\/privkey\.pem/);
  });

  it('可用临时证书通过真实 nginx 配置语法检查', async (context) => {
    const nginx = spawnSync('nginx', ['-v'], { encoding: 'utf8' });
    if (nginx.error || nginx.status !== 0) {
      context.skip('nginx is not installed in this environment');
      return;
    }

    const fixture = await mkdtemp(path.join(tmpdir(), 'fireside-https-nginx-'));
    const key = path.join(fixture, 'key.pem');
    const certificate = path.join(fixture, 'fullchain.pem');
    const configPath = path.join(fixture, 'nginx.conf');
    await chmod(fixture, 0o700);
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-batch',
      '-subj', '/CN=firesidechat.cn', '-addext', 'subjectAltName=DNS:firesidechat.cn',
      '-days', '1', '-keyout', key, '-out', certificate,
    ], { stdio: 'ignore' });
    await chmod(key, 0o600);

    const template = await readFile(nginxTemplate, 'utf8');
    const rendered = template
      .replace('pid /run/fireside-https/nginx.pid;', `pid ${fixture}/nginx.pid;`)
      .replace('listen 0.0.0.0:443 ssl http2;', 'listen 127.0.0.1:18443 ssl http2;')
      .replace('listen [::]:443 ssl http2;', '')
      .replace('/run/credentials/fireside-https.service/fullchain.pem', certificate)
      .replace('/run/credentials/fireside-https.service/privkey.pem', key);
    await writeFile(configPath, rendered, { mode: 0o600 });

    const syntax = spawnSync('nginx', ['-t', '-c', configPath], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, `${syntax.stdout}\n${syntax.stderr}`);
  });
});
