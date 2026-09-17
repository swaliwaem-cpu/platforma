require('reflect-metadata');

const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const test = require('node:test');

const { MapRoutingService } = require('../dist/map/map-routing.service.js');

test('MapRoutingService returns walking matrix routes and caches identical requests', { concurrency: false }, async () => {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';

    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push({
        authorization: request.headers.authorization,
        body: JSON.parse(body),
        method: request.method,
        url: request.url,
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          distances: [[1200.4, 2500.6, 1200.4]],
          durations: [[900.2, 1800.7, 900.2]],
        }),
      );
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  const previousEnvironment = {
    apiKey: process.env.OPENROUTESERVICE_API_KEY,
    apiUrl: process.env.OPENROUTESERVICE_API_URL,
    cacheStaleAfter: process.env.OPENROUTESERVICE_CACHE_STALE_AFTER_MS,
  };
  process.env.OPENROUTESERVICE_API_KEY = 'test-routing-key';
  process.env.OPENROUTESERVICE_API_URL = `http://127.0.0.1:${address.port}`;
  process.env.OPENROUTESERVICE_CACHE_STALE_AFTER_MS = '60000';

  try {
    const service = new MapRoutingService(createTestPrisma());
    const input = {
      origin: [55.75, 37.61],
      destinations: [
        [55.76, 37.62],
        [55.77, 37.63],
        [55.76, 37.62],
      ],
    };

    const [firstResult, concurrentResult] = await Promise.all([
      service.getWalkingRoutes(input),
      service.getWalkingRoutes(input),
    ]);
    const cachedResult = await service.getWalkingRoutes(input);

    assert.deepEqual(firstResult, {
      routes: [
        { destinationIndex: 0, distanceMeters: 1200, durationSeconds: 900 },
        { destinationIndex: 1, distanceMeters: 2501, durationSeconds: 1801 },
        { destinationIndex: 2, distanceMeters: 1200, durationSeconds: 900 },
      ],
    });
    assert.deepEqual(concurrentResult, firstResult);
    assert.deepEqual(cachedResult, firstResult);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], {
      authorization: 'test-routing-key',
      body: {
        destinations: [1, 2, 3],
        locations: [
          [37.61, 55.75],
          [37.62, 55.76],
          [37.63, 55.77],
          [37.62, 55.76],
        ],
        metrics: ['distance', 'duration'],
        sources: [0],
        units: 'm',
      },
      method: 'POST',
      url: '/v2/matrix/foot-walking',
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    restoreEnvironment('OPENROUTESERVICE_API_KEY', previousEnvironment.apiKey);
    restoreEnvironment('OPENROUTESERVICE_API_URL', previousEnvironment.apiUrl);
    restoreEnvironment('OPENROUTESERVICE_CACHE_STALE_AFTER_MS', previousEnvironment.cacheStaleAfter);
  }
});

test('MapRoutingService rejects invalid coordinates and more than three destinations before calling the provider', { concurrency: false }, async () => {
  const previousEnvironment = {
    apiKey: process.env.OPENROUTESERVICE_API_KEY,
    apiUrl: process.env.OPENROUTESERVICE_API_URL,
  };
  process.env.OPENROUTESERVICE_API_KEY = 'test-routing-key';
  process.env.OPENROUTESERVICE_API_URL = 'http://127.0.0.1:1';

  try {
    const service = new MapRoutingService(createTestPrisma());

    await assert.rejects(
      service.getWalkingRoutes({
        origin: [95, 37.61],
        destinations: [[55.76, 37.62]],
      }),
      (error) => error?.getStatus?.() === 400 && error?.message === 'Origin coordinates are invalid',
    );
    await assert.rejects(
      service.getWalkingRoutes({
        origin: [55.75, 37.61],
        destinations: [
          [55.76, 37.62],
          [55.77, 37.63],
          [55.78, 37.64],
          [55.79, 37.65],
        ],
      }),
      (error) => error?.getStatus?.() === 400 && error?.message === 'Up to three destinations are allowed',
    );
  } finally {
    restoreEnvironment('OPENROUTESERVICE_API_KEY', previousEnvironment.apiKey);
    restoreEnvironment('OPENROUTESERVICE_API_URL', previousEnvironment.apiUrl);
  }
});

