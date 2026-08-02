require('reflect-metadata');

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const https = require('node:https');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Readable } = require('node:stream');
const { promisify } = require('node:util');
const { after, before, test } = require('node:test');

const { TrainingMaterialExtractionService } = require('../dist/training/training-material-extraction.js');
const {
  createPinnedLookup,
  isAllowedTrainingBrowserRequest,
  isPublicIpAddress,
  TrainingUrlExtractor,
  validateTrainingOfficialUrl,
} = require('../dist/training/training-url-extractor.js');

let server;
let fixturePort;
let fixtureTempDir;

before(async () => {
  fixtureTempDir = await mkdtemp(join(tmpdir(), 'platforma-stage4-url-'));
  const keyPath = join(fixtureTempDir, 'key.pem');
  const certificatePath = join(fixtureTempDir, 'certificate.pem');
  await promisify(execFile)('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certificatePath,
    '-subj', '/CN=fixture.test', '-days', '1',
  ]);
  server = https.createServer({
    key: await readFile(keyPath),
    cert: await readFile(certificatePath),
  }, (request, response) => {
    const path = new URL(request.url, 'http://fixture.test').pathname;
    if (path === '/valid') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        ETag: '"fixture-v1"',
        'Last-Modified': 'Sat, 02 Aug 2026 10:00:00 GMT',
      });
      response.end([
        '<header>Техническая шапка</header>',
        '<nav>Навигация</nav>',
        '<aside class="cookie-banner">Cookie banner</aside>',
        '<main><h1>Официальный проект</h1>',
        '<p>Описание проекта содержит достаточно стабильного текста для проверки обычного HTTP extraction.</p>',
        '<ul><li>Пять минут до метро</li></ul>',
        '<table><tr><td>Высота потолков</td><td>3 метра</td></tr></table></main>',
      ].join(''));
      return;
    }
    if (path === '/wrong-type') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
      return;
    }
    if (path === '/oversized') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(`<main><p>${'x'.repeat(2_000_001)}</p></main>`);
      return;
    }
    if (path === '/redirect') {
      response.writeHead(302, { Location: 'https://redirected.test/valid' });
      response.end();
      return;
    }
    if (path.startsWith('/loop/')) {
      const count = Number(path.split('/').pop());
      response.writeHead(302, { Location: `https://fixture.test/loop/${count + 1}` });
      response.end();
      return;
    }
    if (path === '/downgrade') {
      response.writeHead(302, { Location: 'http://fixture.test/valid' });
      response.end();
      return;
    }
    if (path === '/private-redirect') {
      response.writeHead(302, { Location: 'https://2130706433/private' });
      response.end();
      return;
    }
    if (path === '/timeout') {
      setTimeout(() => {
        if (!response.destroyed) {
          response.writeHead(200, { 'Content-Type': 'text/html' });
          response.end('<main><p>late</p></main>');
        }
      }, 1_500);
      return;
    }
    if (path === '/stalled-body') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.write('<main><p>partial');
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fixturePort = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(fixtureTempDir, { recursive: true, force: true });
});

test('local fixture covers semantic HTML, metadata, redirect and final URL without external websites', async () => {
  const extractor = new TrainingUrlExtractor(new TrainingMaterialExtractionService());
  const result = await extractor.extract('https://fixture.test/redirect', dependencies());

  assert.equal(result.finalUrl, 'https://redirected.test/valid');
  assert.equal(result.metadata.method, 'HTTP');
  assert.equal(result.metadata.redirectCount, 1);
  assert.equal(result.metadata.etag, '"fixture-v1"');
  assert.equal(result.metadata.lastModified, 'Sat, 02 Aug 2026 10:00:00 GMT');
  assert.match(result.text, /Официальный проект/u);
  assert.match(result.text, /Пять минут до метро/u);
  assert.match(result.text, /Высота потолков/u);
  assert.doesNotMatch(result.text, /Техническая шапка|Навигация|Cookie banner/u);
  assert.ok(result.segments.every((segment) => segment.label && segment.locator.startsWith('html:')));
});

