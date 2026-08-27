require('reflect-metadata');

const assert = require('node:assert/strict');
const { createServer } = require('node:http');

const {
  OfficialHtmlSourceConnector,
} = require('../dist/assistant/sources/official-html-source.connector.js');

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const executablePath = process.env.ASSISTANT_SOURCE_BROWSER_EXECUTABLE_PATH;
  assert.ok(executablePath, 'ASSISTANT_SOURCE_BROWSER_EXECUTABLE_PATH is required');

  const server = createServer((request, response) => {
    if (request.url === '/catalog') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end([
        '<!doctype html><html><body>',
        '<main>Официальный каталог проектов проверяемого застройщика с содержательным статическим описанием.</main>',
        '<div id="projects"></div><script src="/catalog.js"></script>',
        '</body></html>',
      ].join(''));
      return;
    }
    if (request.url === '/catalog.js') {
      response.writeHead(200, { 'content-type': 'application/javascript' });
      response.end("fetch('/projects.json').then((response) => response.json()).then((data) => { document.querySelector('#projects').textContent = data.items.map((item) => item.name).join(' | '); });");
      return;
    }
    if (request.url === '/projects.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ items: [{ name: 'City Bay', code: 'zhk-citybay' }] }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');

  const connector = new OfficialHtmlSourceConnector({
    allowHttp: true,
    allowPrivateNetwork: true,
    browserFallbackEnabled: true,
    browserExecutablePath: executablePath,
    browserTimeoutMs: 15_000,
    resolveHost: async (hostname) => {
      if (hostname === 'catalog.test') return [{ address: '127.0.0.1', family: 4 }];
      throw new Error('optional host does not resolve');
    },
  });

  try {
    const result = await connector.fetch({
      id: '00000000-0000-4000-8000-000000000001',
      canonicalUrl: `http://catalog.test:${address.port}/catalog`,
      connectorKey: 'OFFICIAL_HTML',
      connectorConfig: {
        allowedHosts: ['catalog.test', 'www.catalog.test'],
        browserRenderMode: 'always',
      },
    });
    const html = result.payload.toString('utf8');
    assert.match(html, /City Bay/u);
    assert.match(html, /zhk-citybay/u);
    assert.match(html, /data-platforma-source-url=/u);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  process.stdout.write('ASSISTANT_T03_BROWSER_RUNTIME_OK\n');
}
