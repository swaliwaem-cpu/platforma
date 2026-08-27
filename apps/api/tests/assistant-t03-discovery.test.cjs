require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');

const {
  AssistantSourceDiscoveryService,
} = require('../dist/assistant/sources/assistant-source-discovery.service.js');
const {
  createDeveloperDiscoveryRequestBody,
} = require('../dist/assistant/sources/assistant-source-discovery-provider.js');
const {
  estimateAssistantAiCallCost,
} = require('../dist/assistant/operations/assistant-ai-cost.js');
const {
  SourceConnectorError,
} = require('../dist/assistant/sources/official-html-source.connector.js');
const {
  buildKnownProjectUrls,
} = require('../dist/assistant/sources/assistant-source-discovery-policy.js');
const {
  relatedHosts,
} = require('../dist/assistant/sources/assistant-source-discovery-identity.js');

const project = {
  projectKey: 'zhiloj-kompleks-amber-city',
  title: 'ЖК Amber City (Эмбер сити)',
  developerKey: 'fsk',
  developerName: 'ФСК',
  address: 'Москва, Шелепихинская набережная, дом 34',
};

test('Assistant source discovery reuses an active indexed project source before any provider call', async () => {
  const providerBodies = [];
  const canonicalUrl = 'https://developer.example/residences/amber-city-official';
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async (_url, init) => {
      const body = JSON.parse(init.body);
      providerBodies.push(body);
      if (body.text.format.name === 'platforma_official_developer_candidate') {
        return developerResponse({
          canonicalUrl: 'https://developer.example/',
          officialDeveloperName: 'ФСК',
        }, ['https://developer.example/']);
      }
      return projectResponse({
        canonicalUrl,
        officialProjectName: 'Amber City',
        matchKind: 'EXACT',
      }, [canonicalUrl]);
    },
    {
      async fetch(source) {
        if (source.canonicalUrl === 'https://developer.example/') {
          return fetchedPage(
            source.canonicalUrl,
            '<html><body>Официальный сайт застройщика ФСК</body></html>',
          );
        }
        if (source.canonicalUrl === canonicalUrl) {
          return fetchedPage(
            source.canonicalUrl,
            '<html><body>ЖК Amber City — проект ФСК</body></html>',
          );
        }
        throw new Error('known path unavailable');
      },
    },
  );

  const result = await service.discover(project, {
    registrySources: [activeRegistrySource({
      type: 'DEVELOPMENT_PAGE',
      canonicalUrl,
      projectKey: project.projectKey,
      developerKey: project.developerKey,
      allowedHosts: ['developer.example', 'www.developer.example'],
    })],
  });

  assert.equal(result.status, 'VERIFIED', JSON.stringify(result, null, 2));
  assert.equal(result.canonicalUrl, canonicalUrl);
  assert.equal(providerBodies.length, 0);
  assert.equal(result.telemetry.phases.length, 0);
  assert.equal(result.telemetry.webSearchCalls, 0);
});

test('Assistant source discovery accepts an explicitly stored www counterpart for a project source', async () => {
  const canonicalUrl = 'https://www.developer.example/residences/amber-city-official';
  let providerCalls = 0;
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async () => {
      providerCalls += 1;
      throw new Error('provider must not be called for a normalized www registry hit');
    },
    {
      async fetch() {
        throw new Error('connector must not be called for a project registry hit');
      },
    },
  );

  const result = await service.discover(project, {
    registrySources: [activeRegistrySource({
      type: 'DEVELOPMENT_PAGE',
      canonicalUrl,
      projectKey: project.projectKey,
      developerKey: project.developerKey,
      allowedHosts: ['developer.example'],
    })],
  });

  assert.equal(result.status, 'VERIFIED', JSON.stringify(result, null, 2));
  assert.equal(result.canonicalUrl, canonicalUrl);
  assert.equal(providerCalls, 0);
});

test('Assistant source discovery preserves explicit registry hosts before optional www variants', async () => {
  const canonicalUrl = 'https://developer.example/residences/amber-city-official';
  let providerCalls = 0;
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async () => {
      providerCalls += 1;
      throw new Error('provider must not be called for an explicit registry allowlist');
    },
    {
      async fetch() {
        throw new Error('connector must not be called for a project registry hit');
      },
    },
  );

  const result = await service.discover(project, {
    registrySources: [activeRegistrySource({
      type: 'DEVELOPMENT_PAGE',
      canonicalUrl,
      projectKey: project.projectKey,
      developerKey: project.developerKey,
      allowedHosts: [
        'developer.example',
        'catalog-1.developer.example',
        'catalog-2.developer.example',
        'catalog-3.developer.example',
        'catalog-4.developer.example',
        'catalog-5.developer.example',
      ],
    })],
  });

  assert.equal(result.status, 'VERIFIED', JSON.stringify(result, null, 2));
  assert.equal(result.canonicalUrl, canonicalUrl);
  assert.equal(providerCalls, 0);
});

test('Assistant source discovery does not synthesize www trust for IP or single-label hosts', () => {
  assert.deepEqual(relatedHosts('127.0.0.1'), ['127.0.0.1']);
  assert.deepEqual(relatedHosts('localhost'), ['localhost']);
});

test('Assistant source discovery rejects invalid registry seeds instead of trusting them', async (context) => {
  const baseProjectSource = () => activeRegistrySource({
    type: 'DEVELOPMENT_PAGE',
    canonicalUrl: 'https://developer.example/residences/amber-city-official',
    projectKey: project.projectKey,
    developerKey: project.developerKey,
    allowedHosts: ['developer.example', 'www.developer.example'],
  });
  const baseDeveloperSource = () => activeRegistrySource({
    type: 'DEVELOPER_PROMOTION',
    canonicalUrl: 'https://developer.example/',
    projectKey: null,
    developerKey: project.developerKey,
    allowedHosts: ['developer.example', 'www.developer.example'],
  });
  const scenarios = [
    ['disabled project source', () => ({ ...baseProjectSource(), state: 'DISABLED' })],
    ['failed project revision', () => ({
      ...baseProjectSource(),
      latestRevision: { processingStatus: 'FAILED', checksum: 'c'.repeat(64) },
    })],
    ['wrong project key', () => ({ ...baseProjectSource(), projectKey: 'other-project' })],
    ['wrong developer key', () => ({ ...baseProjectSource(), developerKey: 'other-developer' })],
    ['invalid project checksum', () => ({
      ...baseProjectSource(),
      latestRevision: { processingStatus: 'INDEXED', checksum: 'invalid' },
    })],
    ['malformed project allowed hosts', () => ({
      ...baseProjectSource(),
      connectorConfig: { allowedHosts: ['developer.example/path'] },
    })],
    ['missing explicit project allowed hosts', () => ({
      ...baseProjectSource(),
      connectorConfig: {},
    })],
    ['failed developer revision', () => ({
      ...baseDeveloperSource(),
      latestRevision: { processingStatus: 'FAILED', checksum: 'c'.repeat(64) },
    })],
    ['malformed developer allowed hosts', () => ({
      ...baseDeveloperSource(),
      connectorConfig: { allowedHosts: ['sibling.developer.example'] },
    })],
  ];

  for (const [name, createSource] of scenarios) {
    await context.test(name, async () => {
      let providerCalls = 0;
      const service = new AssistantSourceDiscoveryService(
        discoveryEnvironment(),
        async () => {
          providerCalls += 1;
          return developerNotFoundResponse([]);
        },
        {
          async fetch() {
            throw new Error('invalid registry source must not reach the connector');
          },
        },
      );

      const result = await service.discover(project, { registrySources: [createSource()] });

      assert.equal(result.status, 'NOT_FOUND');
      assert.equal(providerCalls, 1);
      assert.equal(result.telemetry.phases.length, 1);
    });
  }
});

test('Assistant source discovery resolves a registered developer known path before any Web Search', async () => {
  const registryUrl = 'https://catalog.developer.example/';
  let registryFetched = false;
  let knownPathProbed = false;
  let knownPathUrl = null;
  const providerBodies = [];
  const connectorConfigs = [];
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async (_url, init) => {
      const body = JSON.parse(init.body);
      providerBodies.push(body);
      if (body.text.format.name === 'platforma_official_developer_candidate') {
        return developerResponse({
          canonicalUrl: registryUrl,
          officialDeveloperName: 'ФСК',
        }, [registryUrl]);
      }
      return projectNotFoundResponse(['https://catalog.developer.example/projects/']);
    },
    {
      async fetch(source) {
        connectorConfigs.push(source.connectorConfig);
        if (source.canonicalUrl === registryUrl) {
          registryFetched = true;
          return fetchedPage(
            source.canonicalUrl,
            '<html><body>Официальный каталог жилых проектов застройщика ФСК</body></html>',
          );
        }
        knownPathProbed = true;
        knownPathUrl = source.canonicalUrl;
        return fetchedPage(
          source.canonicalUrl,
          '<html><body>ЖК Amber City — официальный проект застройщика ФСК</body></html>',
        );
      },
    },
  );

  const result = await service.discover(project, {
    registrySources: [activeRegistrySource({
      type: 'DEVELOPER_PROMOTION',
      canonicalUrl: registryUrl,
      projectKey: null,
      developerKey: project.developerKey,
      allowedHosts: ['catalog.developer.example', 'www.catalog.developer.example'],
    })],
  });

  assert.equal(result.status, 'VERIFIED', JSON.stringify(result, null, 2));
  assert.equal(result.developerCanonicalUrl, registryUrl);
  assert.equal(result.canonicalUrl, knownPathUrl);
  assert.equal(registryFetched, true);
  assert.equal(knownPathProbed, true);
  assert.equal(providerBodies.length, 0);
  assert.equal(result.telemetry.phases.length, 0);
  assert.equal(result.telemetry.webSearchCalls, 0);
  assert.equal(connectorConfigs.some(({ allowedHosts }) => (
    allowedHosts.includes('catalog.developer.example')
      && allowedHosts.includes('www.catalog.developer.example')
  )), true);
});

