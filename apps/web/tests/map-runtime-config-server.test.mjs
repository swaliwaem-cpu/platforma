import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(currentDir, '..');

test('static web server exposes map provider settings through no-cache runtime JavaScript', async (context) => {
  const port = await startWebServer(context, {
    MAP_PROVIDER_ENABLED: 'false',
    MAP_STYLE_URL: 'https://maps.example.test/styles/platforma.json',
  });

  const response = await fetch(`http://127.0.0.1:${port}/runtime-config.js`);
  const source = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type') ?? '', /^text\/javascript/);
  assert.equal(
    source,
    'window.__PLATFORMA_RUNTIME_CONFIG__ = {"mapProviderEnabled":"false","mapStyleUrl":"https://maps.example.test/styles/platforma.json"};\n',
  );

  const headResponse = await fetch(`http://127.0.0.1:${port}/runtime-config.js`, { method: 'HEAD' });

  assert.equal(headResponse.status, 200);
  assert.equal(await headResponse.text(), '');
});

test('static web server negotiates compression for cacheable JavaScript assets', async (context) => {
  const assetName = `compression-fixture-${process.pid}-${Date.now()}.js`;
  const assetDir = resolve(webRoot, 'dist/assets');
  const assetPath = resolve(assetDir, assetName);
  const assetSource = `globalThis.__compressionFixture = ${JSON.stringify('maplibre-vector-tile-'.repeat(1_024))};\n`;

  await mkdir(assetDir, { recursive: true });
  await writeFile(assetPath, assetSource);
  context.after(() => rm(assetPath, { force: true }));

  const port = await startWebServer(context);
  const assetUrl = `http://127.0.0.1:${port}/assets/${assetName}`;

  const brotliResponse = await fetch(assetUrl, {
    headers: { 'Accept-Encoding': 'br, gzip;q=0.8' },
  });

  assert.equal(brotliResponse.status, 200);
  assert.equal(brotliResponse.headers.get('content-encoding'), 'br');
  assert.match(brotliResponse.headers.get('vary') ?? '', /Accept-Encoding/i);
  assert.equal(brotliResponse.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(brotliResponse.headers.get('content-length'), null);
  assert.equal(await brotliResponse.text(), assetSource);

  const gzipResponse = await fetch(assetUrl, {
    headers: { 'Accept-Encoding': 'gzip, br;q=0' },
  });

  assert.equal(gzipResponse.headers.get('content-encoding'), 'gzip');
  assert.equal(await gzipResponse.text(), assetSource);

  const identityResponse = await fetch(assetUrl, {
    headers: { 'Accept-Encoding': 'identity' },
  });

  assert.equal(identityResponse.headers.get('content-encoding'), null);
  assert.equal(identityResponse.headers.get('content-length'), String(Buffer.byteLength(assetSource)));
  assert.equal(await identityResponse.text(), assetSource);

  const headResponse = await fetch(assetUrl, {
    method: 'HEAD',
    headers: { 'Accept-Encoding': 'br' },
  });

  assert.equal(headResponse.headers.get('content-encoding'), 'br');
  assert.equal(await headResponse.text(), '');
});

async function startWebServer(context, environment = {}) {
  const port = await getFreePort();
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: webRoot,
    env: {
      ...process.env,
      ...environment,
      HOST: '127.0.0.1',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  context.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  });

  await waitForServer(child);
  return port;
}

async function getFreePort() {
  const server = createServer();

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();

  assert.ok(address && typeof address === 'object');
  server.close();
  await once(server, 'close');

  return address.port;
}

async function waitForServer(child) {
  let output = '';

  await new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error(`Web server did not become ready: ${output}`)), 10_000);

    child.stdout.on('data', (chunk) => {
      output += chunk.toString();

      if (output.includes('web static server listening')) {
        clearTimeout(timeout);
        resolveReady();
      }
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      rejectReady(new Error(`Web server exited before readiness with code ${code}: ${output}`));
    });
  });
}
