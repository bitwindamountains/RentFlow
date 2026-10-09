// Runs the shipped Caddyfile against disposable files and a loopback upstream.
// Set CADDY_PATH when the Caddy executable is not on PATH.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

const binary = process.env.CADDY_PATH || 'caddy';
let scratch, upstream, proxy, base;
let logs = '';

async function listen(server) {
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return server.address().port;
}
const close = server => new Promise((done, reject) => server.close(error => error ? reject(error) : done()));

before(async () => {
  console.log(execFileSync(binary, ['version'], { encoding: 'utf8', windowsHide: true }).trim());
  scratch = await mkdtemp(join(tmpdir(), 'rentflow-proxy-test-'));
  const files = join(scratch, 'web');
  await mkdir(files);
  for (const [name, body] of Object.entries({
    'index.html': '<!doctype html><app-root>Proxy fixture</app-root>',
    'main-ABCDEFGH.js': 'console.log("fixture");',
    'styles-ABCDEFGH.css': 'body{margin:0}',
    'ngsw.json': '{"configVersion":1}',
    'ngsw-worker.js': '// service worker fixture',
    'manifest.webmanifest': '{"name":"RentFlow"}',
  })) await writeFile(join(files, name), body);
  upstream = createServer((request, response) => {
    response.writeHead(request.url === '/api/v1/missing' ? 404 : 200, {
      'content-type': 'application/json',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'no-store',
      'set-cookie': '__Host-rentflow_session=fixture; Path=/; Secure; HttpOnly; SameSite=Strict',
    });
    response.end(JSON.stringify({ path: request.url, forwardedFor: request.headers['x-forwarded-for'], requestId: request.headers['x-request-id'] }));
  });
  const upstreamPort = await listen(upstream);
  const socket = createSocketServer();
  const port = await listen(socket);
  await close(socket);
  base = `http://127.0.0.1:${port}`;
  // The production root is the only substitution. All routing/header directives are tested as shipped.
  const config = (await readFile(new URL('./Caddyfile', import.meta.url), 'utf8'))
    .replace('root * /srv', `root * "${files.replaceAll('\\', '/')}"`);
  const configPath = join(scratch, 'Caddyfile');
  await writeFile(configPath, `{\n admin off\n auto_https off\n persist_config off\n}\n${config}`);
  proxy = spawn(binary, ['run', '--config', configPath, '--adapter', 'caddyfile'], {
    env: { ...process.env, SITE_ADDRESS: base, API_UPSTREAM: `127.0.0.1:${upstreamPort}` },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  proxy.stdout.on('data', chunk => { logs = (logs + chunk).slice(-8000); });
  proxy.stderr.on('data', chunk => { logs = (logs + chunk).slice(-8000); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (proxy.exitCode !== null) throw new Error(`Caddy exited: ${logs}`);
    try { await fetch(base, { signal: AbortSignal.timeout(1000) }); return; } catch {}
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`Caddy did not start: ${logs}`);
});

after(async () => {
  if (proxy && proxy.exitCode === null) {
    const exited = new Promise(done => proxy.once('exit', done));
    proxy.kill();
    await exited;
  }
  if (upstream?.listening) await close(upstream);
  if (scratch) {
    assert.equal(dirname(resolve(scratch)), resolve(tmpdir()));
    assert.ok(basename(scratch).startsWith('rentflow-proxy-test-'));
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test('HTML and deep links revalidate and carry the web security policy', async () => {
  for (const path of ['/', '/index.html', '/tenants', '/portal/payments']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-cache', path);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(response.headers.get('server'), null);
    assert.match(await response.text(), /<app-root>/);
  }
});

test('existing hashed bundles cache immutably', async () => {
  for (const path of ['/main-ABCDEFGH.js', '/styles-ABCDEFGH.css']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.doesNotMatch(response.headers.get('content-type'), /text\/html/);
  }
});

test('missing assets return 404 instead of cacheable application HTML', async () => {
  for (const path of ['/missing-ABCDEFGH.js', '/missing.css', '/icons/missing.png']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(response.headers.get('cache-control') ?? '', /immutable/);
    assert.doesNotMatch(await response.text(), /<app-root>/);
  }
});

test('service worker and manifest files revalidate', async () => {
  for (const path of ['/ngsw.json', '/ngsw-worker.js', '/manifest.webmanifest']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
  }
});

test('the proxy preserves API security, private caching, cookies and error status', async () => {
  for (const path of ['/api/v1/private-file', '/api/v1/missing']) {
    const response = await fetch(base + path, { headers: { 'x-forwarded-for': '203.0.113.1', 'x-request-id': 'spoofed-request' } });
    assert.equal(response.status, path.endsWith('/missing') ? 404 : 200);
    assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Strict/);
    const data = await response.json();
    assert.equal(data.path, path);
    assert.equal(data.forwardedFor, '127.0.0.1');
    assert.match(data.requestId, /^[0-9a-f-]{36}$/);
  }
});
