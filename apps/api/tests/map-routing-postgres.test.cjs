require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const { after, before, beforeEach, test } = require('node:test');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { JwtService } = require('@nestjs/jwt');
const { PrismaClient } = require('@prisma/client');

const databaseUrl = process.env.MAP_ROUTING_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('Map routing PostgreSQL scenarios require the targeted disposable database runner', () => {
    assert.equal(process.env.MAP_ROUTING_TEST_DATABASE_URL, undefined);
  });
} else {
  process.env.JWT_ACCESS_SECRET = 'map-routing-postgres-secret';
  process.env.OPENROUTESERVICE_API_KEY = 'map-routing-postgres-provider-key';
  process.env.OPENROUTESERVICE_MAX_RETRIES = '0';

  const { JwtAuthGuard } = require('../dist/auth/jwt-auth.guard.js');
  const { PermissionsGuard } = require('../dist/auth/permissions.guard.js');
  const { MapController } = require('../dist/map/map.controller.js');
  const { MapRoutingService } = require('../dist/map/map-routing.service.js');
  const { MapService } = require('../dist/map/map.service.js');
  const { PrismaService } = require('../dist/prisma/prisma.service.js');

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const jwt = new JwtService();
  const fixtureSuffix = randomUUID();
  let roleId;
  let userId;
  let token;
  let prismaConnected = false;

  before(async () => {
    await prisma.$connect();
    prismaConnected = true;
    const permission = await prisma.permission.upsert({
      where: { key: 'objects:read' },
      update: {},
      create: { key: 'objects:read' },
    });
    const role = await prisma.role.create({
      data: {
        name: `map-routing-postgres-${fixtureSuffix}`,
        permissions: { create: { permissionId: permission.id } },
      },
    });
    const user = await prisma.user.create({
      data: {
        email: `map-routing-${fixtureSuffix}@example.test`,
        name: 'Map routing PostgreSQL user',
        passwordHash: 'not-used',
        roleId: role.id,
        status: 'ACTIVE',
      },
    });
    roleId = role.id;
    userId = user.id;
    token = jwt.sign(
      { sub: user.id, email: user.email, type: 'access' },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' },
    );
  });

  beforeEach(async () => {
    await prisma.mapWalkingRouteCache.deleteMany();
  });

  after(async () => {
    if (!prismaConnected) return;

    await prisma.mapWalkingRouteCache.deleteMany();
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
    if (roleId) await prisma.role.deleteMany({ where: { id: roleId } });
    await prisma.$disconnect();
  });

  test('walking route cache survives a new Nest application instance', { concurrency: false }, async () => {
    let providerCalls = 0;
    const providerServer = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        providerCalls += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ distances: [[920]], durations: [[680]] }));
      });
    });
    await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
    const providerAddress = providerServer.address();
    assert.equal(typeof providerAddress, 'object');
    process.env.OPENROUTESERVICE_API_URL = `http://127.0.0.1:${providerAddress.port}`;
    const body = {
      origin: [55.75, 37.61],
      destinations: [[55.76, 37.62]],
    };

    try {
      const firstApp = await startApp();
      assert.deepEqual(await request(firstApp.baseUrl, body), {
        status: 200,
        body: { routes: [{ destinationIndex: 0, distanceMeters: 920, durationSeconds: 680 }] },
      });
      await firstApp.app.close();

      const configuredApiKey = process.env.OPENROUTESERVICE_API_KEY;
      let restartedApp;

      try {
        delete process.env.OPENROUTESERVICE_API_KEY;
        restartedApp = await startApp();
        assert.deepEqual(await request(restartedApp.baseUrl, body), {
          status: 200,
          body: { routes: [{ destinationIndex: 0, distanceMeters: 920, durationSeconds: 680 }] },
        });
      } finally {
        await restartedApp?.app.close();
        process.env.OPENROUTESERVICE_API_KEY = configuredApiKey;
      }

      assert.equal(providerCalls, 1);
    } finally {
      await new Promise((resolve, reject) => providerServer.close((error) => (error ? reject(error) : resolve())));
    }
  });

  test('changed origin or destination coordinates create a new persistent route calculation', { concurrency: false }, async () => {
    let providerCalls = 0;
    const providerServer = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        providerCalls += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ distances: [[800 + providerCalls]], durations: [[600 + providerCalls]] }));
      });
    });
    await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
    const providerAddress = providerServer.address();
    assert.equal(typeof providerAddress, 'object');
    process.env.OPENROUTESERVICE_API_URL = `http://127.0.0.1:${providerAddress.port}`;
    const runningApp = await startApp();
    const originalBody = {
      origin: [55.73, 37.53],
      destinations: [[55.74, 37.54]],
    };

    try {
      assert.equal((await request(runningApp.baseUrl, originalBody)).body.routes[0].distanceMeters, 801);
      assert.equal((await request(runningApp.baseUrl, originalBody)).body.routes[0].distanceMeters, 801);
      assert.equal(
        (await request(runningApp.baseUrl, { ...originalBody, origin: [55.73001, 37.53] })).body.routes[0]
          .distanceMeters,
        802,
      );
      assert.equal(
        (
          await request(runningApp.baseUrl, {
            ...originalBody,
            destinations: [[55.74001, 37.54]],
          })
        ).body.routes[0].distanceMeters,
        803,
      );
      assert.equal(providerCalls, 3);
    } finally {
      await runningApp.app.close();
      await new Promise((resolve, reject) => providerServer.close((error) => (error ? reject(error) : resolve())));
    }
  });

  test('stale walking route is served while one background refresh replaces it', { concurrency: false }, async () => {
    let providerCalls = 0;
    const refreshBarrier = createBarrier(2_000, 'Stale route refresh did not reach the provider');
    const providerServer = createServer((request, response) => {
      request.resume();
      request.on('end', async () => {
        providerCalls += 1;

        if (providerCalls === 2) {
          refreshBarrier.arrive();
          await refreshBarrier.waitForRelease();
        }

        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify(
            providerCalls === 1
              ? { distances: [[1000]], durations: [[700]] }
              : { distances: [[1110]], durations: [[760]] },
          ),
        );
      });
    });
    await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
    const providerAddress = providerServer.address();
    assert.equal(typeof providerAddress, 'object');
    process.env.OPENROUTESERVICE_API_URL = `http://127.0.0.1:${providerAddress.port}`;
    const body = {
      origin: [55.71, 37.51],
      destinations: [[55.72, 37.52]],
    };
    const runningApp = await startApp();

    try {
      assert.deepEqual(await request(runningApp.baseUrl, body), {
        status: 200,
        body: { routes: [{ destinationIndex: 0, distanceMeters: 1000, durationSeconds: 700 }] },
      });
      await prisma.mapWalkingRouteCache.updateMany({
        where: { originLatitude: '55.710000', originLongitude: '37.510000' },
        data: { calculatedAt: new Date(Date.now() - 181 * 24 * 60 * 60 * 1_000) },
      });

      assert.deepEqual(await request(runningApp.baseUrl, body), {
        status: 200,
        body: { routes: [{ destinationIndex: 0, distanceMeters: 1000, durationSeconds: 700 }] },
      });
      await refreshBarrier.waitForArrival();
      assert.equal(providerCalls, 2);
      refreshBarrier.release();

      await waitFor(async () => {
        const refreshed = await request(runningApp.baseUrl, body);
        return refreshed.body.routes?.[0]?.distanceMeters === 1110;
      });
    } finally {
      refreshBarrier.release();
      await runningApp.app.close();
      await new Promise((resolve, reject) => providerServer.close((error) => (error ? reject(error) : resolve())));
    }
  });

  test('failed background refresh leaves stale walking route available', { concurrency: false }, async () => {
    let providerCalls = 0;
    const failedRefreshBarrier = createBarrier(2_000, 'Failed stale refresh did not reach the provider');
    const providerServer = createServer((request, response) => {
      request.resume();
      request.on('end', async () => {
        providerCalls += 1;

        if (providerCalls > 1) {
          failedRefreshBarrier.arrive();
          await failedRefreshBarrier.waitForRelease();
          response.writeHead(503, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ message: 'temporary failure' }));
          return;
        }

        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ distances: [[990]], durations: [[690]] }));
      });
    });
    await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
    const providerAddress = providerServer.address();
    assert.equal(typeof providerAddress, 'object');
    process.env.OPENROUTESERVICE_API_URL = `http://127.0.0.1:${providerAddress.port}`;
    const body = {
      origin: [55.69, 37.49],
      destinations: [[55.7, 37.5]],
    };
    const runningApp = await startApp();
    const staleAt = new Date(Date.now() - 181 * 24 * 60 * 60 * 1_000);

    try {
      assert.equal((await request(runningApp.baseUrl, body)).body.routes[0].distanceMeters, 990);
      await prisma.mapWalkingRouteCache.updateMany({
        where: { originLatitude: '55.690000', originLongitude: '37.490000' },
        data: { calculatedAt: staleAt },
      });

      assert.equal((await request(runningApp.baseUrl, body)).body.routes[0].distanceMeters, 990);
      await failedRefreshBarrier.waitForArrival();
      failedRefreshBarrier.release();
      await waitFor(() => runningApp.routingService.inFlightRequests.size === 0);

      const cachedAfterFailure = await prisma.mapWalkingRouteCache.findFirstOrThrow({
        where: { originLatitude: '55.690000', originLongitude: '37.490000' },
      });
      assert.equal(cachedAfterFailure.distanceMeters, 990);
      assert.equal(cachedAfterFailure.durationSeconds, 690);
      assert.equal(cachedAfterFailure.calculatedAt.getTime(), staleAt.getTime());
      assert.equal((await request(runningApp.baseUrl, body)).body.routes[0].distanceMeters, 990);
      await waitFor(() => runningApp.routingService.inFlightRequests.size === 0);
    } finally {
      failedRefreshBarrier.release();
      await runningApp.app.close();
      await new Promise((resolve, reject) => providerServer.close((error) => (error ? reject(error) : resolve())));
    }
  });

  async function startApp() {
    class MapRoutingPostgresTestModule {}
    Module({
      controllers: [MapController],
      providers: [
        JwtService,
        JwtAuthGuard,
        PermissionsGuard,
        MapRoutingService,
        { provide: PrismaService, useValue: prisma },
        { provide: MapService, useValue: { listObjects: async () => ({ items: [], total: 0 }) } },
      ],
    })(MapRoutingPostgresTestModule);

    const app = await NestFactory.create(MapRoutingPostgresTestModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    assert.equal(typeof address, 'object');

    return {
      app,
      baseUrl: `http://127.0.0.1:${address.port}`,
      routingService: app.get(MapRoutingService),
    };
  }

  async function request(baseUrl, body) {
    const response = await fetch(`${baseUrl}/map/walking-routes`, {
      body: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });

    return { status: response.status, body: await response.json() };
  }

  function createBarrier(timeoutMs, timeoutMessage) {
    let signalArrival;
    let signalRelease;
    const arrival = new Promise((resolve) => {
      signalArrival = resolve;
    });
    const release = new Promise((resolve) => {
      signalRelease = resolve;
    });

    return {
      arrive: () => signalArrival(),
      release: () => signalRelease(),
      waitForRelease: () => release,
      waitForArrival: () => Promise.race([
        arrival,
        new Promise((_, reject) => setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)),
      ]),
    };
  }

  async function waitFor(predicate, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    throw new Error('Timed out waiting for walking route cache update');
  }
}