test('Assistant source discovery probes a catalog-derived project code before Web Search', async () => {
  const registryUrl = 'https://catalog.developer.example/';
  const catalogProjectUrl = 'https://catalog.developer.example/projects/amber-official/';
  let providerCalls = 0;
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async () => {
      providerCalls += 1;
      throw new Error('provider must not be called after deterministic catalog evidence');
    },
    {
      async fetch(source) {
        if (source.canonicalUrl === registryUrl) {
          return fetchedPage(source.canonicalUrl, [
            '<html><body>Официальный каталог жилых проектов застройщика ФСК',
            '<script type="application/json">',
            JSON.stringify({ items: [{ name: 'Amber City', code: 'amber-official' }] }),
            '</script></body></html>',
          ].join(''));
        }
        if (source.canonicalUrl === catalogProjectUrl) {
          return fetchedPage(
            source.canonicalUrl,
            '<html><body>ЖК Amber City — официальный проект застройщика ФСК</body></html>',
          );
        }
        throw new Error('known path unavailable');
      },
    },
  );

  const result = await service.discover(project, {
    registrySources: [activeRegistrySource({
      type: 'DEVELOPER_PROMOTION',
      canonicalUrl: registryUrl,
      projectKey: null,
      developerKey: project.developerKey,
      allowedHosts: ['catalog.developer.example', 'www.catalog.developer.example'],
    })],
  });

  assert.equal(result.status, 'VERIFIED', JSON.stringify(result, null, 2));
  assert.equal(result.canonicalUrl, catalogProjectUrl);
  assert.equal(providerCalls, 0);
  assert.equal(result.telemetry.phases.length, 0);
});

test('Assistant source discovery fetches an exact project URL supplied by the official catalog before Web Search', async () => {
  const registryUrl = 'https://catalog.developer.example/';
  const catalogProjectUrl = 'https://catalog.developer.example/residences/amber-official/';
  let providerCalls = 0;
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async () => {
      providerCalls += 1;
      throw new Error('provider must not be called after an exact official catalog URL');
    },
    {
      async fetch(source) {
        if (source.canonicalUrl === registryUrl) {
          return fetchedPage(source.canonicalUrl, [
            '<html><body>Официальный каталог жилых проектов застройщика ФСК',
            '<script type="application/json">',
            JSON.stringify({
              items: [{
                name: 'Amber City',
                code: 'amber-official',
                url: '/residences/amber-official/',
              }],
            }),
            '</script></body></html>',
          ].join(''));
        }
        if (source.canonicalUrl === catalogProjectUrl) {
          return fetchedPage(
            source.canonicalUrl,
            '<html><body>ЖК Amber City — официальный проект застройщика ФСК</body></html>',
          );
        }
        throw new Error('hardcoded known path unavailable');
      },
    },
  );

  const result = await service.discover(project, {
    registrySources: [activeRegistrySource({
      type: 'DEVELOPER_PROMOTION',
      canonicalUrl: registryUrl,
      projectKey: null,
      developerKey: project.developerKey,
      allowedHosts: ['catalog.developer.example', 'www.catalog.developer.example'],
    })],
  });

  assert.equal(result.status, 'VERIFIED', JSON.stringify(result, null, 2));
  assert.equal(result.canonicalUrl, catalogProjectUrl);
  assert.equal(providerCalls, 0);
  assert.equal(result.telemetry.phases.length, 0);
});

test('Assistant source discovery follows an exact same-host project link from an HTML catalog before Web Search', async () => {
  const registryUrl = 'https://catalog.developer.example/';
  const catalogProjectUrl = 'https://catalog.developer.example/residences/amber-city/';
  let providerCalls = 0;
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async () => {
      providerCalls += 1;
      throw new Error('provider must not be called after an exact HTML catalog link');
    },
    {
      async fetch(source) {
        if (source.canonicalUrl === registryUrl) {
          return fetchedPage(source.canonicalUrl, [
            '<html><body>Официальный каталог жилых проектов застройщика ФСК',
            `<a href="${catalogProjectUrl}">ЖК Amber City</a>`,
            '</body></html>',
          ].join(''));
        }
        if (source.canonicalUrl === catalogProjectUrl) {
          return fetchedPage(
            source.canonicalUrl,
            '<html><body>ЖК Amber City — официальный проект застройщика ФСК</body></html>',
          );
        }
        throw new Error('hardcoded known path unavailable');
      },
    },
  );

  const result = await service.discover(project, {
    registrySources: [activeRegistrySource({
      type: 'DEVELOPER_PROMOTION',
      canonicalUrl: registryUrl,
      projectKey: null,
      developerKey: project.developerKey,
      allowedHosts: ['catalog.developer.example', 'www.catalog.developer.example'],
    })],
  });

  assert.equal(result.status, 'VERIFIED', JSON.stringify(result, null, 2));
  assert.equal(result.canonicalUrl, catalogProjectUrl);
  assert.equal(providerCalls, 0);
  assert.equal(result.telemetry.phases.length, 0);
});

test('Assistant source discovery follows a proven catalog link from a registered developer source before Web Search', async () => {
  const registryUrl = 'https://developer.example/';
  const catalogUrl = 'https://catalog.developer.example/';
  const catalogProjectUrl = 'https://catalog.developer.example/projects/amber-official/';
  let providerCalls = 0;
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async () => {
      providerCalls += 1;
      throw new Error('provider must not be called after a proven catalog link');
    },
    {
      async fetch(source) {
        if (source.canonicalUrl === registryUrl) {
          return fetchedPage(source.canonicalUrl, [
            '<html><body>Официальный сайт застройщика ФСК',
            `<a href="${catalogUrl}">Официальный каталог жилых проектов</a>`,
            '</body></html>',
          ].join(''));
        }
        if (source.canonicalUrl === catalogUrl) {
          return fetchedPage(source.canonicalUrl, [
            '<html><body>Официальный каталог жилых проектов застройщика ФСК',
            '<script type="application/json">',
            JSON.stringify({ items: [{ name: 'Amber City', code: 'amber-official' }] }),
            '</script></body></html>',
          ].join(''));
        }
        if (source.canonicalUrl === catalogProjectUrl) {
          return fetchedPage(
            source.canonicalUrl,
            '<html><body>ЖК Amber City — официальный проект застройщика ФСК</body></html>',
          );
        }
        throw new Error('known path unavailable');
      },
    },
  );

  const result = await service.discover(project, {
    registrySources: [activeRegistrySource({
      type: 'DEVELOPER_PROMOTION',
      canonicalUrl: registryUrl,
      projectKey: null,
      developerKey: project.developerKey,
      allowedHosts: ['developer.example', 'www.developer.example'],
    })],
  });

  assert.equal(result.status, 'VERIFIED', JSON.stringify(result, null, 2));
  assert.equal(result.canonicalUrl, catalogProjectUrl);
  assert.equal(providerCalls, 0);
  assert.equal(result.telemetry.phases.length, 0);
});

test('Assistant source discovery exhausts deterministic catalog and known paths before project Web Search', async () => {
  const registryUrl = 'https://developer.example/';
  const events = [];
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async (_url, init) => {
      const body = JSON.parse(init.body);
      events.push(`provider:${body.text.format.name}`);
      return projectNotFoundResponse(['https://developer.example/projects/']);
    },
    {
      async fetch(source) {
        if (source.canonicalUrl === registryUrl) {
          events.push('fetch:catalog');
          return fetchedPage(
            source.canonicalUrl,
            '<html><body>Официальный каталог жилых проектов застройщика ФСК</body></html>',
          );
        }
        events.push(`fetch:known:${source.canonicalUrl}`);
        throw new Error('known path unavailable');
      },
    },
  );

  const result = await service.discover(project, {
    registrySources: [activeRegistrySource({
      type: 'DEVELOPER_PROMOTION',
      canonicalUrl: registryUrl,
      projectKey: null,
      developerKey: project.developerKey,
      allowedHosts: ['developer.example', 'www.developer.example'],
    })],
  });

  assert.equal(result.status, 'NOT_FOUND', JSON.stringify(result, null, 2));
  assert.equal(events[0], 'fetch:catalog');
  assert.equal(
    events.filter((event) => event.startsWith('fetch:known:')).length,
    buildKnownProjectUrls(
      [project.projectKey],
      ['developer.example', 'www.developer.example'],
    ).length,
  );
  assert.equal(events.at(-1), 'provider:platforma_official_project_candidate');
  assert.equal(events.filter((event) => event.startsWith('provider:')).length, 1);
});

