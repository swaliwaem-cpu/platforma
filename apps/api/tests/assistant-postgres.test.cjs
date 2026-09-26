require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const { PrismaClient } = require('@prisma/client');

const databaseUrl = process.env.ASSISTANT_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('Assistant PostgreSQL scenarios require the targeted disposable database runner', () => {
    assert.equal(process.env.ASSISTANT_TEST_DATABASE_URL, undefined);
  });
} else {
  const { AssistantCatalogTools } = require('../dist/assistant/assistant-catalog.tools.js');
  const { AssistantTurnLogService } = require('../dist/assistant/assistant-turn-log.service.js');

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const catalog = new AssistantCatalogTools(prisma);
  const turnLog = new AssistantTurnLogService(prisma);
  const suffix = randomUUID().slice(0, 8);
  const now = new Date('2026-09-26T12:00:00Z');
  const ids = {};
  let connected = false;

  before(async () => {
    await prisma.$connect();
    connected = true;
    const developer = await prisma.developer.create({ data: { name: `Assistant test developer ${suffix}` } });
    const source = await prisma.feedSource.create({ data: { format: 'YANDEX_REALTY', developerId: developer.id, url: `https://feeds.example.test/${suffix}.xml` } });
    const deluxe = await prisma.realEstateObject.create({
      data: {
        title: `Тест Делюкс ${suffix}`,
        slug: `test-deluxe-${suffix}`,
        status: 'PUBLISHED',
        propertyClass: 'Делюкс',
        developerId: developer.id,
        completionYear: 2024,
        completionQuarter: 1,
      },
    });
    const business = await prisma.realEstateObject.create({
      data: {
        title: `Тест Бизнес ${suffix}`,
        slug: `test-business-${suffix}`,
        status: 'PUBLISHED',
        propertyClass: 'Бизнес-класс',
        developerId: developer.id,
        completionYear: 2029,
      },
    });
    Object.assign(ids, { developerId: developer.id, sourceId: source.id, deluxeId: deluxe.id, businessId: business.id });

    const unit = async (key, objectId, data, details) => {
      const created = await prisma.feedUnit.create({
        data: {
          sourceId: source.id,
          objectId,
          externalId: `${key}-${suffix}`,
          type: 'RESIDENTIAL',
          status: 'AVAILABLE',
          ...data,
        },
      });
      if (details) await prisma.feedResidentialUnitDetails.create({ data: { unitId: created.id, detailsJson: details } });
      ids[key] = created.id;
    };
    await unit('a1', deluxe.id, { rooms: 2, area: 100, price: 250_000_000, pricePerMeter: 2_500_000 }, { decoration: 'Без отделки', ceilingHeight: '3.6' });
    await unit('a2', deluxe.id, { rooms: 3, area: 100, price: 290_000_000, pricePerMeter: 2_900_000, rawPayload: { '@_Furniture': '1' } }, { renovation: 'чистовая отделка', ceilingHeight: '3,8' });
    await unit('a3', deluxe.id, { rooms: 2, area: 100, price: 280_000_000, pricePerMeter: 2_800_000 }, null);
    await unit('b1', business.id, { rooms: 1, area: 40, price: 20_000_000, pricePerMeter: 500_000 }, { decoration: '30' });
    await unit('b2', business.id, { rooms: 1, area: 40, price: 22_000_000, pricePerMeter: 550_000, status: 'SOLD' }, { decoration: 'WB' });
    await unit('b3', business.id, { rooms: 2, area: 60, price: 30_000_000, pricePerMeter: 500_000 }, { renovation: 'Предчистовая' });

    const [accessPoint] = await prisma.$queryRaw`
      INSERT INTO assistant_metro_access_points
        (id, source_external_id, station_name, dataset_version, latitude, longitude, location, updated_at)
      VALUES (gen_random_uuid(), ${`test-${suffix}`}, 'Кропоткинская', ${`test-${suffix}`}, 55.745, 37.603,
        ST_SetSRID(ST_MakePoint(37.603, 55.745), 4326)::geography, now())
      RETURNING id::text AS id
    `;
    ids.accessPointId = accessPoint.id;
    await prisma.assistantObjectMetroRouteFact.create({
      data: {
        objectId: deluxe.id,
        metroAccessPointId: accessPoint.id,
        objectLatitude: 55.74,
        objectLongitude: 37.6,
        accessDatasetVersion: `test-${suffix}`,
        routingProfile: 'foot-walking',
        durationSeconds: 480,
        distanceMeters: 600,
        calculatedAt: now,
      },
    });

    const role = await prisma.role.create({ data: { name: `assistant-postgres-${suffix}` } });
    const user = await prisma.user.create({
      data: { email: `assistant-${suffix}@example.test`, passwordHash: 'not-used', roleId: role.id, status: 'ACTIVE' },
    });
    Object.assign(ids, { roleId: role.id, userId: user.id });
  });

  after(async () => {
    if (!connected) return;
    await prisma.assistantTurn.deleteMany({ where: { userId: ids.userId } });
    if (ids.userId) await prisma.user.deleteMany({ where: { id: ids.userId } });
    if (ids.roleId) await prisma.role.deleteMany({ where: { id: ids.roleId } });
    await prisma.assistantObjectMetroRouteFact.deleteMany({ where: { objectId: ids.deluxeId } });
    if (ids.accessPointId) await prisma.$executeRaw`DELETE FROM assistant_metro_access_points WHERE id = ${ids.accessPointId}::uuid`;
    await prisma.realEstateObject.deleteMany({ where: { id: { in: [ids.deluxeId, ids.businessId].filter(Boolean) } } });
    if (ids.sourceId) await prisma.feedSource.deleteMany({ where: { id: ids.sourceId } });
    if (ids.developerId) await prisma.developer.deleteMany({ where: { id: ids.developerId } });
    await prisma.$disconnect();
  });

  const lotIds = (result) => result.lots.map((lot) => Object.entries(ids).find(([, id]) => id === lot.unitId)?.[0]).sort();
  const scoped = (input) => ({ projectIds: [ids.deluxeId, ids.businessId], ...input });

  test('class, price per m² and metro walk filters run in SQL', { concurrency: false }, async () => {
    assert.deepEqual(lotIds(await catalog.searchLots(scoped({ propertyClasses: ['Делюкс'] }), now)), ['a1', 'a2', 'a3']);
    assert.deepEqual(lotIds(await catalog.searchLots(scoped({ propertyClasses: ['Бизнес-класс'] }), now)), ['b1', 'b3']);
    assert.deepEqual(lotIds(await catalog.searchLots(scoped({ pricePerM2Max: 600_000 }), now)), ['b1', 'b3']);
    assert.deepEqual(lotIds(await catalog.searchLots(scoped({ pricePerM2Min: 2_600_000, pricePerM2Max: 2_850_000 }), now)), ['a3']);
    assert.deepEqual(lotIds(await catalog.searchLots(scoped({ metroWalkMinutesMax: 10 }), now)), ['a1', 'a2', 'a3']);
    assert.deepEqual(lotIds(await catalog.searchLots(scoped({ metroWalkMinutesMax: 5 }), now)), []);
    assert.deepEqual(lotIds(await catalog.searchLots(scoped({ completed: true }), now)), ['a1', 'a2', 'a3']);
    assert.deepEqual(lotIds(await catalog.searchLots(scoped({ completed: false }), now)), ['b1', 'b3']);
    assert.deepEqual(lotIds(await catalog.searchLots(scoped({ completionYearMin: 2028 }), now)), ['b1', 'b3']);
  });

  test('finishing is normalized from feed values and lots without it are counted apart', { concurrency: false }, async () => {
    const furnished = await catalog.searchLots(scoped({ finishing: ['с мебелью'] }), now);
    assert.deepEqual(lotIds(furnished), ['a2']);
    assert.equal(furnished.lots[0].finishing, 'с мебелью');
    assert.equal(furnished.lots[0].propertyClass, 'Делюкс');
    assert.equal(furnished.lots[0].pricePerM2Rub, 2_900_000);
    assert.equal(furnished.lotsWithoutFinishingData, 1);

    assert.deepEqual(lotIds(await catalog.searchLots(scoped({ finishing: ['white box'] }), now)), ['b1', 'b3']);
    assert.deepEqual(lotIds(await catalog.searchLots(scoped({ finishing: ['без отделки', 'с отделкой'] }), now)), ['a1', 'a2']);
  });

  test('project facts come from the card and the available lots', { concurrency: false }, async () => {
    const facts = await catalog.getProjectFacts(ids.deluxeId);

    assert.equal(facts.propertyClass, 'Делюкс');
    assert.deepEqual(facts.nearestMetroWalk, { station: 'Кропоткинская', minutes: 8 });
    assert.equal(facts.availableLots, 3);
    assert.equal(facts.priceFromRub, 250_000_000);
    assert.equal(facts.pricePerM2FromRub, 2_500_000);
    assert.deepEqual(facts.lotCeilingHeightM, { min: 3.6, max: 3.8 });
    assert.deepEqual(facts.finishing.map((item) => [item.finishing, item.lots]).sort(), [['без отделки', 1], ['с мебелью', 1]]);
    assert.equal(facts.lotsWithoutFinishingData, 1);
    assert.equal(facts.completion, '1 кв. 2024');
    assert.equal(await catalog.getProjectFacts(randomUUID()), null);
  });

  test('turns older than 90 days are deleted and usage counts Moscow days', { concurrency: false }, async () => {
    const telemetry = { modelCalls: 1, inputTokens: 1000, cachedTokens: 200, outputTokens: 100, webSearches: 0, openedPages: 0, trace: [] };
    const answer = { text: 'ok', lots: [], sources: [], historyNote: 'ok', turnId: null };
    const entry = (id, occurredAt) => ({
      id, userId: ids.userId, conversationId: null, question: 'q', answer, telemetry,
      model: 'deepseek-v4.1-flash', durationMs: 10, errorCode: null, occurredAt,
    });
    const oldId = randomUUID();
    const freshId = randomUUID();
    await turnLog.record(entry(oldId, new Date(now.getTime() - 91 * 24 * 60 * 60_000)));
    await turnLog.record(entry(freshId, new Date('2026-09-25T22:30:00Z')));
    await turnLog.rate({ id: ids.userId }, freshId, { rating: 'DOWN', comment: 'не то' });

    assert.equal(await turnLog.purgeExpired(now), 1);
    assert.equal(await prisma.assistantTurn.count({ where: { id: oldId } }), 0);

    const usage = await turnLog.usage('2', now);
    assert.deepEqual(usage.days.map((day) => [day.date, day.turns, day.ratedDown]), [['2026-09-25', 0, 0], ['2026-09-26', 1, 1]]);
    assert.equal(usage.totals.inputTokens, 1000);
    assert.equal(usage.totals.users, 1);

    const list = await turnLog.listTurns({ rating: 'DOWN' });
    assert.deepEqual(list.items.map((item) => item.id), [freshId]);
    assert.equal((await turnLog.getTurn(freshId)).turn.ratingComment, 'не то');
  });
}
