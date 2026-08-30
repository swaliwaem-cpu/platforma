require('reflect-metadata');

const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { test, before, after } = require('node:test');
const { gzipSync } = require('node:zlib');

const {
  OfficialHtmlSourceConnector,
  SourceConnectorError,
} = require('../dist/assistant/sources/official-html-source.connector.js');
const {
  OfficialSourceExtractor,
} = require('../dist/assistant/sources/official-source.extractor.js');
const {
  AssistantSourceConnectorRegistry,
} = require('../dist/assistant/sources/assistant-source-connector.registry.js');

let server;
let origin;

before(async () => {
  server = createServer((request, response) => {
    if (request.url === '/official') {
      const body = gzipSync(Buffer.from(`<!doctype html><html><head>
        <title>ЖК Тестовый</title>
        <script type="application/ld+json">{"@type":"Product","name":"Лот 42","offers":{"price":"19000000","priceCurrency":"RUB","url":"/lots/42","availability":"https://schema.org/InStock"}}</script>
      </head><body><h1>ЖК Тестовый</h1><p>Архитектура и инфраструктура проекта.</p></body></html>`));
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-encoding': 'gzip',
        etag: '"revision-1"',
      });
      response.end(body);
      return;
    }
    if (request.url === '/content-negotiated') {
      if (String(request.headers.accept).includes('application/json')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ page: { title: 'МЫС' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html><body><h1>ЖК МЫС</h1><p>Официальный проект MR Group.</p></body></html>');
      return;
    }
    if (request.url === '/json-source') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ project: 'ЖК Тестовый', developer: 'Developer Example' }));
      return;
    }
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/official' });
      response.end();
      return;
    }
    if (request.url === '/redirect-loop') {
      response.writeHead(302, { location: '/redirect-loop' });
      response.end();
      return;
    }
    if (request.url === '/shell') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html><body><div id="app"></div><script src="/app.js"></script></body></html>');
      return;
    }
    if (request.url === '/semantic-shell') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html><body><main>Статическое описание официального каталога застройщика, которое уже длиннее минимального порога.</main><script src="/app.js"></script></body></html>');
      return;
    }
    if (request.url === '/anti-bot') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html><body><js-challenge-loader></js-challenge-loader><script src="https://servicepipe.tech/check.js"></script></body></html>');
      return;
    }
    if (request.url === '/slow') {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<html>late</html>');
      }, 150);
      return;
    }
    if (request.url === '/slow-drip') {
      response.writeHead(200, { 'content-type': 'text/html' });
      let writes = 0;
      const timer = setInterval(() => {
        if (response.destroyed) {
          clearInterval(timer);
          return;
        }
        response.write('x');
        writes += 1;
        if (writes === 20) {
          clearInterval(timer);
          response.end();
        }
      }, 10);
      response.on('close', () => clearInterval(timer));
      return;
    }
    if (request.url === '/retryable') {
      response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('temporarily unavailable');
      return;
    }
    if (request.url === '/missing') {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('missing');
      return;
    }
    if (request.url === '/unsupported') {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(Buffer.from([0, 1, 2]));
      return;
    }
    if (request.url === '/oversized') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('x'.repeat(4096));
      return;
    }
    response.writeHead(500);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  origin = `http://official.test:${address.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('Assistant T03 connector follows bounded allowlisted redirects and returns normalized immutable bytes', async () => {
  const connector = createTestConnector();
  const result = await connector.fetch(createSource('/redirect'));

  assert.equal(result.finalUrl, `${origin}/official`);
  assert.equal(result.statusCode, 200);
  assert.equal(result.contentType, 'text/html');
  assert.equal(result.etag, '"revision-1"');
  assert.match(result.payload.toString('utf8'), /ЖК Тестовый/u);
  assert.match(result.checksum, /^[0-9a-f]{64}$/u);
  assert.equal(result.redirects.length, 1);
});

test('Assistant T03 connector prefers HTML during negotiation and still accepts JSON-only sources', async () => {
  const connector = createTestConnector();

  const negotiated = await connector.fetch(createSource('/content-negotiated'));
  const json = await connector.fetch(createSource('/json-source'));

  assert.equal(negotiated.contentType, 'text/html');
  assert.match(negotiated.payload.toString('utf8'), /MR Group/u);
  assert.equal(json.contentType, 'application/json');
  assert.match(json.payload.toString('utf8'), /Developer Example/u);
});

test('Assistant T03 connector classifies timeout and retryable HTTP failures safely', async () => {
  const connector = createTestConnector({ timeoutMs: 30 });

  await assert.rejects(
    connector.fetch(createSource('/slow')),
    (error) => error instanceof SourceConnectorError
      && error.code === 'SOURCE_FETCH_TIMEOUT'
      && error.retryable === true,
  );
  await assert.rejects(
    connector.fetch(createSource('/slow-drip')),
    (error) => error instanceof SourceConnectorError
      && error.code === 'SOURCE_FETCH_TIMEOUT'
      && error.retryable === true,
  );
  await assert.rejects(
    connector.fetch(createSource('/retryable')),
    (error) => error instanceof SourceConnectorError
      && error.code === 'SOURCE_HTTP_RETRYABLE'
      && error.retryable === true
      && error.httpStatus === 503,
  );
  await assert.rejects(
    connector.fetch(createSource('/missing')),
    (error) => error instanceof SourceConnectorError
      && error.code === 'SOURCE_HTTP_NON_RETRYABLE'
      && error.retryable === false
      && error.httpStatus === 404,
  );
});

test('Assistant T03 connector bounds browser DNS by the browser deadline and preserves timeout classification', async () => {
  const connector = new OfficialHtmlSourceConnector({
    allowHttp: true,
    allowPrivateNetwork: true,
    browserFallbackEnabled: true,
    browserTimeoutMs: 1_000,
    resolveHost: async () => {
      await new Promise((resolveDelay) => {
        const timeout = setTimeout(resolveDelay, 2_000);
        timeout.unref();
      });
      return [{ address: '127.0.0.1', family: 4 }];
    },
  });
  const startedAt = Date.now();

  await assert.rejects(
    connector.renderWithBrowser(
      new URL('http://slow-browser.test/'),
      new Set(['slow-browser.test']),
      1_024,
    ),
    (error) => error instanceof SourceConnectorError
      && error.code === 'SOURCE_BROWSER_TIMEOUT'
      && error.retryable === true,
  );

  assert.ok(Date.now() - startedAt < 1_700, 'browser DNS exceeded the shared deadline');
});

test('Assistant T03 connector rejects redirect loops, unsupported content and oversized responses', async () => {
  const connector = createTestConnector({ maxResponseBytes: 1024, maxRedirects: 2 });

  await assertConnectorCode(connector.fetch(createSource('/redirect-loop')), 'SOURCE_REDIRECT_LIMIT');
  await assertConnectorCode(connector.fetch(createSource('/unsupported')), 'SOURCE_CONTENT_TYPE_UNSUPPORTED');
  await assertConnectorCode(connector.fetch(createSource('/oversized')), 'SOURCE_RESPONSE_TOO_LARGE');
});

test('Assistant T03 connector blocks private DNS results unless the explicit test-only policy is enabled', async () => {
  for (const [address, family] of [
    ['127.0.0.1', 4],
    ['0:0:0:0:0:0:0:1', 6],
    ['fec0::1', 6],
    ['64:ff9b::127.0.0.1', 6],
    ['2001::7f00:1', 6],
    ['2002:7f00:1::', 6],
    ['3fff::1', 6],
  ]) {
    const connector = new OfficialHtmlSourceConnector({
      allowHttp: true,
      resolveHost: async () => [{ address, family }],
    });
    await assert.rejects(
      connector.fetch(createSource('/official')),
      (error) => error instanceof SourceConnectorError
        && error.code === 'SOURCE_DNS_PRIVATE_ADDRESS'
        && error.retryable === false,
      address,
    );
  }
});

test('Assistant T03 connector uses a bounded browser fallback only for an empty HTML shell', async () => {
  const renderCalls = [];
  const connector = createTestConnector({
    browserFallbackEnabled: true,
    renderHtml: async (url, allowedHosts, maximumBytes) => {
      renderCalls.push({ url: url.toString(), allowedHosts: [...allowedHosts], maximumBytes });
      return Buffer.from('<html><body><main><h1>ЖК Тестовый</h1><p>Официальный проект Developer Example с содержательным описанием жилого комплекса.</p></main></body></html>');
    },
  });

  const result = await connector.fetch(createSource('/shell'));

  assert.equal(renderCalls.length, 1);
  assert.equal(renderCalls[0].url, `${origin}/shell`);
  assert.deepEqual(renderCalls[0].allowedHosts, ['official.test']);
  assert.match(result.payload.toString('utf8'), /содержательным описанием/iu);
  assert.match(result.checksum, /^[0-9a-f]{64}$/u);
});

test('Assistant T03 connector can force a bounded render for a dynamic developer catalog', async () => {
  const renderCalls = [];
  const connector = createTestConnector({
    browserFallbackEnabled: true,
    renderHtml: async (url) => {
      renderCalls.push(url.toString());
      return Buffer.from('<html><body><main>City Bay — проект из динамического официального каталога MR Group.</main></body></html>');
    },
  });
  const source = createSource('/semantic-shell');
  source.connectorConfig.browserRenderMode = 'always';

  const result = await connector.fetch(source);

  assert.deepEqual(renderCalls, [`${origin}/semantic-shell`]);
  assert.match(result.payload.toString('utf8'), /динамического официального каталога/iu);
});

test('Assistant T03 connector classifies an anti-bot page before launching Chromium', async () => {
  let renderCalls = 0;
  const connector = createTestConnector({
    browserFallbackEnabled: true,
    renderHtml: async () => {
      renderCalls += 1;
      throw new Error('must not render an anti-bot challenge');
    },
  });

  await assertConnectorCode(connector.fetch(createSource('/anti-bot')), 'SOURCE_ANTI_BOT_CHALLENGE');
  assert.equal(renderCalls, 0);
});

test('Assistant T03 extractor creates source-revision facts, searchable chunks and a direct official lot link', async () => {
  const html = await readFile(resolve(__dirname, 'fixtures/assistant/official-development.html'));
  const extractor = new OfficialSourceExtractor();
  const extracted = extractor.extract({
    source: {
      id: '00000000-0000-4000-8000-000000000001',
      type: 'DEVELOPMENT_PAGE',
      canonicalUrl: 'https://developer.example/projects/severny-sad',
      projectKey: 'severny-sad',
      developerKey: 'developer-example',
      priority: 100,
      connectorConfig: {},
    },
    revisionId: '00000000-0000-4000-8000-000000000002',
    fetchedAt: new Date('2026-08-25T08:00:00.000Z'),
    contentType: 'text/html',
    payload: html,
  });

  assert.equal(extracted.facts.some((fact) => fact.kind === 'STATIC_DESCRIPTION'), true);
  assert.equal(extracted.facts.some((fact) => fact.kind === 'ARCHITECTURE'), true);
  assert.equal(extracted.facts.some((fact) => fact.kind === 'INFRASTRUCTURE'), true);
  assert.equal(extracted.facts.some((fact) => fact.kind === 'PROMOTION'), true);
  const lot = extracted.facts.find((fact) => fact.kind === 'EXTERNAL_LOT');
  assert.deepEqual(lot?.value, {
    title: '2-комнатная квартира 67 м²',
    priceRub: 23900000,
    availability: 'AVAILABLE',
    rooms: 2,
    area: 67,
    floor: 8,
    href: 'https://developer.example/apartments/lot-42',
  });
  const architecture = extracted.facts.find((fact) => fact.kind === 'ARCHITECTURE');
  assert.match(String(architecture?.value), /Кирпичные фасады/iu);
  assert.doesNotMatch(String(architecture?.value), /Закрытый двор/iu);
  assert.equal(extracted.chunks.length > 0, true);
  assert.equal(extracted.chunks.every((chunk) => chunk.sourceRevisionId.endsWith('0002')), true);
  assert.equal(extracted.chunks.every((chunk) => /^[0-9a-f]{64}$/u.test(chunk.contentHash)), true);
  assert.equal(extracted.chunks.some((chunk) => chunk.text.includes('privateRuntimeState')), false);
});

test('Assistant T03 extractor fails closed on malformed JSON without leaking synthetic facts', () => {
  const extracted = new OfficialSourceExtractor().extract({
    source: {
      id: '00000000-0000-4000-8000-000000000001',
      type: 'DEVELOPMENT_PAGE',
      canonicalUrl: 'https://developer.example/projects/severny-sad',
      projectKey: 'severny-sad',
      developerKey: 'developer-example',
      priority: 100,
      connectorConfig: {},
    },
    revisionId: '00000000-0000-4000-8000-000000000002',
    fetchedAt: new Date('2026-08-25T08:00:00.000Z'),
    contentType: 'application/json',
    payload: Buffer.from('{"broken":'),
  });

  assert.deepEqual(extracted, { facts: [], chunks: [] });
});

test('Assistant T03 connector registry exposes aggregator entry points but keeps production parsers disabled', () => {
  const registry = new AssistantSourceConnectorRegistry(createTestConnector());

  assert.deepEqual(registry.list().map(({ key, enabled }) => [key, enabled]), [
    ['OFFICIAL_HTML', true],
    ['CIAN', false],
    ['DOMCLICK', false],
    ['YANDEX_REALTY', false],
    ['NOVOSTROY_M', false],
  ]);
  assert.throws(
    () => registry.get('CIAN'),
    (error) => error instanceof SourceConnectorError && error.code === 'SOURCE_CONNECTOR_DISABLED',
  );
});

test('Assistant T03 connector registry serves deterministic current-fact fixtures without live fetches', async () => {
  let liveFetchCalls = 0;
  const registry = new AssistantSourceConnectorRegistry({
    async fetch() {
      liveFetchCalls += 1;
      throw new Error('live connector must not run');
    },
  }, {
    NODE_ENV: 'test',
    DEPLOYMENT_ENV: 'local',
    ASSISTANT_EXTERNAL_CONNECTORS_ENABLED: 'false',
    ASSISTANT_CURRENT_FACT_REFRESH_MODE: 'fixture',
  });
  const source = {
    id: '00000000-0000-4000-8000-000000000011',
    canonicalUrl: 'https://developer.example/projects/severny-sad',
    connectorKey: 'OFFICIAL_HTML',
    connectorConfig: {
      allowedHosts: ['developer.example'],
      offlineFixture: {
        version: 'assistant-current-fact-fixture-v1',
        title: 'ЖК Северный сад',
        promotions: [{
          label: 'Ипотечная программа',
          value: 'Первоначальный взнос 23%.',
        }],
      },
    },
  };

  const fetched = await registry.get('OFFICIAL_HTML').fetch(source);

  assert.equal(liveFetchCalls, 0);
  assert.equal(fetched.finalUrl, source.canonicalUrl);
  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.contentType, 'text/html; charset=utf-8');
  assert.match(fetched.payload.toString('utf8'), /Ипотечная программа/u);
  assert.match(fetched.checksum, /^[0-9a-f]{64}$/u);

  const extracted = new OfficialSourceExtractor().extract({
    source: {
      ...source,
      type: 'DEVELOPMENT_PAGE',
      projectKey: 'severny-sad',
      developerKey: 'developer-example',
      priority: 100,
    },
    revisionId: '00000000-0000-4000-8000-000000000012',
    fetchedAt: new Date('2026-08-30T10:00:00.000Z'),
    contentType: fetched.contentType,
    payload: fetched.payload,
  });
  assert.equal(extracted.facts.some(({ kind }) => kind === 'PROMOTION'), true);
});

function createTestConnector(overrides = {}) {
  return new OfficialHtmlSourceConnector({
    allowHttp: true,
    allowPrivateNetwork: true,
    timeoutMs: 500,
    maxResponseBytes: 64 * 1024,
    maxRedirects: 3,
    resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
    ...overrides,
  });
}

function createSource(path) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    canonicalUrl: `${origin}${path}`,
    connectorKey: 'OFFICIAL_HTML',
    connectorConfig: { allowedHosts: ['official.test'] },
  };
}

async function assertConnectorCode(promise, expectedCode) {
  await assert.rejects(
    promise,
    (error) => error instanceof SourceConnectorError && error.code === expectedCode,
  );
}