test('Assistant source discovery never widens an exact co.jp host to the public suffix or a sibling', async () => {
  const providerBodies = [];
  const fetchedUrls = [];
  const nestedUrl = 'https://evil.x.example.co.jp/projects/amber-city';
  const unrelatedUrl = 'https://unrelated.co.jp/projects/amber-city';
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async (_url, init) => {
      const body = JSON.parse(init.body);
      providerBodies.push(body);
      if (body.text.format.name === 'platforma_official_developer_candidate') {
        return developerResponse({
          canonicalUrl: 'https://www.x.example.co.jp/',
          officialDeveloperName: 'ФСК',
        }, ['https://www.x.example.co.jp/']);
      }
      const candidateUrl = body.model === 'gpt-5.6-luna' ? nestedUrl : unrelatedUrl;
      return projectResponse({
        canonicalUrl: candidateUrl,
        officialProjectName: 'Amber City',
        matchKind: 'EXACT',
      }, [candidateUrl]);
    },
    {
      async fetch(source) {
        fetchedUrls.push(source.canonicalUrl);
        if (source.canonicalUrl === 'https://www.x.example.co.jp/') {
          return fetchedPage(
            'https://x.example.co.jp/',
            '<html><body>Официальный сайт застройщика ФСК</body></html>',
          );
        }
        if (source.canonicalUrl === 'https://co.jp/') {
          return fetchedPage(
            source.canonicalUrl,
            '<html><body>Официальный сайт застройщика ФСК</body></html>',
          );
        }
        if (source.canonicalUrl === unrelatedUrl) {
          return fetchedPage(
            source.canonicalUrl,
            '<html><body>ЖК Amber City — проект ФСК</body></html>',
          );
        }
        if (source.canonicalUrl === nestedUrl) {
          return fetchedPage(
            source.canonicalUrl,
            '<html><body>ЖК Amber City — проект ФСК</body></html>',
          );
        }
        throw new Error('known path unavailable');
      },
    },
  );

  const result = await service.discover(project);

  assert.equal(result.status, 'REJECTED', JSON.stringify(result, null, 2));
  assert.equal(
    result.errorCode,
    'ASSISTANT_SOURCE_DISCOVERY_PROJECT_OUTSIDE_DEVELOPER_DOMAIN',
  );
  assert.deepEqual(providerBodies.map(({ model }) => model), [
    'gpt-5.6-luna',
    'gpt-5.6-luna',
    'gpt-5.6-terra',
  ]);
  const allowedDomains = providerBodies
    .filter(({ text }) => text.format.name === 'platforma_official_project_candidate')
    .flatMap(({ tools }) => tools[0].filters.allowed_domains);
  assert.equal(allowedDomains.includes('x.example.co.jp'), true);
  assert.equal(allowedDomains.every((host) => (
    host === 'x.example.co.jp' || host === 'www.x.example.co.jp'
  )), true);
  assert.equal(fetchedUrls.includes('https://co.jp/'), false);
  assert.equal(fetchedUrls.includes(nestedUrl), false);
  assert.equal(fetchedUrls.includes(unrelatedUrl), false);
});

test('Assistant source discovery rejects an off-list connector final URL before project search', async () => {
  let providerCalls = 0;
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async () => {
      providerCalls += 1;
      return developerResponse({
        canonicalUrl: 'https://developer.example/',
        officialDeveloperName: 'ФСК',
      }, ['https://developer.example/']);
    },
    {
      async fetch() {
        return fetchedPage(
          'https://unrelated.example/',
          '<html><body>Официальный сайт застройщика ФСК</body></html>',
        );
      },
    },
  );

  const result = await service.discover(project);

  assert.equal(result.status, 'REJECTED');
  assert.equal(result.errorCode, 'SOURCE_REDIRECT_HOST_NOT_ALLOWED');
  assert.equal(providerCalls, 1);
});

test('Assistant source discovery rejects an off-list connector redirect before project search', async () => {
  let providerCalls = 0;
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async () => {
      providerCalls += 1;
      return developerResponse({
        canonicalUrl: 'https://developer.example/',
        officialDeveloperName: 'ФСК',
      }, ['https://developer.example/']);
    },
    {
      async fetch() {
        return {
          ...fetchedPage(
            'https://developer.example/',
            '<html><body>Официальный сайт застройщика ФСК</body></html>',
          ),
          redirects: ['https://unrelated.example/landing'],
        };
      },
    },
  );

  const result = await service.discover(project);

  assert.equal(result.status, 'REJECTED');
  assert.equal(result.errorCode, 'SOURCE_REDIRECT_HOST_NOT_ALLOWED');
  assert.equal(providerCalls, 1);
});

test('Assistant source discovery keeps post-fetch validation isolated from connector mutations', async () => {
  let providerCalls = 0;
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async () => {
      providerCalls += 1;
      return developerResponse({
        canonicalUrl: 'https://developer.example/',
        officialDeveloperName: 'ФСК',
      }, ['https://developer.example/']);
    },
    {
      async fetch(source) {
        source.connectorConfig.allowedHosts.push('unrelated.example');
        return fetchedPage(
          'https://unrelated.example/',
          '<html><body>Официальный сайт застройщика ФСК</body></html>',
        );
      },
    },
  );

  const result = await service.discover(project);

  assert.equal(result.status, 'REJECTED');
  assert.equal(result.errorCode, 'SOURCE_REDIRECT_HOST_NOT_ALLOWED');
  assert.equal(providerCalls, 1);
});

test('Assistant source discovery rejects unsafe final and redirect URLs on an allowed host', async (context) => {
  const scenarios = [
    {
      name: 'http final URL',
      finalUrl: 'http://developer.example/',
      redirects: [],
    },
    {
      name: 'credentialed redirect URL',
      finalUrl: 'https://developer.example/',
      redirects: ['https://user:password@developer.example/landing'],
    },
  ];

  for (const scenario of scenarios) {
    await context.test(scenario.name, async () => {
      let providerCalls = 0;
      const service = new AssistantSourceDiscoveryService(
        discoveryEnvironment(),
        async () => {
          providerCalls += 1;
          return developerResponse({
            canonicalUrl: 'https://developer.example/',
            officialDeveloperName: 'ФСК',
          }, ['https://developer.example/']);
        },
        {
          async fetch() {
            return {
              ...fetchedPage(
                scenario.finalUrl,
                '<html><body>Официальный сайт застройщика ФСК</body></html>',
              ),
              redirects: scenario.redirects,
            };
          },
        },
      );

      const result = await service.discover(project);

      assert.equal(result.status, 'REJECTED');
      assert.equal(result.errorCode, 'SOURCE_REDIRECT_HOST_NOT_ALLOWED');
      assert.equal(providerCalls, 1);
    });
  }
});

test('Assistant source discovery allows one Terra only after a seeded Luna candidate fails local identity validation', async () => {
  const events = [];
  const providerBodies = [];
  const wrongUrl = 'https://developer.example/official/wrong-project';
  const correctUrl = 'https://developer.example/official/amber-city';
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async (_url, init) => {
      const body = JSON.parse(init.body);
      providerBodies.push(body);
      events.push(`provider:${body.model}:${body.text.format.name}`);
      assert.equal(body.text.format.name, 'platforma_official_project_candidate');
      const isFallback = body.model === 'gpt-5.6-terra';
      const canonicalUrl = isFallback ? correctUrl : wrongUrl;
      return projectResponse({
        canonicalUrl,
        officialProjectName: isFallback ? 'Amber City' : 'Wrong project',
        matchKind: 'EXACT',
      }, [canonicalUrl]);
    },
    {
      async fetch(source) {
        events.push(`fetch:${source.canonicalUrl}`);
        if (source.canonicalUrl === 'https://developer.example/') {
          return fetchedPage(
            source.canonicalUrl,
            '<html><body>Официальный сайт застройщика ФСК</body></html>',
          );
        }
        if (source.canonicalUrl === wrongUrl) {
          return fetchedPage(
            source.canonicalUrl,
            '<html><body>Другой жилой проект застройщика ФСК</body></html>',
          );
        }
        if (source.canonicalUrl === correctUrl) {
          return fetchedPage(
            source.canonicalUrl,
            '<html><body>ЖК Amber City — проект ФСК</body></html>',
          );
        }
        throw new Error('known path unavailable');
      },
    },
  );

  const result = await service.discover(project, {
    registrySources: [activeRegistrySource({
      type: 'DEVELOPER_PROMOTION',
      canonicalUrl: 'https://developer.example/',
      projectKey: null,
      developerKey: project.developerKey,
      allowedHosts: ['developer.example', 'www.developer.example'],
    })],
  });

  assert.equal(result.status, 'VERIFIED', JSON.stringify(result, null, 2));
  assert.equal(result.canonicalUrl, correctUrl);
  assert.deepEqual(providerBodies.map(({ model }) => model), [
    'gpt-5.6-luna',
    'gpt-5.6-terra',
  ]);
  assert.deepEqual(result.telemetry.phases.map(({ model }) => model), [
    'gpt-5.6-luna',
    'gpt-5.6-terra',
  ]);
  assert.ok(events.indexOf(`fetch:${wrongUrl}`) < events.findIndex((event) => (
    event.startsWith('provider:gpt-5.6-terra:')
  )));
});