test('MapRoutingService preserves an unreachable walking destination without dropping other matrix results', { concurrency: false }, async () => {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ distances: [[null, 1700]], durations: [[null, 1230]] }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  const previousEnvironment = {
    apiKey: process.env.OPENROUTESERVICE_API_KEY,
    apiUrl: process.env.OPENROUTESERVICE_API_URL,
  };
  process.env.OPENROUTESERVICE_API_KEY = 'test-routing-key';
  process.env.OPENROUTESERVICE_API_URL = `http://127.0.0.1:${address.port}`;

  try {
    const service = new MapRoutingService(createTestPrisma());
    const result = await service.getWalkingRoutes({
      origin: [55.75, 37.61],
      destinations: [
        [55.76, 37.62],
        [55.77, 37.63],
      ],
    });

    assert.deepEqual(result, {
      routes: [
        { destinationIndex: 0, distanceMeters: null, durationSeconds: null },
        { destinationIndex: 1, distanceMeters: 1700, durationSeconds: 1230 },
      ],
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    restoreEnvironment('OPENROUTESERVICE_API_KEY', previousEnvironment.apiKey);
    restoreEnvironment('OPENROUTESERVICE_API_URL', previousEnvironment.apiUrl);
  }
});

test('MapRoutingService retries temporary provider failures and respects Retry-After', { concurrency: false }, async () => {
  let calls = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      calls += 1;

      if (calls === 1) {
        response.writeHead(429, { 'retry-after': '0' });
        response.end();
        return;
      }

      if (calls === 2) {
        response.writeHead(503);
        response.end();
        return;
      }

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ distances: [[840]], durations: [[610]] }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  const previousEnvironment = captureEnvironment([
    'OPENROUTESERVICE_API_KEY',
    'OPENROUTESERVICE_API_URL',
    'OPENROUTESERVICE_MAX_RETRIES',
  ]);
  process.env.OPENROUTESERVICE_API_KEY = 'test-routing-key';
  process.env.OPENROUTESERVICE_API_URL = `http://127.0.0.1:${address.port}`;
  process.env.OPENROUTESERVICE_MAX_RETRIES = '2';

  try {
    const service = new MapRoutingService(createTestPrisma());
    const result = await service.getWalkingRoutes({
      origin: [55.75, 37.61],
      destinations: [[55.76, 37.62]],
    });

    assert.deepEqual(result, {
      routes: [{ destinationIndex: 0, distanceMeters: 840, durationSeconds: 610 }],
    });
    assert.equal(calls, 3);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    restoreCapturedEnvironment(previousEnvironment);
  }
});