test('validated DNS addresses are passed to the HTTPS transport for connection pinning', async () => {
  const extractor = new TrainingUrlExtractor(new TrainingMaterialExtractionService());
  let observedAddresses;
  const result = await extractor.extract('https://fixture.test/valid', {
    resolveHost: async () => ['93.184.216.34', '2606:4700:4700::1111'],
    fetchImpl: async (_url, _options, pinnedAddresses) => {
      observedAddresses = [...pinnedAddresses];
      return new Response(
        '<main><h1>Pinned transport</h1><p>Достаточный стабильный текст локальной транспортной fixture подтверждает передачу заранее проверенных DNS-адресов без обращения к внешнему сайту.</p></main>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    },
  });

  assert.deepEqual(observedAddresses, ['93.184.216.34', '2606:4700:4700::1111']);
  assert.equal(result.metadata.method, 'HTTP');
});

test('pinned lookup supports Node single-address and all-address callback modes', async () => {
  const lookup = createPinnedLookup('93.184.216.34');
  const single = await runPinnedLookup(lookup, { all: false });
  const all = await runPinnedLookup(lookup, { all: true });

  assert.equal(single.address, '93.184.216.34');
  assert.equal(single.family, 4);
  assert.deepEqual(all.address, [{ address: '93.184.216.34', family: 4 }]);
  assert.equal(all.family, undefined);
});

test('non-timeout transport failures keep a distinct safe error code', async () => {
  const extractor = new TrainingUrlExtractor(new TrainingMaterialExtractionService());
  await assert.rejects(
    () => extractor.extract('https://fixture.test/valid', {
      resolveHost: async () => ['93.184.216.34'],
      fetchImpl: async () => { throw new Error('synthetic socket failure'); },
    }),
    /URL_FETCH_FAILED/,
  );
});

test('URL extraction rejects bounded response, wrong type, timeout and unsafe redirects', async () => {
  const extractor = new TrainingUrlExtractor(new TrainingMaterialExtractionService());
  await assert.rejects(
    () => extractor.extract('https://fixture.test/oversized', dependencies()),
    /URL_RESPONSE_TOO_LARGE/,
  );
  await assert.rejects(
    () => extractor.extract('https://fixture.test/wrong-type', dependencies()),
    /URL_CONTENT_TYPE_INVALID/,
  );
  await assert.rejects(
    () => extractor.extract('https://fixture.test/loop/0', dependencies()),
    /URL_REDIRECT_LIMIT/,
  );
  await assert.rejects(
    () => extractor.extract('https://fixture.test/downgrade', dependencies()),
    /URL_NOT_ALLOWED/,
  );
  await assert.rejects(
    () => extractor.extract('https://fixture.test/private-redirect', dependencies()),
    /URL_HOST_NOT_PUBLIC/,
  );

  const previous = process.env.TRAINING_MATERIAL_EXTRACTION_TIMEOUT_MS;
  process.env.TRAINING_MATERIAL_EXTRACTION_TIMEOUT_MS = '1000';
  await assert.rejects(
    () => extractor.extract('https://fixture.test/timeout', dependencies()),
    /URL_FETCH_TIMEOUT/,
  );
  await assert.rejects(
    () => extractor.extract('https://fixture.test/stalled-body', dependencies()),
    /URL_FETCH_TIMEOUT/,
  );
  if (previous === undefined) delete process.env.TRAINING_MATERIAL_EXTRACTION_TIMEOUT_MS;
  else process.env.TRAINING_MATERIAL_EXTRACTION_TIMEOUT_MS = previous;
});

test('URL and browser policies reject credentials, ports, local/private/mapped addresses and third-party resources', async () => {
  const publicResolver = async () => ['93.184.216.34'];
  await assert.rejects(() => validateTrainingOfficialUrl('https://user:pass@fixture.test/', publicResolver), /URL_NOT_ALLOWED/);
  await assert.rejects(() => validateTrainingOfficialUrl('https://fixture.test:444/', publicResolver), /URL_NOT_ALLOWED/);
  await assert.rejects(() => validateTrainingOfficialUrl('https://fixture.test/#section', publicResolver), /URL_NOT_ALLOWED/);
  await assert.rejects(() => validateTrainingOfficialUrl('https://localhost/', async () => ['127.0.0.1']), /URL_HOST_NOT_PUBLIC/);
  await assert.rejects(() => validateTrainingOfficialUrl('https://mixed.test/', async () => ['93.184.216.34', '10.0.0.1']), /URL_HOST_NOT_PUBLIC/);
  assert.equal(isPublicIpAddress('::ffff:7f00:1'), false);
  assert.equal(isPublicIpAddress('::ffff:c0a8:101'), false);
  assert.equal(isPublicIpAddress('2001:db8::1'), false);
  assert.equal(isPublicIpAddress('2606:4700:4700::1111'), true);

  const initial = new URL('https://fixture.test/page');
  assert.equal(await isAllowedTrainingBrowserRequest(initial, 'https://fixture.test/app.js', 'script', publicResolver), true);
  assert.equal(await isAllowedTrainingBrowserRequest(initial, 'https://fixture.test/page', 'document', publicResolver, 'POST', true, true), false);
  assert.equal(await isAllowedTrainingBrowserRequest(initial, 'https://fixture.test/other', 'document', publicResolver, 'GET', true, true), false);
  assert.equal(await isAllowedTrainingBrowserRequest(initial, 'https://fixture.test/page', 'document', publicResolver, 'GET', true, false), false);
  assert.equal(await isAllowedTrainingBrowserRequest(initial, 'https://analytics.test/a.js', 'script', publicResolver), false);
  assert.equal(await isAllowedTrainingBrowserRequest(initial, 'https://fixture.test/image.png', 'image', publicResolver), false);
  assert.equal(await isAllowedTrainingBrowserRequest(initial, 'wss://fixture.test/socket', 'websocket', publicResolver), false);
  assert.equal(await isAllowedTrainingBrowserRequest(
    initial,
    'https://fixture.test/private.js',
    'script',
    async () => ['169.254.169.254'],
  ), false);
});

function dependencies() {
  return {
    resolveHost: async (hostname) => hostname === '2130706433' || hostname === '127.0.0.1'
      ? ['127.0.0.1']
      : ['93.184.216.34'],
    fetchImpl: fetchLocalHttpsFixture,
  };
}

function fetchLocalHttpsFixture(url, options = {}) {
  return new Promise((resolve, reject) => {
    const requested = new URL(url);
    const request = https.request({
      hostname: '127.0.0.1',
      port: fixturePort,
      path: `${requested.pathname}${requested.search}`,
      method: options.method ?? 'GET',
      headers: options.headers,
      rejectUnauthorized: false,
      signal: options.signal,
    }, (response) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }
      resolve(new Response(Readable.toWeb(response), {
        status: response.statusCode,
        headers,
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

function runPinnedLookup(lookup, options) {
  return new Promise((resolve, reject) => {
    lookup('fixture.test', options, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
}