test('Assistant source discovery verifies the developer first and restricts project search to its domain', async () => {
  const calls = [];
  const connectorCalls = [];
  const responses = [
    developerResponse({
      canonicalUrl: 'https://developer.example/?utm_source=search',
      officialDeveloperName: 'ФСК',
    }, ['https://developer.example/']),
    projectResponse({
      canonicalUrl: 'https://developer.example/projects/amber-city?utm_source=search',
      officialProjectName: 'Amber City',
      matchKind: 'EXACT',
    }, ['https://developer.example/projects/amber-city']),
  ];
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async (url, init) => {
      calls.push({ url, init });
      return responses.shift();
    },
    {
      async fetch(source) {
        connectorCalls.push(source);
        if (source.canonicalUrl === 'https://developer.example/') {
          return fetchedPage(source.canonicalUrl, '<html><body>Официальный сайт застройщика ФСК</body></html>');
        }
        if (source.canonicalUrl.endsWith('/')) throw new Error('known path unavailable');
        return fetchedPage(
          source.canonicalUrl,
          '<html><title>Amber City — официальный сайт</title><body>ЖК Amber City</body></html>',
        );
      },
    },
  );

  const result = await service.discover(project);

  assert.equal(result.status, 'VERIFIED', JSON.stringify(result, null, 2));
  assert.equal(result.developerCanonicalUrl, 'https://developer.example/');
  assert.equal(result.canonicalUrl, 'https://developer.example/projects/amber-city');
  assert.equal(result.officialProjectName, 'Amber City');
  assert.equal(result.matchKind, 'EXACT');
  assert.match(result.matchedProjectAlias, /amber city/u);
  assert.equal(result.matchedDeveloperAlias, 'фск');
  assert.equal(result.telemetry.totalTokens, 66);
  assert.deepEqual(result.telemetry.phases.map(({ phase }) => phase), ['DEVELOPER', 'PROJECT']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-only');

  const developerRequest = JSON.parse(calls[0].init.body);
  const projectRequest = JSON.parse(calls[1].init.body);
  assert.deepEqual(developerRequest.tools, [{ type: 'web_search', search_context_size: 'low' }]);
  assert.equal(developerRequest.service_tier, 'default');
  assert.equal(developerRequest.max_tool_calls, 1);
  assert.deepEqual(projectRequest.tools, [{
    type: 'web_search',
    search_context_size: 'low',
    filters: { allowed_domains: ['developer.example', 'www.developer.example'] },
  }]);
  assert.match(projectRequest.instructions, /сначала подтвержден/u);
  assert.match(projectRequest.instructions, /устарев/u);
  assert.match(projectRequest.instructions, /транслит/u);
  assert.match(projectRequest.instructions, /переимен/u);
  assert.equal(projectRequest.tool_choice, 'required');
  assert.equal(projectRequest.service_tier, 'default');
  assert.equal(projectRequest.max_tool_calls, 1);
  assert.deepEqual(projectRequest.include, ['web_search_call.action.sources']);
  assert.equal(projectRequest.text.format.type, 'json_schema');
  assert.equal(projectRequest.store, false);
  assert.equal(JSON.stringify(projectRequest).includes('test-only'), false);
  assert.equal(connectorCalls[0].canonicalUrl, 'https://developer.example/');
  assert.equal(connectorCalls.at(-1).canonicalUrl, 'https://developer.example/projects/amber-city');
  assert.equal(connectorCalls.some(({ canonicalUrl }) => (
    canonicalUrl === 'https://developer.example/projects/amber-city/'
  )), true);
});

test('Assistant source discovery fails closed before project search when the developer source is blocked', async () => {
  let connectorCalls = 0;
  const calls = [];
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async () => {
      calls.push(true);
      return developerResponse({
        canonicalUrl: 'https://www.cian.ru/developers/fsk/',
        officialDeveloperName: 'ФСК',
      }, ['https://www.cian.ru/developers/fsk/']);
    },
    { async fetch() { connectorCalls += 1; throw new Error('unexpected'); } },
  );

  const result = await service.discover(project);

  assert.equal(result.status, 'REJECTED');
  assert.equal(result.errorCode, 'ASSISTANT_SOURCE_DISCOVERY_DEVELOPER_DOMAIN_BLOCKED');
  assert.equal(calls.length, 1);
  assert.equal(connectorCalls, 0);
});

test('Assistant source discovery never turns a transport failure into a Terra fallback', async () => {
  const providerBodies = [];
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async (_url, init) => {
      providerBodies.push(JSON.parse(init.body));
      throw new Error('simulated transport failure');
    },
    { async fetch() { throw new Error('connector must not run'); } },
  );

  await assert.rejects(
    service.discover(project),
    (error) => error.code === 'ASSISTANT_SOURCE_DISCOVERY_NETWORK_FAILED',
  );
  assert.equal(providerBodies.length, 1);
  assert.deepEqual(providerBodies.map(({ model }) => model), ['gpt-5.6-luna']);
});

test('Assistant source discovery uses one Terra fallback after Luna fails local project validation', async () => {
  const providerBodies = [];
  const responses = [
    developerResponse({
      canonicalUrl: 'https://developer.example/',
      officialDeveloperName: 'ФСК',
    }, ['https://developer.example/']),
    projectResponse({
      canonicalUrl: 'https://developer.example/projects/wrong-project',
      officialProjectName: 'Wrong project',
      matchKind: 'EXACT',
    }, ['https://developer.example/projects/wrong-project']),
    projectResponse({
      canonicalUrl: 'https://developer.example/projects/amber-city',
      officialProjectName: 'Amber City',
      matchKind: 'EXACT',
    }, ['https://developer.example/projects/amber-city']),
  ];
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async (_url, init) => {
      providerBodies.push(JSON.parse(init.body));
      return responses.shift();
    },
    {
      async fetch(source) {
        if (source.canonicalUrl === 'https://developer.example/') {
          return fetchedPage(source.canonicalUrl, '<html><body>Официальный сайт застройщика ФСК</body></html>');
        }
        if (source.canonicalUrl === 'https://developer.example/projects/amber-city') {
          return fetchedPage(source.canonicalUrl, '<html><body>ЖК Amber City — проект ФСК</body></html>');
        }
        return fetchedPage(source.canonicalUrl, '<html><body>Другой жилой проект ФСК</body></html>');
      },
    },
  );

  const result = await service.discover(project);

  assert.equal(result.status, 'VERIFIED', JSON.stringify(result, null, 2));
  assert.deepEqual(providerBodies.map(({ model }) => model), [
    'gpt-5.6-luna',
    'gpt-5.6-luna',
    'gpt-5.6-terra',
  ]);
  assert.equal(result.telemetry.phases.length, 3);
  assert.equal(result.canonicalUrl, 'https://developer.example/projects/amber-city');
});

test('Assistant source discovery stops before a fourth provider call for one project', async () => {
  const providerBodies = [];
  const responses = [
    developerResponse({
      canonicalUrl: 'https://developer.example/',
      officialDeveloperName: 'ФСК',
    }, ['https://developer.example/', 'https://developer.example/catalog/']),
    developerNotFoundResponse(['https://developer.example/catalog/']),
    projectNotFoundResponse(['https://developer.example/projects/']),
  ];
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async (_url, init) => {
      providerBodies.push(JSON.parse(init.body));
      return responses.shift();
    },
    {
      async fetch(source) {
        if (source.canonicalUrl === 'https://developer.example/') {
          throw new SourceConnectorError('SOURCE_ANTI_BOT_CHALLENGE', true, 200);
        }
        if (source.canonicalUrl === 'https://developer.example/catalog/') {
          return fetchedPage(source.canonicalUrl, [
            '<html><body>Официальный каталог застройщика ФСК',
            '<script type="application/json">',
            JSON.stringify({ items: [{ name: 'Amber City', code: 'amber-city' }] }),
            '</script></body></html>',
          ].join(''));
        }
        throw new SourceConnectorError('SOURCE_ANTI_BOT_CHALLENGE', true, 200);
      },
    },
  );

  await assert.rejects(
    service.discover(project),
    (error) => error.code === 'ASSISTANT_SOURCE_DISCOVERY_CALL_BUDGET_EXHAUSTED',
  );
  assert.equal(providerBodies.length, 3);
  assert.deepEqual(providerBodies.map(({ model }) => model), [
    'gpt-5.6-luna',
    'gpt-5.6-luna',
    'gpt-5.6-luna',
  ]);
});

test('Assistant source discovery keeps the run USD cap atomic across concurrent projects', async () => {
  const projects = [
    project,
    {
      ...project,
      projectKey: 'zhiloj-kompleks-novaya-zvezda',
      title: 'ЖК Новая звезда',
      developerKey: 'pik',
      developerName: 'ПИК',
    },
  ];
  const firstRequest = createDeveloperDiscoveryRequestBody('gpt-5.6-luna', projects[0]);
  const oneCallBudget = estimateAssistantAiCallCost({
    model: 'gpt-5.6-luna',
    requestBytes: Buffer.byteLength(JSON.stringify(firstRequest), 'utf8'),
    maxOutputTokens: 1_600,
    maxWebSearchCalls: 1,
  }).estimatedUsd;
  let reservations = 0;
  let providerCalls = 0;
  const service = new AssistantSourceDiscoveryService(
    {
      ...discoveryEnvironment(),
      ASSISTANT_SOURCE_DISCOVERY_LIVE: 'true',
      ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
    },
    async (_url, init) => {
      providerCalls += 1;
      const body = JSON.parse(init.body);
      const providerInput = JSON.parse(body.input[0].content[0].text);
      const developerUrl = `https://${providerInput.developer_key}.example/`;
      return developerResponse({
        canonicalUrl: developerUrl,
        officialDeveloperName: providerInput.developer_name,
      }, [developerUrl]);
    },
    {
      async fetch(source) {
        const developerName = source.canonicalUrl.includes('pik.example') ? 'ПИК' : 'ФСК';
        return fetchedPage(
          source.canonicalUrl,
          `<html><body>Официальный сайт застройщика ${developerName}</body></html>`,
        );
      },
    },
    {
      usageBudgets: {
        async reserve(input) {
          reservations += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return {
            id: `reservation-${reservations}`,
            provider: input.provider,
            model: input.model,
            usageDate: new Date('2026-08-27T00:00:00.000Z'),
            reservedCostUsd: input.reservedCostUsd,
          };
        },
        async settle() { return true; },
      },
      dailyBudgetUsd: '1.00000000',
      maximumRunCostUsd: oneCallBudget,
      operationRunId: 'fix-token-concurrent-cost-cap',
      executionId: randomUUID(),
    },
  );

  const outcomes = await Promise.allSettled(projects.map((candidate) => service.discover(candidate)));

  assert.equal(reservations, 1);
  assert.equal(providerCalls, 1);
  assert.equal(outcomes.every(({ status }) => status === 'rejected'), true);
  assert.equal(outcomes.some(({ reason }) => (
    reason.code === 'ASSISTANT_SOURCE_DISCOVERY_COST_BUDGET_EXHAUSTED'
  )), true);
});