test('MapRoutingService does not retry permanent provider authorization failures', { concurrency: false }, async () => {
  let calls = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      calls += 1;
      response.writeHead(401);
      response.end();
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  const previousEnvironment = captureEnvironment([
    'OPENROUTESERVICE_API_KEY',
    'OPENROUTESERVICE_API_URL',
    'OPENROUTESERVICE_MAX_RETRIES',
  ]);
  process.env.OPENROUTESERVICE_API_KEY = 'invalid-routing-key';
  process.env.OPENROUTESERVICE_API_URL = `http://127.0.0.1:${address.port}`;
  process.env.OPENROUTESERVICE_MAX_RETRIES = '2';

  try {
    const service = new MapRoutingService(createTestPrisma());

    await assert.rejects(
      service.getWalkingRoutes({
        origin: [55.75, 37.61],
        destinations: [[55.76, 37.62]],
      }),
      (error) => error?.getStatus?.() === 503 && error?.message === 'Walking routes are not configured correctly',
    );
    assert.equal(calls, 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    restoreCapturedEnvironment(previousEnvironment);
  }
});

test('MapRoutingService bounds a timed out provider request', { concurrency: false }, async () => {
  let calls = 0;
  const server = createServer((request) => {
    calls += 1;
    request.resume();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  const previousEnvironment = captureEnvironment([
    'OPENROUTESERVICE_API_KEY',
    'OPENROUTESERVICE_API_URL',
    'OPENROUTESERVICE_MAX_RETRIES',
    'OPENROUTESERVICE_TIMEOUT_MS',
  ]);
  process.env.OPENROUTESERVICE_API_KEY = 'test-routing-key';
  process.env.OPENROUTESERVICE_API_URL = `http://127.0.0.1:${address.port}`;
  process.env.OPENROUTESERVICE_MAX_RETRIES = '0';
  process.env.OPENROUTESERVICE_TIMEOUT_MS = '30';

  try {
    const service = new MapRoutingService(createTestPrisma());

    await assert.rejects(
      service.getWalkingRoutes({
        origin: [55.75, 37.61],
        destinations: [[55.76, 37.62]],
      }),
      (error) => error?.getStatus?.() === 504 && error?.message === 'Walking route provider timed out',
    );
    assert.equal(calls, 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    restoreCapturedEnvironment(previousEnvironment);
  }
});

function restoreEnvironment(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function createTestPrisma() {
  const routeCache = new Map();

  return {
    mapWalkingRouteCache: {
      findMany: async ({ where }) =>
        [...new Set(where.cacheKey.in)].flatMap((cacheKey) =>
          routeCache.has(cacheKey) ? [routeCache.get(cacheKey)] : [],
        ),
      upsert: async ({ where, create, update }) => {
        const value = routeCache.has(where.cacheKey)
          ? { ...routeCache.get(where.cacheKey), ...update }
          : { ...create };
        routeCache.set(where.cacheKey, value);
        return value;
      },
    },
    $transaction: async (operations) => Promise.all(operations),
  };
}

function captureEnvironment(names) {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreCapturedEnvironment(environment) {
  for (const [name, value] of Object.entries(environment)) {
    restoreEnvironment(name, value);
  }
}

test('MapRoutingService warms missing walking routes through multi-source matrix requests', { concurrency: false }, async () => {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';

    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const parsed = JSON.parse(body);
      requests.push({ body: parsed, url: request.url });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        distances: parsed.sources.map((_, row) => parsed.destinations.map((_, column) => 100 * (row + 1) + column + 0.4)),
        durations: parsed.sources.map((_, row) => parsed.destinations.map((_, column) => 60 * (row + 1) + column + 0.2)),
      }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const previousEnvironment = captureEnvironment([
    'OPENROUTESERVICE_API_KEY',
    'OPENROUTESERVICE_API_URL',
    'OPENROUTESERVICE_CACHE_STALE_AFTER_MS',
    'OPENROUTESERVICE_MATRIX_MAX_ROUTES',
  ]);
  process.env.OPENROUTESERVICE_API_KEY = 'test-routing-key';
  process.env.OPENROUTESERVICE_API_URL = `http://127.0.0.1:${address.port}`;
  process.env.OPENROUTESERVICE_CACHE_STALE_AFTER_MS = '60000';
  delete process.env.OPENROUTESERVICE_MATRIX_MAX_ROUTES;

  try {
    const service = new MapRoutingService(createTestPrisma());
    const first = { origin: [55.75, 37.61], destinations: [[55.76, 37.62], [55.77, 37.63]] };
    const second = { origin: [55.7, 37.6], destinations: [[55.76, 37.62], [55.71, 37.61]] };

    assert.deepEqual(await service.warmWalkingRoutes([first, second]), {
      requests: 2,
      pairs: 4,
      fetched: 4,
      providerCalls: 1,
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/v2/matrix/foot-walking');
    assert.deepEqual(requests[0].body.sources, [0, 1]);
    assert.deepEqual(requests[0].body.destinations, [2, 3, 4]);
    assert.deepEqual(requests[0].body.locations, [
      [37.61, 55.75],
      [37.6, 55.7],
      [37.62, 55.76],
      [37.63, 55.77],
      [37.61, 55.71],
    ]);

    assert.deepEqual(await service.getWalkingRoutes(first), {
      routes: [
        { destinationIndex: 0, distanceMeters: 100, durationSeconds: 60 },
        { destinationIndex: 1, distanceMeters: 101, durationSeconds: 61 },
      ],
    });
    assert.deepEqual(await service.getWalkingRoutes(second), {
      routes: [
        { destinationIndex: 0, distanceMeters: 200, durationSeconds: 120 },
        { destinationIndex: 1, distanceMeters: 202, durationSeconds: 122 },
      ],
    });
    assert.deepEqual(await service.warmWalkingRoutes([first, second]), {
      requests: 2,
      pairs: 4,
      fetched: 0,
      providerCalls: 0,
    });
    assert.equal(requests.length, 1, 'fresh cache entries must not be fetched again');

    process.env.OPENROUTESERVICE_MATRIX_MAX_ROUTES = '4';
    const limited = new MapRoutingService(createTestPrisma());
    const origins = [[55.8, 37.5], [55.81, 37.51], [55.82, 37.52]];
    const summary = await limited.warmWalkingRoutes(origins.map(([latitude, longitude]) => ({
      origin: [latitude, longitude],
      destinations: [[latitude + 0.01, longitude], [latitude, longitude + 0.01]],
    })));
    assert.deepEqual(summary, { requests: 3, pairs: 6, fetched: 6, providerCalls: 3 });
    assert.deepEqual(requests.slice(1).map(({ body }) => body.sources), [[0], [0], [0]]);

    await assert.rejects(service.warmWalkingRoutes({ origin: [55.75, 37.61], destinations: [] }), /invalid/u);
    await assert.rejects(
      service.warmWalkingRoutes([{ origin: [95, 37.61], destinations: [[55.76, 37.62]] }]),
      /Origin coordinates are invalid/u,
    );
    assert.equal(requests.length, 4);
  } finally {
    restoreCapturedEnvironment(previousEnvironment);
    server.close();
  }
});