test('Assistant source discovery rejects a cited site that does not prove the developer identity', async () => {
  let providerCalls = 0;
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async () => {
      providerCalls += 1;
      return developerResponse({
        canonicalUrl: 'https://developer.example/',
        officialDeveloperName: 'ФСК',
      }, ['https://developer.example/']);
    },
    {
      async fetch(source) {
        return fetchedPage(source.canonicalUrl, '<html><body>Официальный сайт другого девелопера</body></html>');
      },
    },
  );

  const result = await service.discover(project);

  assert.equal(result.status, 'REJECTED');
  assert.equal(result.errorCode, 'ASSISTANT_SOURCE_DISCOVERY_DEVELOPER_MISMATCH');
  assert.equal(providerCalls, 1);
});

test('Assistant source discovery expands an exact host only through a verified official link', async () => {
  const calls = [];
  const responses = [
    developerResponse({
      canonicalUrl: 'https://mortgage.developer.example/',
      officialDeveloperName: 'ФСК',
    }, ['https://mortgage.developer.example/']),
    projectResponse({
      canonicalUrl: 'https://developer.example/projects/amber-city',
      officialProjectName: 'Amber City',
      matchKind: 'EXACT',
    }, ['https://developer.example/projects/amber-city']),
  ];
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return responses.shift();
    },
    {
      async fetch(source) {
        if (source.canonicalUrl === 'https://mortgage.developer.example/') {
          return fetchedPage(source.canonicalUrl, [
            '<html><body>Ипотечные программы застройщика ФСК',
            '<a href="https://developer.example/">Официальный корпоративный сайт</a>',
            '</body></html>',
          ].join(''));
        }
        if (source.canonicalUrl === 'https://developer.example/') {
          return fetchedPage(source.canonicalUrl, '<html><body>Корпоративный сайт застройщика ФСК</body></html>');
        }
        if (source.canonicalUrl.endsWith('/')) throw new Error('known path unavailable');
        return fetchedPage(source.canonicalUrl, '<html><body>ЖК Amber City</body></html>');
      },
    },
  );

  const result = await service.discover(project);

  assert.equal(result.status, 'VERIFIED', JSON.stringify(result, null, 2));
  assert.deepEqual(calls[1].tools[0].filters.allowed_domains, [
    'mortgage.developer.example',
    'www.mortgage.developer.example',
    'developer.example',
    'www.developer.example',
  ]);
});

test('Assistant source discovery keeps an explicitly official linked host when its target is protected', async () => {
  const calls = [];
  const responses = [
    developerResponse({
      canonicalUrl: 'https://catalog.developer.example/',
      officialDeveloperName: 'ФСК',
    }, ['https://catalog.developer.example/']),
    projectResponse({
      canonicalUrl: 'https://developer.example/projects/amber-city',
      officialProjectName: 'Amber City',
      matchKind: 'EXACT',
    }, ['https://developer.example/projects/amber-city']),
  ];
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return responses.shift();
    },
    {
      async fetch(source) {
        if (source.canonicalUrl === 'https://catalog.developer.example/') {
          return fetchedPage(source.canonicalUrl, [
            '<html><body>Официальный каталог застройщика ФСК',
            '<a href="https://developer.example/">Официальный сайт проектов</a>',
            '</body></html>',
          ].join(''));
        }
        if (source.canonicalUrl === 'https://developer.example/') {
          throw Object.assign(new Error('anti-bot'), { code: 'SOURCE_ANTI_BOT_CHALLENGE' });
        }
        if (source.canonicalUrl.endsWith('/')) throw new Error('known path unavailable');
        return fetchedPage(source.canonicalUrl, '<html><body>ЖК Amber City</body></html>');
      },
    },
  );

  const result = await service.discover(project);

  assert.equal(result.status, 'VERIFIED', JSON.stringify(result, null, 2));
  assert.equal(result.developerCanonicalUrl, 'https://catalog.developer.example/');
  assert.deepEqual(calls[1].tools[0].filters.allowed_domains, [
    'catalog.developer.example',
    'www.catalog.developer.example',
    'developer.example',
    'www.developer.example',
  ]);
});

test('Assistant source discovery does not expand trust when a linked catalog fails developer identity', async () => {
  const unrelatedProjectUrl = 'https://unrelated.example/projects/amber-city';
  const providerBodies = [];
  const responses = [
    developerResponse({
      canonicalUrl: 'https://developer.example/',
      officialDeveloperName: 'ФСК',
    }, ['https://developer.example/']),
    projectResponse({
      canonicalUrl: unrelatedProjectUrl,
      officialProjectName: 'Amber City',
      matchKind: 'EXACT',
    }, [unrelatedProjectUrl]),
    projectResponse({
      canonicalUrl: unrelatedProjectUrl,
      officialProjectName: 'Amber City',
      matchKind: 'EXACT',
    }, [unrelatedProjectUrl]),
  ];
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async (_url, init) => {
      providerBodies.push(JSON.parse(init.body));
      return responses.shift();
    },
    {
      async fetch(source) {
        if (source.canonicalUrl === 'https://developer.example/') {
          return fetchedPage(source.canonicalUrl, [
            '<html><body>Официальный сайт застройщика ФСК',
            '<a href="https://unrelated.example/">Каталог проектов партнёра</a>',
            '</body></html>',
          ].join(''));
        }
        if (source.canonicalUrl === 'https://unrelated.example/') {
          return fetchedPage(
            source.canonicalUrl,
            '<html><body>Каталог другого девелопера Amber City</body></html>',
          );
        }
        if (source.canonicalUrl === unrelatedProjectUrl) {
          return fetchedPage(source.canonicalUrl, '<html><body>Amber City</body></html>');
        }
        throw new Error('known path unavailable');
      },
    },
  );

  const result = await service.discover(project);

  assert.equal(result.status, 'REJECTED', JSON.stringify(result, null, 2));
  assert.equal(result.errorCode, 'ASSISTANT_SOURCE_DISCOVERY_PROJECT_OUTSIDE_DEVELOPER_DOMAIN');
  assert.equal(providerBodies.length, 3);
  assert.equal(providerBodies.slice(1).every(({ tools }) => (
    tools[0].filters.allowed_domains.every((host) => (
      host === 'developer.example' || host === 'www.developer.example'
    ))
  )), true);
});

test('Assistant source discovery does not trust an anti-bot sibling proposed only by model citations', async () => {
  const providerBodies = [];
  const responses = [
    developerResponse({
      canonicalUrl: 'https://developer.example/',
      officialDeveloperName: 'ФСК',
    }, [
      'https://developer.example/',
      'https://amber-city.developer.example/',
      'https://catalog.developer.example/',
    ]),
    developerNotFoundResponse(['https://developer.example/company/history/']),
    projectResponse({
      canonicalUrl: 'https://developer.example/projects/amber-city',
      officialProjectName: 'Amber City',
      matchKind: 'EXACT',
    }, ['https://developer.example/projects/amber-city']),
  ];
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async (_url, init) => {
      providerBodies.push(JSON.parse(init.body));
      return responses.shift();
    },
    {
      async fetch(source) {
        if (source.canonicalUrl === 'https://developer.example/') {
          throw new SourceConnectorError('SOURCE_ANTI_BOT_CHALLENGE', true, 200);
        }
        if (source.canonicalUrl === 'https://catalog.developer.example/') {
          return fetchedPage(source.canonicalUrl, [
            '<html><body>Официальный каталог застройщика ФСК Amber City Other City',
            '<script type="application/json">',
            JSON.stringify({ items: [
              { name: 'Amber City', code: 'amber-city' },
              { name: 'Other City', code: 'other-city' },
            ] }),
            '</script></body></html>',
          ].join(''));
        }
        if (source.canonicalUrl === 'https://amber-city.developer.example/') {
          return fetchedPage(source.canonicalUrl, [
            '<html><body>Официальный проект застройщика ФСК Amber City',
            '<script type="application/json">',
            JSON.stringify({ items: [{ name: 'Amber City', code: 'amber-city' }] }),
            '</script></body></html>',
          ].join(''));
        }
        return fetchedPage(source.canonicalUrl, '<html><body>ЖК Amber City</body></html>');
      },
    },
  );

  const result = await service.discover(project);

  assert.equal(result.status, 'REJECTED', JSON.stringify(result, null, 2));
  assert.equal(result.errorCode, 'SOURCE_ANTI_BOT_CHALLENGE');
  assert.equal(result.telemetry.totalTokens, 66);
  assert.equal(result.telemetry.phases.length, 2);
  assert.deepEqual(providerBodies[1].tools, [{
    type: 'web_search',
    search_context_size: 'low',
    filters: { allowed_domains: ['developer.example', 'www.developer.example'] },
  }]);
  const alternativeInput = JSON.parse(providerBodies[1].input[0].content[0].text);
  assert.deepEqual(alternativeInput.protected_official_hosts, [
    'developer.example',
    'www.developer.example',
  ]);
  assert.equal(providerBodies.length, 2);
});

test('Assistant source discovery uses a proven linked catalog before project Web Search', async () => {
  const responses = [
    developerResponse({
      canonicalUrl: 'https://office.developer.example/',
      officialDeveloperName: 'ФСК',
    }, ['https://office.developer.example/', 'https://catalog.developer.example/']),
    projectResponse({
      canonicalUrl: 'https://developer.example/projects/amber-city',
      officialProjectName: 'Amber City',
      matchKind: 'EXACT',
    }, ['https://developer.example/projects/amber-city']),
  ];
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async () => responses.shift(),
    {
      async fetch(source) {
        if (source.canonicalUrl === 'https://office.developer.example/') {
          return fetchedPage(source.canonicalUrl, [
            '<html><body>Офисные инвестиции застройщика ФСК',
            '<a href="https://catalog.developer.example/">Официальный каталог жилых проектов</a>',
            '</body></html>',
          ].join(''));
        }
        if (source.canonicalUrl === 'https://catalog.developer.example/') {
          return fetchedPage(source.canonicalUrl, [
            '<html><body>Жилые проекты застройщика ФСК Amber City',
            '<script type="application/json">',
            JSON.stringify({ items: [{ name: 'Amber City', code: 'amber-city' }] }),
            '</script></body></html>',
          ].join(''));
        }
        if (source.canonicalUrl === 'https://developer.example/') {
          throw new SourceConnectorError('SOURCE_ANTI_BOT_CHALLENGE', true, 200);
        }
        return fetchedPage(source.canonicalUrl, '<html><body>ЖК Amber City</body></html>');
      },
    },
  );

  const result = await service.discover(project);

  assert.equal(result.status, 'VERIFIED', JSON.stringify(result, null, 2));
  assert.equal(result.developerCanonicalUrl, 'https://catalog.developer.example/');
  assert.equal(result.telemetry.phases.length, 1);
  assert.equal(result.telemetry.totalTokens, 33);
});

test('Assistant source discovery deduplicates concurrent developer verification and token billing', async () => {
  const providerPhases = [];
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async (_url, init) => {
      const body = JSON.parse(init.body);
      const phase = body.text.format.name.includes('developer') ? 'DEVELOPER' : 'PROJECT';
      providerPhases.push(phase);
      if (phase === 'DEVELOPER') {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return developerResponse({
          canonicalUrl: 'https://developer.example/',
          officialDeveloperName: 'ФСК',
        }, ['https://developer.example/']);
      }
      const input = JSON.parse(body.input[0].content[0].text);
      const isSecond = input.project_key_hint === 'amber-city-two';
      return projectResponse({
        canonicalUrl: `https://developer.example/projects/${isSecond ? 'amber-city-two' : 'amber-city'}`,
        officialProjectName: isSecond ? 'Amber City Two' : 'Amber City',
        matchKind: 'EXACT',
      }, [`https://developer.example/projects/${isSecond ? 'amber-city-two' : 'amber-city'}`]);
    },
    {
      async fetch(source) {
        if (source.canonicalUrl === 'https://developer.example/') {
          return fetchedPage(source.canonicalUrl, '<html><body>Официальный сайт застройщика ФСК</body></html>');
        }
        return fetchedPage(source.canonicalUrl, `<html><body>${source.canonicalUrl.includes('-two') ? 'Amber City Two' : 'Amber City'}</body></html>`);
      },
    },
  );

  const results = await Promise.all([
    service.discover(project),
    service.discover({ ...project, projectKey: 'amber-city-two', title: 'Amber City Two' }),
  ]);

  assert.deepEqual(results.map(({ status }) => status), ['VERIFIED', 'VERIFIED']);
  assert.equal(providerPhases.filter((phase) => phase === 'DEVELOPER').length, 1);
  assert.equal(providerPhases.filter((phase) => phase === 'PROJECT').length, 0);
  assert.deepEqual(results.map(({ developerCacheHit }) => developerCacheHit).sort(), [false, true]);
  assert.equal(results.reduce((sum, result) => sum + result.telemetry.totalTokens, 0), 33);
  assert.equal(results.reduce((sum, result) => sum + result.telemetry.phases.length, 0), 1);
});

test('Assistant source discovery rejects a project URL without a citation from the verified developer site', async () => {
  const responses = [
    developerResponse({
      canonicalUrl: 'https://developer.example/',
      officialDeveloperName: 'ФСК',
    }, ['https://developer.example/']),
    projectResponse({
      canonicalUrl: 'https://developer.example/projects/amber-city',
      officialProjectName: 'Amber City',
      matchKind: 'EXACT',
    }, ['https://search.example/projects/amber-city']),
    projectResponse({
      canonicalUrl: 'https://developer.example/projects/amber-city',
      officialProjectName: 'Amber City',
      matchKind: 'EXACT',
    }, ['https://search.example/projects/amber-city']),
  ];
  const fetchedUrls = [];
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async () => responses.shift(),
    {
      async fetch(source) {
        fetchedUrls.push(source.canonicalUrl);
        return fetchedPage(source.canonicalUrl, '<html><body>Официальный сайт застройщика ФСК</body></html>');
      },
    },
  );

  const result = await service.discover(project);

  assert.equal(result.status, 'REJECTED');
  assert.equal(result.errorCode, 'ASSISTANT_SOURCE_DISCOVERY_PROJECT_CITATION_MISSING');
  assert.equal(fetchedUrls.every((value) => (
    ['developer.example', 'www.developer.example'].includes(new URL(value).hostname)
  )), true);
  assert.equal(result.telemetry.phases.at(-1).model, 'gpt-5.6-terra');
});

test('Assistant source discovery accepts a standalone project site only through a link on the verified developer page', async () => {
  const responses = [
    developerResponse({
      canonicalUrl: 'https://mr.example/',
      officialDeveloperName: 'MR Group',
    }, ['https://mr.example/']),
    projectResponse({
      canonicalUrl: 'https://mr.example/projects/cityzen',
      officialProjectName: 'CITYZEN',
      matchKind: 'TRANSLITERATION',
    }, ['https://mr.example/projects/cityzen']),
  ];
  const fetchedUrls = [];
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async () => responses.shift(),
    {
      async fetch(source) {
        fetchedUrls.push(source.canonicalUrl);
        if (source.canonicalUrl === 'https://mr.example/') {
          return fetchedPage(source.canonicalUrl, '<html><body>Девелопер MR Group</body></html>');
        }
        if (source.canonicalUrl.replace(/\/$/u, '') === 'https://mr.example/projects/cityzen') {
          return fetchedPage(source.canonicalUrl, [
            '<html><body>',
            '<h1>Жилой квартал CITYZEN</h1><p>Проект MR Group</p>',
            '<a href="https://retail.cityzen.moscow/">Коммерческие помещения CITYZEN</a>',
            '<a href="https://cityzen.moscow/">Официальный сайт проекта</a>',
            '</body></html>',
          ].join(''));
        }
        return fetchedPage(source.canonicalUrl, '<html><body>Квартал CITYZEN</body></html>');
      },
    },
  );

  const result = await service.discover({
    projectKey: 'zhk-cityzen',
    title: 'Жилой квартал СИТИДЗЕН',
    developerKey: 'mr-group',
    developerName: 'MR Group',
  });

  assert.equal(result.status, 'VERIFIED', JSON.stringify(result, null, 2));
  assert.equal(result.canonicalUrl, 'https://cityzen.moscow/');
  assert.equal(result.matchKind, 'TRANSLITERATION');
  assert.equal(fetchedUrls.some((url) => (
    url.replace(/\/$/u, '') === 'https://mr.example/projects/cityzen'
  )), true);
  assert.equal(fetchedUrls.includes('https://cityzen.moscow/'), true);
  assert.equal(fetchedUrls.includes('https://retail.cityzen.moscow/'), false);
});

test('Assistant source discovery does not trust a standalone domain proposed without a developer-site bridge', async () => {
  const responses = [
    developerResponse({
      canonicalUrl: 'https://mr.example/',
      officialDeveloperName: 'MR Group',
    }, ['https://mr.example/']),
    projectResponse({
      canonicalUrl: 'https://cityzen.moscow/',
      officialProjectName: 'CITYZEN',
      matchKind: 'TRANSLITERATION',
    }, ['https://cityzen.moscow/']),
    projectResponse({
      canonicalUrl: 'https://cityzen.moscow/',
      officialProjectName: 'CITYZEN',
      matchKind: 'TRANSLITERATION',
    }, ['https://cityzen.moscow/']),
  ];
  const fetchedUrls = [];
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async () => responses.shift(),
    {
      async fetch(source) {
        fetchedUrls.push(source.canonicalUrl);
        return fetchedPage(source.canonicalUrl, '<html><body>Девелопер MR Group</body></html>');
      },
    },
  );

  const result = await service.discover({
    projectKey: 'zhk-cityzen',
    title: 'Жилой квартал СИТИДЗЕН',
    developerKey: 'mr-group',
    developerName: 'MR Group',
  });

  assert.equal(result.status, 'REJECTED');
  assert.equal(result.errorCode, 'ASSISTANT_SOURCE_DISCOVERY_PROJECT_OUTSIDE_DEVELOPER_DOMAIN');
  assert.equal(fetchedUrls.includes('https://cityzen.moscow/'), false);
  assert.equal(result.telemetry.phases.at(-1).model, 'gpt-5.6-terra');
});

test('Assistant source discovery recognizes Russian and Latin phonetic brand variants such as СИТИДЗЕН and CITYZEN', async () => {
  const service = twoPhaseService({
    developerUrl: 'https://mr.example/',
    developerHtml: '<html><body>MR Group</body></html>',
    projectUrl: 'https://mr.example/projects/cityzen',
    projectHtml: '<html><body>Жилой квартал CITYZEN — проект MR Group</body></html>',
    officialProjectName: 'CITYZEN',
    matchKind: 'TRANSLITERATION',
    developerName: 'MR Group',
  });

  const result = await service.discover({
    projectKey: 'zhk-sitidzen',
    title: 'Жилой квартал СИТИДЗЕН',
    developerKey: 'mr-group',
    developerName: 'MR Group',
  });

  assert.equal(result.status, 'VERIFIED', JSON.stringify(result, null, 2));
  assert.equal(result.matchedPlatformProjectAlias, 'sitidzen');
  assert.equal(result.matchedOfficialProjectAlias, 'cityzen');
});

test('Assistant source discovery keeps the official base brand for a numbered Platforma project variant', async () => {
  const service = twoPhaseService({
    developerUrl: 'https://mr.example/',
    developerHtml: '<html><body>MR Group</body></html>',
    projectUrl: 'https://mr.example/projects/veer',
    projectHtml: '<html><body>Жилой комплекс VEER</body></html>',
    officialProjectName: 'VEER',
    matchKind: 'TRANSLITERATION',
    developerName: 'MR Group',
  });

  const result = await service.discover({
    projectKey: 'veer-2',
    title: 'Жилой комплекс Веер 2',
    developerKey: 'mr-group',
    developerName: 'MR Group',
  });

  assert.equal(result.status, 'VERIFIED', JSON.stringify(result, null, 2));
  assert.equal(result.matchedPlatformProjectAlias, 'veer');
  assert.equal(result.matchedOfficialProjectAlias, 'veer');
});

test('Assistant source discovery recognizes long Russian morphology variants without accepting generic words', async () => {
  const service = twoPhaseService({
    developerUrl: 'https://sminex.example/',
    developerHtml: '<html><body>Девелопер Sminex</body></html>',
    projectUrl: 'https://sminex.example/frunzenskiy',
    projectHtml: '<html><body>Клубный квартал Фрунзенский</body></html>',
    officialProjectName: 'Клубный квартал «Фрунзенский»',
    matchKind: 'RENAMED',
    developerName: 'Sminex',
  });

  const result = await service.discover({
    projectKey: 'frunzenskaya-naberezhnaya',
    title: 'Клубный квартал «Фрунзенская набережная»',
    developerKey: 'sminex',
    developerName: 'Sminex',
  });

  assert.equal(result.status, 'VERIFIED', JSON.stringify(result, null, 2));
  assert.equal(result.matchedPlatformProjectAlias, 'фрунзен');
  assert.match(result.matchedOfficialProjectAlias, /фрунзен/u);
});

test('Assistant source discovery accepts a renamed official project only with deterministic address evidence', async () => {
  const service = twoPhaseService({
    developerUrl: 'https://developer.example/',
    developerHtml: '<html><body>Официальный сайт ФСК</body></html>',
    projectUrl: 'https://developer.example/projects/novy-bereg',
    projectHtml: [
      '<html><body><h1>ЖК Новый Берег</h1>',
      '<p>Застройщик ФСК. Адрес: Москва, Шелепихинская набережная, дом 34.</p>',
      '</body></html>',
    ].join(''),
    officialProjectName: 'Новый Берег',
    matchKind: 'RENAMED',
  });

  const result = await service.discover({
    ...project,
    projectKey: 'staryj-bereg',
    title: 'ЖК Старый Берег',
  });

  assert.equal(result.status, 'VERIFIED', JSON.stringify(result, null, 2));
  assert.equal(result.matchKind, 'RENAMED');
  assert.equal(result.matchedPlatformProjectAlias, null);
  assert.equal(result.matchedOfficialProjectAlias, 'новый берег');
  assert.equal(result.matchedAddress, true);
});

test('Assistant source discovery rejects a claimed rename without old-name or address proof', async () => {
  const service = twoPhaseService({
    developerUrl: 'https://developer.example/',
    developerHtml: '<html><body>Официальный сайт ФСК</body></html>',
    projectUrl: 'https://developer.example/projects/novy-bereg',
    projectHtml: '<html><body><h1>ЖК Новый Берег</h1><p>Застройщик ФСК. Москва.</p></body></html>',
    officialProjectName: 'Новый Берег',
    matchKind: 'RENAMED',
  });

  const result = await service.discover({
    ...project,
    projectKey: 'staryj-bereg',
    title: 'ЖК Старый Берег',
  });

  assert.equal(result.status, 'REJECTED');
  assert.equal(result.errorCode, 'ASSISTANT_SOURCE_DISCOVERY_RENAME_UNGROUNDED');
});

test('Assistant source discovery preserves project NOT_FOUND after the developer was grounded', async () => {
  let connectorCalls = 0;
  const responses = [
    developerResponse({
      canonicalUrl: 'https://developer.example/',
      officialDeveloperName: 'ФСК',
    }, ['https://developer.example/']),
    projectNotFoundResponse(['https://developer.example/projects']),
  ];
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async () => responses.shift(),
    {
      async fetch(source) {
        connectorCalls += 1;
        return fetchedPage(source.canonicalUrl, '<html><body>Официальный сайт застройщика ФСК</body></html>');
      },
    },
  );

  const result = await service.discover(project);

  assert.equal(result.status, 'NOT_FOUND');
  assert.equal(result.developerCanonicalUrl, 'https://developer.example/');
  assert.equal(result.canonicalUrl, null);
  assert.equal(result.errorCode, null);
  assert.ok(connectorCalls > 1);
  assert.equal(result.telemetry.totalTokens, 66);
});

test('Assistant source discovery retries from a rendered developer catalog and grounds an anti-bot project URL', async () => {
  const providerBodies = [];
  const responses = [
    developerResponse({
      canonicalUrl: 'https://catalog.developer.example/',
      officialDeveloperName: 'ФСК',
    }, ['https://catalog.developer.example/']),
    projectNotFoundResponse(['https://developer.example/projects/']),
    projectResponse({
      canonicalUrl: 'https://developer.example/projects/zhk-citybay/',
      officialProjectName: 'City Bay',
      matchKind: 'EXACT',
    }, ['https://developer.example/projects/']),
  ];
  const connectorCalls = [];
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async (_url, init) => {
      providerBodies.push(JSON.parse(init.body));
      return responses.shift();
    },
    {
      async fetch(source) {
        connectorCalls.push(source);
        if (source.canonicalUrl === 'https://catalog.developer.example/') {
          if (source.connectorConfig.browserRenderMode === 'always') {
            return fetchedPage(source.canonicalUrl, [
              '<html><body><main>Официальный каталог застройщика ФСК</main>',
              '<a href="https://developer.example/">Официальный сайт проектов</a>',
              '<div>City Bay</div>',
              '<script type="application/json">',
              JSON.stringify({ items: [{ name: 'City Bay', code: 'citybay' }] }),
              '</script></body></html>',
            ].join(''));
          }
          return fetchedPage(source.canonicalUrl, [
            '<html><body>Официальный каталог застройщика ФСК',
            '<a href="https://developer.example/">Официальный сайт проектов</a>',
            '</body></html>',
          ].join(''));
        }
        throw new SourceConnectorError('SOURCE_ANTI_BOT_CHALLENGE', true, 200);
      },
    },
  );

  const result = await service.discover({
    ...project,
    projectKey: 'zhk-citybay',
    title: 'City Bay',
  });

  assert.equal(result.status, 'VERIFIED', JSON.stringify(result, null, 2));
  assert.equal(result.canonicalUrl, 'https://developer.example/projects/zhk-citybay/');
  assert.match(result.reason, /динамическим каталогом/iu);
  assert.equal(result.telemetry.totalTokens, 99);
  assert.equal(result.telemetry.phases.length, 3);
  assert.equal(providerBodies[1].tools[0].search_context_size, 'low');
  assert.equal(providerBodies[2].tools[0].search_context_size, 'low');
  assert.equal(providerBodies[2].model, 'gpt-5.6-terra');
  const retryInput = JSON.parse(providerBodies[2].input[0].content[0].text);
  assert.equal(retryInput.verified_catalog_project_name, 'City Bay');
  assert.equal(retryInput.verified_catalog_project_code, 'citybay');
  assert.equal(connectorCalls.filter(({ canonicalUrl, connectorConfig }) => (
    canonicalUrl === 'https://catalog.developer.example/'
      && connectorConfig.browserRenderMode === 'always'
  )).length, 1);
});

test('Assistant source discovery rejects a narrow parking URL even when its code matches the catalog', async () => {
  const responses = [
    developerResponse({
      canonicalUrl: 'https://catalog.developer.example/',
      officialDeveloperName: 'ФСК',
    }, ['https://catalog.developer.example/']),
    projectResponse({
      canonicalUrl: 'https://developer.example/parkings/zhk-citybay/',
      officialProjectName: 'City Bay',
      matchKind: 'EXACT',
    }, ['https://developer.example/projects/']),
    projectResponse({
      canonicalUrl: 'https://developer.example/parkings/zhk-citybay/',
      officialProjectName: 'City Bay',
      matchKind: 'EXACT',
    }, ['https://developer.example/projects/']),
  ];
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async () => responses.shift(),
    {
      async fetch(source) {
        if (source.canonicalUrl === 'https://catalog.developer.example/') {
          return fetchedPage(source.canonicalUrl, [
            '<html><body>Официальный каталог застройщика ФСК City Bay',
            '<a href="https://developer.example/">Официальный сайт проектов</a>',
            '<script type="application/json">',
            JSON.stringify({ items: [{ name: 'City Bay', code: 'zhk-citybay' }] }),
            '</script></body></html>',
          ].join(''));
        }
        throw new SourceConnectorError('SOURCE_ANTI_BOT_CHALLENGE', true, 200);
      },
    },
  );

  const result = await service.discover({
    ...project,
    projectKey: 'zhk-citybay',
    title: 'City Bay',
  });

  assert.equal(result.status, 'REJECTED');
  assert.equal(result.errorCode, 'SOURCE_ANTI_BOT_CHALLENGE');
});

test('Assistant source discovery replaces a narrow cited surface with the exact catalog project citation', async () => {
  const responses = [
    developerResponse({
      canonicalUrl: 'https://catalog.developer.example/',
      officialDeveloperName: 'ФСК',
    }, ['https://catalog.developer.example/']),
    projectResponse({
      canonicalUrl: 'https://developer.example/boxrooms/zhk-mira/',
      officialProjectName: 'МИRA',
      matchKind: 'EXACT',
    }, [
      'https://developer.example/boxrooms/zhk-mira/',
      'https://developer.example/projects/zhk-mira/',
    ]),
  ];
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async () => responses.shift(),
    {
      async fetch(source) {
        if (source.canonicalUrl === 'https://catalog.developer.example/') {
          return fetchedPage(source.canonicalUrl, [
            '<html><body>Официальный каталог застройщика ФСК МИRA',
            '<a href="https://developer.example/">Официальный сайт проектов</a>',
            '<script type="application/json">',
            JSON.stringify({ items: [{ name: 'МИRA', code: 'mira' }] }),
            '</script></body></html>',
          ].join(''));
        }
        throw new SourceConnectorError('SOURCE_ANTI_BOT_CHALLENGE', true, 200);
      },
    },
  );

  const result = await service.discover({
    ...project,
    projectKey: 'zhk-mira',
    title: 'ЖК МИРА',
  });

  assert.equal(result.status, 'VERIFIED', JSON.stringify(result, null, 2));
  assert.equal(result.canonicalUrl, 'https://developer.example/projects/zhk-mira/');
  assert.equal(result.officialProjectName, 'МИRA');
  assert.equal(result.matchKind, 'EXACT');
});

test('Assistant source discovery accepts an exact cited catalog path after structured NOT_FOUND', async () => {
  const responses = [
    developerResponse({
      canonicalUrl: 'https://catalog.developer.example/',
      officialDeveloperName: 'ФСК',
    }, ['https://catalog.developer.example/']),
    projectNotFoundResponse(['https://developer.example/projects/']),
    projectNotFoundResponse(['https://developer.example/projects/zhk-citybay/']),
  ];
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async () => responses.shift(),
    {
      async fetch(source) {
        if (source.canonicalUrl === 'https://catalog.developer.example/') {
          if (source.connectorConfig.browserRenderMode === 'always') {
            return fetchedPage(source.canonicalUrl, [
              '<html><body>Официальный каталог застройщика ФСК City Bay',
              '<a href="https://developer.example/">Официальный сайт проектов</a>',
              '<script type="application/json">',
              JSON.stringify({ items: [{ name: 'City Bay', code: 'zhk-citybay' }] }),
              '</script></body></html>',
            ].join(''));
          }
          return fetchedPage(source.canonicalUrl, [
            '<html><body>Официальный каталог застройщика ФСК',
            '<a href="https://developer.example/">Официальный сайт проектов</a>',
            '</body></html>',
          ].join(''));
        }
        throw new SourceConnectorError('SOURCE_ANTI_BOT_CHALLENGE', true, 200);
      },
    },
  );

  const result = await service.discover({
    ...project,
    projectKey: 'zhk-citybay',
    title: 'City Bay',
  });

  assert.equal(result.status, 'VERIFIED', JSON.stringify(result, null, 2));
  assert.equal(result.canonicalUrl, 'https://developer.example/projects/zhk-citybay/');
  assert.equal(result.officialProjectName, 'City Bay');
  assert.equal(result.telemetry.phases.length, 3);
});

test('Assistant source discovery verifies a bounded known project path before project Web Search', async () => {
  const responses = [
    developerResponse({
      canonicalUrl: 'https://developer.example/',
      officialDeveloperName: 'ФСК',
    }, ['https://developer.example/']),
    projectNotFoundResponse(['https://developer.example/projects']),
  ];
  const fetchedUrls = [];
  const providerBodies = [];
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async (_url, init) => {
      providerBodies.push(JSON.parse(init.body));
      return responses.shift();
    },
    {
      async fetch(source) {
        fetchedUrls.push(source.canonicalUrl);
        if (source.canonicalUrl === 'https://developer.example/') {
          return fetchedPage(source.canonicalUrl, '<html><body>Официальный сайт застройщика ФСК</body></html>');
        }
        if (source.canonicalUrl === 'https://developer.example/projects/amber-city/') {
          return fetchedPage(source.canonicalUrl, '<html><body>ЖК Amber City</body></html>');
        }
        throw new Error('not found');
      },
    },
  );

  const result = await service.discover({
    ...project,
    projectKey: 'zhiloj-kompleks-amber-city',
  });

  assert.equal(result.status, 'VERIFIED', JSON.stringify(result, null, 2));
  assert.equal(result.canonicalUrl, 'https://developer.example/projects/amber-city/');
  assert.equal(providerBodies.length, 1);
  assert.equal(result.telemetry.phases.length, 1);
  assert.match(result.reason, /до обращения к модели/iu);
  assert.ok(fetchedUrls.length <= 21);
});

test('Assistant source discovery accepts a locally verified transliterated known path before Web Search', async () => {
  const transliteratedProject = {
    projectKey: 'zhk-sitidzen',
    title: 'Жилой квартал СИТИДЗЕН',
    developerKey: 'mr-group',
    developerName: 'MR Group',
  };
  const registryUrl = 'https://mr.example/';
  const knownPathUrl = 'https://mr.example/projects/sitidzen/';
  let providerCalls = 0;
  const service = new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async () => {
      providerCalls += 1;
      throw new Error('provider must not be called after a verified transliterated known path');
    },
    {
      async fetch(source) {
        if (source.canonicalUrl === registryUrl) {
          return fetchedPage(source.canonicalUrl, '<html><body>MR Group</body></html>');
        }
        if (source.canonicalUrl === knownPathUrl) {
          return fetchedPage(
            source.canonicalUrl,
            '<html><body>Жилой квартал CITYZEN — проект MR Group</body></html>',
          );
        }
        throw new Error('known path unavailable');
      },
    },
  );

  const result = await service.discover(transliteratedProject, {
    registrySources: [activeRegistrySource({
      type: 'DEVELOPER_PROMOTION',
      canonicalUrl: registryUrl,
      projectKey: null,
      developerKey: transliteratedProject.developerKey,
      allowedHosts: ['mr.example', 'www.mr.example'],
    })],
  });

  assert.equal(result.status, 'VERIFIED', JSON.stringify(result, null, 2));
  assert.equal(result.canonicalUrl, knownPathUrl);
  assert.equal(result.matchKind, 'TRANSLITERATION');
  assert.equal(providerCalls, 0);
  assert.equal(result.telemetry.phases.length, 0);
});

function twoPhaseService(options) {
  const responses = [
    developerResponse({
      canonicalUrl: options.developerUrl,
      officialDeveloperName: options.developerName || 'ФСК',
    }, [options.developerUrl]),
    projectResponse({
      canonicalUrl: options.projectUrl,
      officialProjectName: options.officialProjectName,
      matchKind: options.matchKind,
    }, [options.projectUrl]),
    projectResponse({
      canonicalUrl: options.projectUrl,
      officialProjectName: options.officialProjectName,
      matchKind: options.matchKind,
    }, [options.projectUrl]),
  ];
  return new AssistantSourceDiscoveryService(
    discoveryEnvironment(),
    async () => responses.shift(),
    {
      async fetch(source) {
        if (source.canonicalUrl === options.developerUrl) {
          return fetchedPage(source.canonicalUrl, options.developerHtml);
        }
        return fetchedPage(source.canonicalUrl, options.projectHtml);
      },
    },
  );
}

function discoveryEnvironment() {
  return {
    OPENAI_API_KEY: 'test-only',
    ASSISTANT_SOURCE_DISCOVERY_MODEL: 'gpt-5.6-luna',
  };
}

function developerResponse(overrides, citations) {
  return openAiResponse({
    status: 'FOUND',
    canonicalUrl: overrides.canonicalUrl,
    officialDeveloperName: overrides.officialDeveloperName,
    reason: 'Официальный сайт застройщика.',
  }, citations, 'resp_developer');
}

function developerNotFoundResponse(citations) {
  return openAiResponse({
    status: 'NOT_FOUND',
    canonicalUrl: null,
    officialDeveloperName: null,
    reason: 'Другая официальная страница не выбрана.',
  }, citations, 'resp_developer_alternative');
}

function projectResponse(overrides, citations) {
  return openAiResponse({
    status: 'FOUND',
    canonicalUrl: overrides.canonicalUrl,
    officialProjectName: overrides.officialProjectName,
    matchKind: overrides.matchKind,
    reason: 'Проект найден внутри официального контура застройщика.',
  }, citations, 'resp_project');
}

function projectNotFoundResponse(citations) {
  return openAiResponse({
    status: 'NOT_FOUND',
    canonicalUrl: null,
    officialProjectName: null,
    matchKind: null,
    reason: 'Проект не найден внутри официального контура застройщика.',
  }, citations, 'resp_project');
}

function openAiResponse(candidate, citations, responseId) {
  return new Response(JSON.stringify({
    id: responseId,
    output: [
      {
        type: 'web_search_call',
        action: {
          sources: citations.map((url) => ({ type: 'url', url })),
        },
      },
      {
        type: 'message',
        content: [{
          type: 'output_text',
          text: JSON.stringify(candidate),
          annotations: citations.map((url) => ({ type: 'url_citation', url, title: 'Источник' })),
        }],
      },
    ],
    usage: {
      input_tokens: 20,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 13,
      output_tokens_details: { reasoning_tokens: 5 },
      total_tokens: 33,
    },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-request-id': `req_${responseId}` },
  });
}

function activeRegistrySource({
  type,
  canonicalUrl,
  projectKey,
  developerKey,
  allowedHosts,
}) {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    state: 'ACTIVE',
    type,
    canonicalUrl,
    projectKey,
    developerKey,
    connectorKey: 'OFFICIAL_HTML',
    connectorConfig: { allowedHosts },
    latestRevision: {
      processingStatus: 'INDEXED',
      checksum: 'c'.repeat(64),
    },
  };
}

function fetchedPage(finalUrl, html) {
  return {
    finalUrl,
    statusCode: 200,
    contentType: 'text/html',
    checksum: 'a'.repeat(64),
    payload: Buffer.from(html),
    etag: null,
    lastModified: null,
    redirects: [],
  };
}
