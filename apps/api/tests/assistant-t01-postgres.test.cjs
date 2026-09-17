require('reflect-metadata');

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const { JwtService } = require('@nestjs/jwt');
const { NestFactory } = require('@nestjs/core');
const { PrismaClient, UserStatus } = require('@prisma/client');

const databaseUrl = process.env.ASSISTANT_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('Assistant T01 PostgreSQL scenarios require the targeted runner', () => {
    assert.equal(process.env.ASSISTANT_TEST_DATABASE_URL, undefined);
  });
} else {
  process.env.DATABASE_URL = databaseUrl;
  process.env.ASSISTANT_MODULE_ENABLED = 'true';
  process.env.ASSISTANT_ROLLOUT_STAGE = 'ADMINS';
  process.env.ASSISTANT_FAKE_STEP_DELAY_MS = '1';
  process.env.FEED_AUTO_IMPORT_ENABLED = 'false';
  process.env.JWT_ACCESS_SECRET = 'assistant-t01-http-access-secret';
  process.env.NODE_ENV = 'test';
  process.env.TELEGRAM_TRANSPORT_MODE = 'fake';
  process.env.TRAINING_AI_MODE = 'fake';
  process.env.TRAINING_MODULE_ENABLED = 'false';

  const { AppModule } = require('../dist/app.module.js');
  const { AssistantExecutionModule } = require('../dist/assistant/assistant-execution.module.js');
  const { createEmptyAssistantSearchFilters } = require('../dist/assistant/assistant-query-planner.js');
  const { buildAssistantSearchAnswer } = require('../dist/assistant/assistant-search-ranking.js');
  const { AssistantSearchService } = require('../dist/assistant/assistant-search.service.js');
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const jwt = new JwtService();
  let app;
  let baseUrl;
  let owner;
  let otherUser;
  let deniedUser;
  let ownerToken;
  let otherToken;
  let deniedToken;

  before(async () => {
    await prisma.$connect();
    await clearData();
    owner = await createUser('owner', ['objects:read', 'admin:access']);
    otherUser = await createUser('other', ['objects:read', 'admin:access']);
    deniedUser = await createUser('denied', ['admin:access']);
    ownerToken = signAccessToken(owner);
    otherToken = signAccessToken(otherUser);
    deniedToken = signAccessToken(deniedUser);

    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await app?.close();
    await clearData();
    await prisma.$disconnect();
  });

  test('assistant config and actions require auth, objects read permission and enabled feature state', async () => {
    assert.equal((await request('/assistant/config')).status, 401);
    assert.equal((await request('/assistant/config', { token: deniedToken })).status, 403);
    assert.deepEqual(await request('/assistant/config', { token: ownerToken }), {
      status: 200,
      body: { enabled: true },
    });

    process.env.ASSISTANT_MODULE_ENABLED = 'false';
    try {
      assert.deepEqual(await request('/assistant/config', { token: ownerToken }), {
        status: 200,
        body: { enabled: false },
      });
      const blocked = await request('/assistant/conversations', {
        method: 'POST',
        token: ownerToken,
      });
      assert.equal(blocked.status, 503);
      assert.equal(blocked.body.message, 'ASSISTANT_MODULE_DISABLED');
    } finally {
      process.env.ASSISTANT_MODULE_ENABLED = 'true';
    }
  });

  test('authenticated user receives one persisted grounded run with safe progress and idempotent replay', async () => {
    const created = await createConversation();
    assert.equal(created.status, 201);
    assert.equal(created.body.conversation.ownerUserId, undefined);
    assert.equal(created.body.conversation.title, 'Новый разговор');

    const input = {
      content: 'Найди подходящий объект',
      context: {
        kind: 'OBJECT',
        key: 'zhk-test',
        label: 'Текущий ЖК',
      },
    };
    const idempotencyKey = randomUUID();
    const queued = await sendMessage(created.body.conversation.id, input, idempotencyKey);
    assert.equal(queued.status, 202);
    assert.equal(queued.body.run.status === 'PENDING' || queued.body.run.status === 'RUNNING', true);

    const completed = await waitForRun(queued.body.run.id, ownerToken);
    assert.equal(completed.status, 'COMPLETED');
    assert.deepEqual(
      completed.progressEvents.map(({ step, label }) => [step, label]),
      [
        ['UNDERSTANDING', 'Понимаю запрос'],
        ['SEARCHING', 'Ищу данные'],
        ['COMPARING', 'Сравниваю варианты'],
        ['ANSWERING', 'Формирую ответ'],
      ],
    );
    assert.equal(completed.assistantMessage.answer.kind, 'SEARCH_RESULTS');
    assert.deepEqual(completed.assistantMessage.answer.exactResults, []);

    const replay = await sendMessage(created.body.conversation.id, input, idempotencyKey);
    assert.equal(replay.status, 202);
    assert.equal(replay.body.run.id, completed.id);

    const detail = await request(`/assistant/conversations/${created.body.conversation.id}`, {
      token: ownerToken,
    });
    assert.equal(detail.status, 200);
    assert.deepEqual(
      detail.body.conversation.messages.map((message) => message.role),
      ['USER', 'ASSISTANT'],
    );
    assert.deepEqual(detail.body.conversation.messages[0].context, input.context);
    assert.equal(detail.body.conversation.messages[1].context, null);
    assert.equal(detail.body.conversation.messages[1].answer.kind, 'SEARCH_RESULTS');

    const conflict = await sendMessage(
      created.body.conversation.id,
      { ...input, content: 'Другой запрос' },
      idempotencyKey,
    );
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.message, 'ASSISTANT_IDEMPOTENCY_KEY_REUSED');
  });

  test('grounded search reads current FeedUnit price on every run and persists private evidence telemetry', async () => {
    const fixture = await createSearchFixture();
    try {
      const firstConversation = await createConversation();
      const query = {
        content: 'Нужна двушка до 25 млн в районе Хамовники у метро Спортивная от Тест Девелопмент, сдача до 2028 года',
        context: null,
      };
      const firstQueued = await sendMessage(firstConversation.body.conversation.id, query, randomUUID());
      const first = await waitForRun(firstQueued.body.run.id, ownerToken);

      assert.equal(first.status, 'COMPLETED');
      assert.equal(first.assistantMessage.answer.kind, 'SEARCH_RESULTS');
      assert.equal(first.assistantMessage.answer.totalExactResults, 4);
      assert.equal(first.assistantMessage.answer.exactResults.length, 3);
      assert.deepEqual(
        first.assistantMessage.answer.additionalExactResults.map(({ priceRub }) => priceRub),
        [23_000_000],
      );
      assert.equal(first.assistantMessage.answer.alternatives.length, 0);
      assert.deepEqual(first.assistantMessage.answer.exactResults.map(({ priceRub }) => priceRub), [20_000_000, 21_000_000, 22_000_000]);
      assert.equal(first.assistantMessage.answer.exactResults[0].pdfs[0].href, `/media/files/${fixture.file.id}/content?download=true`);
      assert.equal(first.telemetry, undefined);
      assert.equal(first.evidence, undefined);

      const persistedFirst = await prisma.assistantRun.findUniqueOrThrow({ where: { id: first.id } });
      assert.equal(persistedFirst.intentJson.hardFilters.budgetMaxRub, 25_000_000);
      assert.equal(persistedFirst.evidenceJson.length, 4);
      assert.deepEqual(persistedFirst.telemetryJson.map(({ model, reasoningEffort, outcome }) => [model, reasoningEffort, outcome]), [
        ['qwen-flash', 'medium', 'ACCEPTED'],
      ]);
      const restoredFirstConversation = await request(
        `/assistant/conversations/${firstConversation.body.conversation.id}`,
        { token: ownerToken },
      );
      const restoredFirstAnswer = restoredFirstConversation.body.conversation.messages.at(-1).answer;
      assert.equal(restoredFirstAnswer.totalExactResults, 4);
      assert.deepEqual(
        restoredFirstAnswer.additionalExactResults.map(({ priceRub }) => priceRub),
        [23_000_000],
      );

      const catalogConversation = await createConversation();
      const catalogParams = new URLSearchParams({
        search: fixture.object.title,
        developerId: fixture.developer.id,
        krtName: fixture.object.krtName,
        locationId: fixture.district.id,
        areaId: fixture.area.id,
        metroStationId: fixture.metro.id,
        type: 'RESIDENTIAL',
        completionYear: '2027',
        lotPriceMin: '19000000',
        lotPriceMax: '25000000',
        lotPricePerMeterMin: '300000',
        lotPricePerMeterMax: '400000',
        lotRooms: '2',
        lotFloorMin: '8',
        lotFloorMax: '10',
      });
      const catalogQueued = await sendMessage(catalogConversation.body.conversation.id, {
        content: 'Покажи лучшие варианты из текущего каталога',
        context: { kind: 'CATALOG_FILTERS', key: catalogParams.toString(), label: 'Фильтры каталога' },
      }, randomUUID());
      const catalogRun = await waitForRun(catalogQueued.body.run.id, ownerToken);
      assert.equal(catalogRun.assistantMessage.answer.kind, 'SEARCH_RESULTS');
      assert.deepEqual(
        catalogRun.assistantMessage.answer.exactResults.map(({ priceRub }) => priceRub),
        [20_000_000, 21_000_000, 22_000_000],
      );

      await prisma.feedUnit.update({
        where: { id: fixture.units[1].id },
        data: { effectivePrice: 19_000_000 },
      });
      const secondConversation = await createConversation();
      const secondQueued = await sendMessage(secondConversation.body.conversation.id, query, randomUUID());
      const second = await waitForRun(secondQueued.body.run.id, ownerToken);

      assert.deepEqual(second.assistantMessage.answer.exactResults.map(({ priceRub }) => priceRub), [19_000_000, 20_000_000, 22_000_000]);
      assert.equal(second.assistantMessage.answer.totalExactResults, 4);
      assert.deepEqual(
        second.assistantMessage.answer.additionalExactResults.map(({ priceRub }) => priceRub),
        [23_000_000],
      );
      const persistedSecond = await prisma.assistantRun.findUniqueOrThrow({ where: { id: second.id } });
      assert.equal(persistedSecond.evidenceJson[0].priceRub, 19_000_000);
    } finally {
      await deleteSearchFixture(fixture);
    }
  });

  test('platform catalog grounds every published feedless object while archived, draft and deleted objects stay hidden', async () => {
    const fixture = await createPlatformCatalogFixture();
    try {
      const broad = await runAssistantMessage('Покажи все объекты Platforma');
      assert.equal(broad.status, 'COMPLETED');
      assert.equal(broad.assistantMessage.answer.kind, 'OBJECT_RESULTS');
      assert.equal(broad.assistantMessage.answer.totalObjects, 5);
      assert.deepEqual(
        [
          ...broad.assistantMessage.answer.objects,
          ...broad.assistantMessage.answer.additionalObjects,
        ].map(({ objectId }) => objectId).sort(),
        [
          fixture.firstResidential.id,
          fixture.secondResidential.id,
          fixture.prefixResidential.id,
          fixture.commercial.id,
          fixture.otherCommercial.id,
        ].sort(),
      );
      for (const card of [
        ...broad.assistantMessage.answer.objects,
        ...broad.assistantMessage.answer.additionalObjects,
      ]) {
        assert.equal(Object.hasOwn(card, 'unitId'), false);
        assert.equal(Object.hasOwn(card, 'priceRub'), false);
        assert.equal(Object.hasOwn(card, 'availabilityLabel'), false);
        assert.match(card.href, /^\/objects\//u);
      }

      const persisted = await prisma.assistantRun.findUniqueOrThrow({ where: { id: broad.id } });
      assert.equal(persisted.evidenceJson.length, 5);
      assert.equal(persisted.evidenceJson.every(({ evidenceType }) => evidenceType === 'PLATFORMA_OBJECT'), true);
      assert.equal(persisted.evidenceJson.some(({ objectId }) => objectId === fixture.archived.id), false);
      assert.equal(persisted.evidenceJson.some(({ objectId }) => objectId === fixture.draft.id), false);
      assert.equal(persisted.evidenceJson.some(({ objectId }) => objectId === fixture.deleted.id), false);
      assert.equal(persisted.evidenceJson.some(({ objectId }) => objectId === fixture.statusArchived.id), false);

      const restored = await request(`/assistant/conversations/${broad.conversationId}`, { token: ownerToken });
      assert.equal(restored.status, 200);
      assert.equal(restored.body.conversation.messages.at(-1).answer.kind, 'OBJECT_RESULTS');
      assert.equal(restored.body.conversation.messages.at(-1).answer.totalObjects, 5);

      const named = await runAssistantMessage(`Расскажи про ЖК Двойник ${fixture.suffix}`);
      assert.equal(named.assistantMessage.answer.kind, 'OBJECT_RESULTS');
      assert.equal(named.assistantMessage.answer.totalObjects, 2);
      assert.deepEqual(
        named.assistantMessage.answer.objects.map(({ objectId }) => objectId).sort(),
        [fixture.firstResidential.id, fixture.secondResidential.id].sort(),
      );
      assert.equal(named.assistantMessage.answer.objects.some(({ objectId }) =>
        objectId === fixture.prefixResidential.id), false);

      const namedOutsidePageContext = await runAssistantMessage(
        `Расскажи про ЖК Двойник ${fixture.suffix}`,
        { kind: 'OBJECT', key: fixture.otherCommercial.slug, label: fixture.otherCommercial.title },
      );
      assert.equal(namedOutsidePageContext.assistantMessage.answer.kind, 'OBJECT_RESULTS');
      assert.equal(namedOutsidePageContext.assistantMessage.answer.totalObjects, 2);

      const namedOutsideCatalogFilters = await runAssistantMessage(
        `Расскажи про ЖК Двойник ${fixture.suffix}`,
        { kind: 'CATALOG_FILTERS', key: 'completionYear=2099&type=COMMERCIAL', label: 'Каталог' },
      );
      assert.equal(namedOutsideCatalogFilters.assistantMessage.answer.kind, 'OBJECT_RESULTS');
      assert.equal(namedOutsideCatalogFilters.assistantMessage.answer.totalObjects, 2);

      const commercial = await runAssistantMessage('Покажи все коммерческие объекты Platforma');
      assert.equal(commercial.assistantMessage.answer.kind, 'OBJECT_RESULTS');
      assert.equal(commercial.assistantMessage.answer.totalObjects, 2);

      const namedCommercial = await runAssistantMessage(`Расскажи про БЦ Каталог ${fixture.suffix}`);
      assert.equal(namedCommercial.assistantMessage.answer.kind, 'OBJECT_RESULTS');
      assert.equal(namedCommercial.assistantMessage.answer.totalObjects, 1);
      assert.equal(namedCommercial.assistantMessage.answer.objects[0].objectId, fixture.commercial.id);

      const lowercaseCommercial = await runAssistantMessage(
        `расскажи про бц каталог ${fixture.suffix}`,
      );
      assert.equal(lowercaseCommercial.assistantMessage.answer.kind, 'OBJECT_RESULTS');
      assert.equal(lowercaseCommercial.assistantMessage.answer.totalObjects, 1);
      assert.equal(lowercaseCommercial.assistantMessage.answer.objects[0].objectId, fixture.commercial.id);

      const archived = await runAssistantMessage(`Расскажи про ЖК Архив ${fixture.suffix}`);
      assert.equal(archived.assistantMessage.answer.kind, 'OBJECT_RESULTS');
      assert.equal(archived.assistantMessage.answer.totalObjects, 0);
      assert.deepEqual(archived.assistantMessage.answer.objects, []);
      assert.deepEqual(archived.assistantMessage.answer.additionalObjects, []);
    } finally {
      await deletePlatformCatalogFixture(fixture);
    }
  });

  test('grounded search generates only the four allowed relaxations from current PostgreSQL data', async () => {
    const fixture = await createSearchFixture();
    const searchService = app.get(AssistantSearchService);
    try {
      const budgetIntent = createSearchIntent({ budgetMaxRub: 19_000_000 });
      const budgetSearch = await searchService.search(budgetIntent, null);
      const budgetAnswer = buildAssistantSearchAnswer(
        budgetIntent,
        budgetSearch.exact,
        budgetSearch.alternatives,
      );
      assert.equal(budgetSearch.exact.length, 0);
      assert.equal(budgetSearch.alternatives.every(({ priceRub }) => priceRub <= 26_000_000), true);
      assert.equal(budgetSearch.alternatives.some(({ priceRub }) => priceRub === 27_000_000), false);
      assertRelaxationAnswer(budgetAnswer, 'BUDGET');

      const roomsIntent = createSearchIntent({ rooms: [3] });
      const roomsSearch = await searchService.search(roomsIntent, null);
      assertRelaxationAnswer(
        buildAssistantSearchAnswer(roomsIntent, roomsSearch.exact, roomsSearch.alternatives),
        'ROOMS',
      );

      const developerIntent = createSearchIntent({ developer: 'Несуществующий девелопер' });
      const developerSearch = await searchService.search(developerIntent, null);
      assertRelaxationAnswer(
        buildAssistantSearchAnswer(developerIntent, developerSearch.exact, developerSearch.alternatives),
        'DEVELOPER',
      );

      const districtIntent = createSearchIntent({ district: fixture.emptyDistrict.name });
      const districtSearch = await searchService.search(districtIntent, null);
      assertRelaxationAnswer(
        buildAssistantSearchAnswer(districtIntent, districtSearch.exact, districtSearch.alternatives),
        'DISTRICT',
      );
    } finally {
      await deleteSearchFixture(fixture);
    }
  });

  test('exact totals require a downloadable PDF and a non-empty location fact', async () => {
    const fixture = await createSearchFixture();
    const searchService = app.get(AssistantSearchService);
    let orphanAsset = null;
    try {
      orphanAsset = await prisma.feedMediaAsset.create({
        data: {
          sourceUrl: `https://example.test/${randomUUID()}/missing.pdf`,
          contentType: 'application/pdf',
        },
      });
      await prisma.feedUnitMedia.create({
        data: { unitId: fixture.units[0].id, mediaAssetId: orphanAsset.id },
      });
      await prisma.objectFile.deleteMany({ where: { objectId: fixture.object.id } });
      const pdfIntent = createSearchIntent({ budgetMaxRub: 25_000_000 });
      pdfIntent.requiredFacts = [...pdfIntent.requiredFacts, 'PDF'];

      const pdfSearch = await searchService.search(pdfIntent, null);

      assert.equal(pdfSearch.totalExactResults, 0);
      assert.deepEqual(pdfSearch.exact, []);

      await prisma.objectMetroStation.deleteMany({ where: { objectId: fixture.object.id } });
      await prisma.location.update({ where: { id: fixture.district.id }, data: { name: '   ' } });
      const locationIntent = createSearchIntent({ budgetMaxRub: 25_000_000 });
      locationIntent.requiredFacts = [...locationIntent.requiredFacts, 'LOCATION'];

      const locationSearch = await searchService.search(locationIntent, null);

      assert.equal(locationSearch.totalExactResults, 0);
      assert.deepEqual(locationSearch.exact, []);
    } finally {
      if (orphanAsset) await prisma.feedMediaAsset.deleteMany({ where: { id: orphanAsset.id } });
      await deleteSearchFixture(fixture);
    }
  });

  test('planner and PostgreSQL comparison keep evidence for an inflected multiword target beyond the global candidate limit', async () => {
    const fixture = await createComparisonFixture();
    try {
      const created = await createConversation();
      const queued = await sendMessage(created.body.conversation.id, {
        content: `Сравни ЖК Первый с Сердцем Столицы по цене, двушки до 25 млн в районе ${fixture.district.name} у метро ${fixture.metro.name}`,
        context: null,
      }, randomUUID());
      const completed = await waitForRun(queued.body.run.id, ownerToken);

      assert.equal(completed.status, 'COMPLETED');
      assert.equal(completed.assistantMessage.answer.kind, 'COMPARISON_RESULTS');
      assert.deepEqual(completed.assistantMessage.answer.groups.map((group) => ({
        target: group.target,
        status: group.status,
        totalExactResults: group.totalExactResults,
      })), [
        { target: 'Первый', status: 'MATCHED', totalExactResults: 121 },
        { target: 'Сердцем Столицы', status: 'MATCHED', totalExactResults: 1 },
      ]);
      assert.equal(completed.assistantMessage.answer.groups[0].exactResults.length, 3);
      assert.equal(completed.assistantMessage.answer.groups[0].additionalExactResults.length, 5);
      assert.equal(completed.assistantMessage.answer.groups[1].exactResults.length, 1);
      const facts = completed.assistantMessage.answer.groups.flatMap((group) => (
        group.exactResults.flatMap(({ facts: resultFacts }) => resultFacts)
      ));
      assert.equal(facts.includes(fixture.firstDeveloper.name), true);
      assert.equal(facts.includes(fixture.secondDeveloper.name), true);

      const persisted = await prisma.assistantRun.findUniqueOrThrow({ where: { id: completed.id } });
      assert.deepEqual(persisted.intentJson.comparisonTargets, [
        'Первый',
        'Сердцем Столицы',
      ]);
      assert.deepEqual(persisted.intentJson.comparisonTargetModes, ['EXACT', 'INSTRUMENTAL']);
      assert.equal(persisted.intentJson.hardFilters.developer, null);
      assert.equal(persisted.evidenceJson.length, 9);

      const summaryOutlier = await prisma.feedUnit.findFirstOrThrow({
        where: { sourceId: fixture.firstSource.id },
        orderBy: { effectivePrice: 'desc' },
        select: { id: true },
      });
      await prisma.feedUnit.update({
        where: { id: summaryOutlier.id },
        data: { effectivePrice: 1_000_000, completionYear: 2039, completionQuarter: 4 },
      });
      const summaryIntent = createSearchIntent({
        budgetMaxRub: 25_000_000,
        rooms: [2],
        district: fixture.district.name,
        metro: fixture.metro.name,
      });
      summaryIntent.taskType = 'COMPARE';
      summaryIntent.comparisonTargets = ['ПИК'];
      summaryIntent.comparisonTargetModes = ['EXACT'];
      summaryIntent.softPreferences = {
        ...createEmptyAssistantSearchFilters(),
        completionYearMax: 2028,
      };
      const summarizedSearch = await app.get(AssistantSearchService).search(summaryIntent, null);
      assert.equal(summarizedSearch.totalExactResults, 121);
      assert.equal(summarizedSearch.exact.some(({ unitId }) => unitId === summaryOutlier.id), false);
      assert.equal(summarizedSearch.summary.minimumPriceRub, 1_000_000);
      assert.equal(summarizedSearch.summary.completion.includes('4 кв. 2039'), true);

      const softIntent = createSearchIntent({
        budgetMaxRub: 25_000_000,
        rooms: [2],
        district: fixture.district.name,
        metro: fixture.metro.name,
      });
      softIntent.softPreferences = {
        ...createEmptyAssistantSearchFilters(),
        developer: fixture.secondDeveloper.name,
      };
      const softSearch = await app.get(AssistantSearchService).search(softIntent, null);
      const softAnswer = buildAssistantSearchAnswer(softIntent, softSearch.exact, [], new Date());
      assert.equal(softAnswer.exactResults[0].facts.includes(fixture.secondDeveloper.name), true);

      const rawPreferredIntent = createSearchIntent({
        budgetMaxRub: 25_000_000,
        rooms: [2],
        district: fixture.district.name,
        metro: fixture.metro.name,
      });
      rawPreferredIntent.taskType = 'COMPARE';
      rawPreferredIntent.comparisonTargets = ['ПИК', 'Ростелеком'];
      rawPreferredIntent.comparisonTargetModes = ['EXACT', 'INSTRUMENTAL'];
      const rawPreferredSearch = await app.get(AssistantSearchService).search(rawPreferredIntent, null);
      assert.equal(rawPreferredSearch.totalExactResults, 122);
      assert.equal(rawPreferredSearch.exact.some(({ developer }) => developer === 'Ростелек'), false);
      const rawPreferredAnswer = buildAssistantSearchAnswer(
        rawPreferredIntent,
        rawPreferredSearch.exact,
        [],
        new Date(),
        rawPreferredSearch.totalExactResults,
      );
      assert.equal(rawPreferredAnswer.totalExactResults, 122);

      rawPreferredIntent.comparisonTargets = ['Ростелеком'];
      rawPreferredIntent.comparisonTargetModes = ['INSTRUMENTAL'];
      const singleTargetRawPreferredSearch = await app.get(AssistantSearchService).search(rawPreferredIntent, null);
      assert.equal(singleTargetRawPreferredSearch.totalExactResults, 1);
      assert.equal(singleTargetRawPreferredSearch.exact.some(({ developer }) => developer === 'Ростелек'), false);
    } finally {
      await deleteComparisonFixture(fixture);
    }
  });

  test('conversation and run ownership fail closed without exposing another user data', async () => {
    const created = await createConversation();
    const queued = await sendMessage(
      created.body.conversation.id,
      { content: 'Приватный запрос', context: null },
      randomUUID(),
    );
    await waitForRun(queued.body.run.id, ownerToken);

    assert.equal((await request(
      `/assistant/conversations/${created.body.conversation.id}`,
      { token: otherToken },
    )).status, 404);
    assert.equal((await request(
      `/assistant/runs/${queued.body.run.id}`,
      { token: otherToken },
    )).status, 404);

    const ownerHistory = await request('/assistant/conversations', { token: ownerToken });
    const otherHistory = await request('/assistant/conversations', { token: otherToken });
    assert.equal(ownerHistory.body.items.some((item) => item.id === created.body.conversation.id), true);
    assert.equal(otherHistory.body.items.some((item) => item.id === created.body.conversation.id), false);
  });

  test('history excludes conversations inactive for more than 30 days and input validation is bounded', async () => {
    const old = await createConversation();
    await prisma.assistantConversation.update({
      where: { id: old.body.conversation.id },
      data: { updatedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
    });

    const history = await request('/assistant/conversations', { token: ownerToken });
    assert.equal(history.body.items.some((item) => item.id === old.body.conversation.id), false);
    assert.equal((await sendMessage(old.body.conversation.id, { content: '   ' }, randomUUID())).status, 400);
    assert.equal((await request(`/assistant/conversations/${old.body.conversation.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { content: 'Без ключа' },
    })).status, 400);

    const pagedIds = Array.from({ length: 55 }, () => randomUUID());
    await prisma.assistantConversation.createMany({
      data: pagedIds.map((id, index) => ({
        id,
        ownerUserId: owner.id,
        creationKey: randomUUID(),
        title: `Страница истории ${index}`,
      })),
    });
    const visibleIds = new Set();
    let cursor = null;
    do {
      const page = await request(`/assistant/conversations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, {
        token: ownerToken,
      });
      assert.equal(page.status, 200);
      page.body.items.forEach((item) => visibleIds.add(item.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    assert.equal(pagedIds.every((id) => visibleIds.has(id)), true);
    assert.equal((await request('/assistant/conversations?cursor=broken', { token: ownerToken })).status, 400);
  });

  test('conversation creation replays one result after a lost response', async () => {
    const idempotencyKey = randomUUID();
    const first = await createConversation(idempotencyKey);
    const replay = await createConversation(idempotencyKey);

    assert.equal(first.status, 201);
    assert.equal(replay.status, 201);
    assert.equal(replay.body.conversation.id, first.body.conversation.id);
    assert.equal(await prisma.assistantConversation.count({
      where: { ownerUserId: owner.id, creationKey: idempotencyKey },
    }), 1);
  });

  test('concurrent failed-run retry never returns a stale failed snapshot or duplicates work', async () => {
    const created = await createConversation();
    const content = 'Повтори конкурентно';
    const idempotencyKey = randomUUID();
    const userMessage = await prisma.assistantMessage.create({
      data: {
        conversationId: created.body.conversation.id,
        role: 'USER',
        content,
      },
    });
    const failed = await prisma.assistantRun.create({
      data: {
        ownerUserId: owner.id,
        conversationId: created.body.conversation.id,
        userMessageId: userMessage.id,
        idempotencyKey,
        requestHash: hashAssistantRequest(created.body.conversation.id, content),
        status: 'FAILED',
        startedAt: new Date(Date.now() - 2_000),
        completedAt: new Date(Date.now() - 1_000),
        errorCode: 'ASSISTANT_FAKE_RUN_FAILED',
      },
    });

    const responses = await Promise.all([
      sendMessage(created.body.conversation.id, { content, context: null }, idempotencyKey),
      sendMessage(created.body.conversation.id, { content, context: null }, idempotencyKey),
    ]);
    assert.deepEqual(responses.map((response) => response.status), [202, 202]);
    assert.equal(responses.some((response) => response.body.run.status === 'FAILED'), false);

    await waitForRun(failed.id, ownerToken);
    assert.equal(await prisma.assistantRun.count({ where: { id: failed.id } }), 1);
    assert.equal(await prisma.assistantMessage.count({
      where: { conversationId: created.body.conversation.id, role: 'USER' },
    }), 1);
  });

  test('persisted running work is recovered after its original process disappears', async () => {
    const created = await createConversation();
    const content = 'Восстанови запуск';
    const userMessage = await prisma.assistantMessage.create({
      data: {
        conversationId: created.body.conversation.id,
        role: 'USER',
        content,
      },
    });
    const staleRun = await prisma.assistantRun.create({
      data: {
        ownerUserId: owner.id,
        conversationId: created.body.conversation.id,
        userMessageId: userMessage.id,
        idempotencyKey: randomUUID(),
        requestHash: hashAssistantRequest(created.body.conversation.id, content),
        status: 'RUNNING',
        startedAt: new Date(Date.now() - 60_000),
        leaseOwner: 'dead-process',
        leaseExpiresAt: new Date(Date.now() - 30_000),
      },
    });

    const recovered = await waitForRun(staleRun.id, ownerToken);
    assert.equal(recovered.status, 'COMPLETED');
    assert.equal(recovered.assistantMessage.answer.kind, 'SEARCH_RESULTS');
  });

  test('a long grounded answer renews its PostgreSQL lease until completion', async () => {
    const execution = app.get(AssistantExecutionModule);
    const answerService = execution.answerService;
    const originalAnswer = answerService.answer;
    let answerCalls = 0;
    let markAnswerStarted;
    const answerStarted = new Promise((resolve) => {
      markAnswerStarted = resolve;
    });
    answerService.answer = async function delayedAnswer(input) {
      answerCalls += 1;
      markAnswerStarted();
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      return originalAnswer.call(this, input);
    };

    try {
      const created = await createConversation();
      const queued = await sendMessage(
        created.body.conversation.id,
        { content: 'Проверь продление аренды', context: null },
        randomUUID(),
      );
      await answerStarted;

      const shortenedLease = new Date(Date.now() + 12_000);
      const shortened = await prisma.assistantRun.updateMany({
        where: { id: queued.body.run.id, status: 'RUNNING' },
        data: { leaseExpiresAt: shortenedLease },
      });
      assert.equal(shortened.count, 1);

      const renewedLease = await waitForLeaseRenewal(queued.body.run.id, shortenedLease);
      assert.equal(renewedLease > shortenedLease, true);
      const completed = await waitForRun(queued.body.run.id, ownerToken, 8_000);
      assert.equal(completed.status, 'COMPLETED');
      assert.equal(answerCalls, 1);

      const persisted = await prisma.assistantRun.findUniqueOrThrow({
        where: { id: queued.body.run.id },
        select: { leaseOwner: true, leaseExpiresAt: true },
      });
      assert.deepEqual(persisted, { leaseOwner: null, leaseExpiresAt: null });
    } finally {
      answerService.answer = originalAnswer;
    }
  });

  test('conversation message bound remains enforced under concurrent sends', async () => {
    const created = await createConversation();
    await prisma.assistantMessage.createMany({
      data: Array.from({ length: 198 }, (_, index) => ({
        conversationId: created.body.conversation.id,
        role: 'USER',
        content: `Ограниченный контекст ${index}`,
      })),
    });

    const responses = await Promise.all([
      sendMessage(created.body.conversation.id, { content: 'Запрос A' }, randomUUID()),
      sendMessage(created.body.conversation.id, { content: 'Запрос B' }, randomUUID()),
    ]);
    assert.deepEqual(responses.map(({ status }) => status).sort(), [202, 409]);
  });

  test('same idempotency key replays at the conversation message bound', async () => {
    const created = await createConversation();
    await prisma.assistantMessage.createMany({
      data: Array.from({ length: 198 }, (_, index) => ({
        conversationId: created.body.conversation.id,
        role: 'USER',
        content: `Контекст идемпотентного повтора ${index}`,
      })),
    });

    const idempotencyKey = randomUUID();
    const responses = await Promise.all([
      sendMessage(created.body.conversation.id, { content: 'Один запрос' }, idempotencyKey),
      sendMessage(created.body.conversation.id, { content: 'Один запрос' }, idempotencyKey),
    ]);
    assert.deepEqual(responses.map(({ status }) => status), [202, 202]);
    assert.equal(responses[0].body.run.id, responses[1].body.run.id);

    await waitForRun(responses[0].body.run.id, ownerToken);
    assert.equal(await prisma.assistantRun.count({
      where: { conversationId: created.body.conversation.id },
    }), 1);
    assert.equal(await prisma.assistantMessage.count({
      where: { conversationId: created.body.conversation.id },
    }), 200);
  });

  function createConversation(idempotencyKey = randomUUID()) {
    return request('/assistant/conversations', {
      method: 'POST',
      token: ownerToken,
      headers: { 'Idempotency-Key': idempotencyKey },
    });
  }

  function sendMessage(conversationId, body, idempotencyKey) {
    return request(`/assistant/conversations/${conversationId}/messages`, {
      method: 'POST',
      token: ownerToken,
      headers: { 'Idempotency-Key': idempotencyKey },
      body,
    });
  }

  function hashAssistantRequest(conversationId, content) {
    return createHash('sha256')
      .update(JSON.stringify({ conversationId, content, context: null, geo: null }))
      .digest('hex');
  }

  async function waitForRun(runId, token, timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;

    do {
      const response = await request(`/assistant/runs/${runId}`, { token });
      if (response.status !== 200) throw new Error(`RUN_READ_FAILED_${response.status}`);
      if (response.body.run.status === 'COMPLETED' || response.body.run.status === 'FAILED') {
        return response.body.run;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);

    throw new Error('ASSISTANT_RUN_TIMEOUT');
  }

  async function waitForLeaseRenewal(runId, shortenedLease) {
    const deadline = Date.now() + 13_000;
    do {
      const run = await prisma.assistantRun.findUniqueOrThrow({
        where: { id: runId },
        select: { status: true, leaseExpiresAt: true },
      });
      if (run.status !== 'RUNNING') throw new Error(`ASSISTANT_RUN_NOT_RUNNING_${run.status}`);
      if (run.leaseExpiresAt && run.leaseExpiresAt > shortenedLease) return run.leaseExpiresAt;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    throw new Error('ASSISTANT_LEASE_RENEWAL_TIMEOUT');
  }

  async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...options.headers,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return {
      status: response.status,
      body: await response.json().catch(() => null),
    };
  }

  function signAccessToken(user) {
    return jwt.sign(
      { sub: user.id, email: user.email, type: 'access' },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '1h' },
    );
  }

  async function createUser(label, permissionKeys) {
    const descriptions = {
      'objects:read': 'Read objects',
      'admin:access': 'Access administration',
    };
    const permissions = await Promise.all(permissionKeys.map((key) => prisma.permission.upsert({
      where: { key },
      update: {},
      create: { key, description: descriptions[key] },
    })));
    const role = await prisma.role.create({
      data: {
        name: `assistant-t01-${label}-${randomUUID().slice(0, 8)}`,
        description: label,
        ...(permissions.length > 0
          ? { permissions: { create: permissions.map(({ id }) => ({ permissionId: id })) } }
          : {}),
      },
    });

    return prisma.user.create({
      data: {
        email: `${label}-${randomUUID()}@assistant-t01.test`,
        passwordHash: 'test-hash',
        name: label,
        status: UserStatus.ACTIVE,
        roleId: role.id,
      },
    });
  }

  async function clearData() {
    if (prisma.assistantRun) await prisma.assistantRun.deleteMany();
    if (prisma.assistantMessage) await prisma.assistantMessage.deleteMany();
    if (prisma.assistantConversation) await prisma.assistantConversation.deleteMany();
    await prisma.user.deleteMany({
      where: { email: { endsWith: '@assistant-t01.test' } },
    });
    await prisma.role.deleteMany({
      where: { name: { startsWith: 'assistant-t01-' } },
    });
  }

  async function runAssistantMessage(content, context = null) {
    const conversation = await createConversation();
    const queued = await sendMessage(conversation.body.conversation.id, { content, context }, randomUUID());
    const run = await waitForRun(queued.body.run.id, ownerToken);
    return { ...run, conversationId: conversation.body.conversation.id };
  }

  async function createPlatformCatalogFixture() {
    const suffix = randomUUID().slice(0, 8);
    const developer = await prisma.developer.create({
      data: { name: `Каталог Девелопмент ${suffix}` },
    });
    const district = await prisma.location.create({
      data: { name: `Каталог район ${suffix}`, slug: `catalog-district-${suffix}`, type: 'DISTRICT' },
    });
    const common = {
      developerId: developer.id,
      primaryLocationId: district.id,
      description: `Проверенное описание объекта ${suffix}`,
      latitude: 55.751244,
      longitude: 37.618423,
    };
    const [
      firstResidential,
      secondResidential,
      prefixResidential,
      commercial,
      otherCommercial,
      archived,
      statusArchived,
      draft,
      deleted,
    ] = await Promise.all([
      prisma.realEstateObject.create({ data: {
        ...common,
        title: `ЖК Двойник ${suffix}`,
        slug: `catalog-first-${suffix}`,
        status: 'PUBLISHED',
        type: 'RESIDENTIAL',
      } }),
      prisma.realEstateObject.create({ data: {
        ...common,
        title: `ЖК Двойник ${suffix}`,
        slug: `catalog-second-${suffix}`,
        status: 'PUBLISHED',
        type: 'RESIDENTIAL',
      } }),
      prisma.realEstateObject.create({ data: {
        ...common,
        title: `ЖК Двойник ${suffix} Парк`,
        slug: `catalog-prefix-${suffix}`,
        status: 'PUBLISHED',
        type: 'RESIDENTIAL',
      } }),
      prisma.realEstateObject.create({ data: {
        ...common,
        title: `БЦ Каталог ${suffix}`,
        slug: `catalog-commercial-${suffix}`,
        status: 'PUBLISHED',
        type: 'COMMERCIAL',
      } }),
      prisma.realEstateObject.create({ data: {
        ...common,
        title: `БЦ Другой ${suffix}`,
        slug: `catalog-commercial-other-${suffix}`,
        status: 'PUBLISHED',
        type: 'COMMERCIAL',
      } }),
      prisma.realEstateObject.create({ data: {
        ...common,
        title: `ЖК Архив ${suffix}`,
        slug: `catalog-archived-${suffix}`,
        status: 'PUBLISHED',
        type: 'RESIDENTIAL',
        archivedAt: new Date(),
      } }),
      prisma.realEstateObject.create({ data: {
        ...common,
        title: `ЖК Архив Статус ${suffix}`,
        slug: `catalog-status-archived-${suffix}`,
        status: 'ARCHIVED',
        type: 'RESIDENTIAL',
      } }),
      prisma.realEstateObject.create({ data: {
        ...common,
        title: `ЖК Черновик ${suffix}`,
        slug: `catalog-draft-${suffix}`,
        status: 'DRAFT',
        type: 'RESIDENTIAL',
      } }),
      prisma.realEstateObject.create({ data: {
        ...common,
        title: `ЖК Удалён ${suffix}`,
        slug: `catalog-deleted-${suffix}`,
        status: 'PUBLISHED',
        type: 'RESIDENTIAL',
        deletedAt: new Date(),
      } }),
    ]);
    return {
      suffix,
      developer,
      district,
      firstResidential,
      secondResidential,
      prefixResidential,
      commercial,
      otherCommercial,
      archived,
      statusArchived,
      draft,
      deleted,
    };
  }

  async function deletePlatformCatalogFixture(fixture) {
    await prisma.realEstateObject.deleteMany({
      where: { id: { in: [
        fixture.firstResidential.id,
        fixture.secondResidential.id,
        fixture.prefixResidential.id,
        fixture.commercial.id,
        fixture.otherCommercial.id,
        fixture.archived.id,
        fixture.statusArchived.id,
        fixture.draft.id,
        fixture.deleted.id,
      ] } },
    });
    await prisma.location.deleteMany({ where: { id: fixture.district.id } });
    await prisma.developer.deleteMany({ where: { id: fixture.developer.id } });
  }

  async function createSearchFixture() {
    const suffix = randomUUID().slice(0, 8);
    const developer = await prisma.developer.create({
      data: { name: `Тест Девелопмент ${suffix}` },
    });
    const locationParent = await prisma.location.create({
      data: { name: `Москва ${suffix}`, slug: `moscow-${suffix}`, type: 'CUSTOM' },
    });
    const district = await prisma.location.create({
      data: {
        name: 'Хамовники',
        slug: `hamovniki-${suffix}`,
        type: 'DISTRICT',
        parentId: locationParent.id,
      },
    });
    const emptyDistrict = await prisma.location.create({
      data: {
        name: `Арбат ${suffix}`,
        slug: `arbat-${suffix}`,
        type: 'DISTRICT',
        parentId: locationParent.id,
      },
    });
    const area = await prisma.location.create({
      data: { name: `ЦАО ${suffix}`, slug: `cao-${suffix}`, type: 'AREA' },
    });
    const metro = await prisma.metroStation.create({
      data: { name: 'Спортивная', slug: `sportivnaya-${suffix}`, lineName: `Тестовая ${suffix}` },
    });
    const object = await prisma.realEstateObject.create({
      data: {
        title: `ЖК Тест ${suffix}`,
        slug: `zhk-test-${suffix}`,
        status: 'PUBLISHED',
        type: 'RESIDENTIAL',
        developerId: developer.id,
        primaryLocationId: district.id,
        krtName: `Тест КРТ ${suffix}`,
        completionYear: 2027,
        completionQuarter: 3,
        feedUpdatedAt: new Date(),
        metroStations: { create: { metroStationId: metro.id } },
        locations: { create: { locationId: area.id } },
      },
    });
    const file = await prisma.file.create({
      data: {
        key: `assistant-t02/${suffix}/project.pdf`,
        originalName: 'project.pdf',
        mimeType: 'application/pdf',
      },
    });
    await prisma.objectFile.create({
      data: {
        objectId: object.id,
        fileId: file.id,
        type: 'PRESENTATION',
        title: 'Презентация проекта',
      },
    });
    const source = await prisma.feedSource.create({
      data: {
        url: `https://example.test/${suffix}.xml`,
        format: 'CIAN_XML',
        developerId: developer.id,
        objectId: object.id,
        isActive: true,
        lastSuccessAt: new Date(),
      },
    });
    const units = [];
    for (const [index, price] of [20_000_000, 21_000_000, 22_000_000, 23_000_000, 27_000_000].entries()) {
      units.push(await prisma.feedUnit.create({
        data: {
          sourceId: source.id,
          objectId: object.id,
          externalId: `assistant-${suffix}-${index}`,
          type: 'RESIDENTIAL',
          status: 'AVAILABLE',
          title: `Квартира ${index + 1}`,
          rooms: 2,
          effectivePrice: price,
          effectivePricePerMeter: 330_000 + index * 5_000,
          currency: 'RUB',
          area: 60 + index,
          floor: 8 + index,
          completionYear: 2027,
          completionQuarter: 3,
        },
      }));
    }
    return { developer, locationParent, district, emptyDistrict, area, metro, object, file, source, units };
  }

  async function deleteSearchFixture(fixture) {
    await prisma.feedSource.deleteMany({ where: { id: fixture.source.id } });
    await prisma.realEstateObject.deleteMany({ where: { id: fixture.object.id } });
    await prisma.file.deleteMany({ where: { id: fixture.file.id } });
    await prisma.metroStation.deleteMany({ where: { id: fixture.metro.id } });
    await prisma.location.deleteMany({
      where: { id: { in: [fixture.district.id, fixture.emptyDistrict.id, fixture.area.id, fixture.locationParent.id] } },
    });
    await prisma.developer.deleteMany({ where: { id: fixture.developer.id } });
  }

  async function createComparisonFixture() {
    const suffix = randomUUID().slice(0, 8);
    const [firstDeveloper, secondDeveloper, fallbackDeveloper] = await Promise.all([
      prisma.developer.create({ data: { name: 'ПИК' } }),
      prisma.developer.create({ data: { name: 'Ростелеком' } }),
      prisma.developer.create({ data: { name: 'Ростелек' } }),
    ]);
    const district = await prisma.location.create({
      data: { name: `Хамовники ${suffix}`, slug: `compare-district-${suffix}`, type: 'DISTRICT' },
    });
    const metro = await prisma.metroStation.create({
      data: { name: `Спортивная ${suffix}`, slug: `compare-metro-${suffix}`, lineName: `Тестовая ${suffix}` },
    });
    const firstObject = await prisma.realEstateObject.create({
      data: {
        title: `ЖК Первый ${suffix}`,
        slug: `compare-first-${suffix}`,
        status: 'PUBLISHED',
        type: 'RESIDENTIAL',
        developerId: firstDeveloper.id,
        primaryLocationId: district.id,
        completionYear: 2027,
        feedUpdatedAt: new Date(),
        metroStations: { create: { metroStationId: metro.id } },
      },
    });
    const secondObject = await prisma.realEstateObject.create({
      data: {
        title: `ЖК Сердце Столицы ${suffix}`,
        slug: `compare-second-${suffix}`,
        status: 'PUBLISHED',
        type: 'RESIDENTIAL',
        developerId: secondDeveloper.id,
        primaryLocationId: district.id,
        completionYear: 2027,
        feedUpdatedAt: new Date(),
        metroStations: { create: { metroStationId: metro.id } },
      },
    });
    const fallbackObject = await prisma.realEstateObject.create({
      data: {
        title: `ЖК Запасной ${suffix}`,
        slug: `compare-fallback-${suffix}`,
        status: 'PUBLISHED',
        type: 'RESIDENTIAL',
        developerId: fallbackDeveloper.id,
        primaryLocationId: district.id,
        completionYear: 2027,
        feedUpdatedAt: new Date(),
        metroStations: { create: { metroStationId: metro.id } },
      },
    });
    const [firstSource, fallbackSource, secondSource] = await Promise.all([
      prisma.feedSource.create({
        data: {
          url: `https://example.test/compare-first-${suffix}.xml`,
          format: 'CIAN_XML',
          developerId: firstDeveloper.id,
          objectId: firstObject.id,
          isActive: true,
          lastSuccessAt: new Date(),
        },
      }),
      prisma.feedSource.create({
        data: {
          url: `https://example.test/compare-fallback-${suffix}.xml`,
          format: 'CIAN_XML',
          developerId: fallbackDeveloper.id,
          objectId: fallbackObject.id,
          isActive: true,
          lastSuccessAt: new Date(),
        },
      }),
      prisma.feedSource.create({
        data: {
          url: `https://example.test/compare-second-${suffix}.xml`,
          format: 'CIAN_XML',
          developerId: secondDeveloper.id,
          objectId: secondObject.id,
          isActive: true,
          lastSuccessAt: new Date(),
        },
      }),
    ]);
    await prisma.feedUnit.createMany({
      data: Array.from({ length: 121 }, (_, index) => ({
        sourceId: firstSource.id,
        objectId: firstObject.id,
        externalId: `compare-first-${suffix}-${index}`,
        type: 'RESIDENTIAL',
        status: 'AVAILABLE',
        title: `Квартира ${index + 1}`,
        rooms: 2,
        effectivePrice: 10_000_000 + index * 10_000,
        currency: 'RUB',
        area: 60,
        floor: 8,
        completionYear: 2027,
      })),
    });
    await prisma.feedUnit.create({
      data: {
        sourceId: secondSource.id,
        objectId: secondObject.id,
        externalId: `compare-second-${suffix}`,
        type: 'RESIDENTIAL',
        status: 'AVAILABLE',
        title: 'Квартира сравнения',
        rooms: 2,
        effectivePrice: 20_000_000,
        currency: 'RUB',
        area: 60,
        floor: 8,
        completionYear: 2027,
      },
    });
    await prisma.feedUnit.create({
      data: {
        sourceId: fallbackSource.id,
        objectId: fallbackObject.id,
        externalId: `compare-fallback-${suffix}`,
        type: 'RESIDENTIAL',
        status: 'AVAILABLE',
        title: 'Квартира fallback',
        rooms: 2,
        effectivePrice: 19_000_000,
        currency: 'RUB',
        area: 60,
        floor: 8,
        completionYear: 2027,
      },
    });
    return {
      firstDeveloper,
      secondDeveloper,
      fallbackDeveloper,
      district,
      metro,
      firstObject,
      secondObject,
      fallbackObject,
      firstSource,
      secondSource,
      fallbackSource,
    };
  }

  async function deleteComparisonFixture(fixture) {
    await prisma.feedSource.deleteMany({
      where: { id: { in: [fixture.firstSource.id, fixture.secondSource.id, fixture.fallbackSource.id] } },
    });
    await prisma.realEstateObject.deleteMany({
      where: { id: { in: [fixture.firstObject.id, fixture.secondObject.id, fixture.fallbackObject.id] } },
    });
    await prisma.metroStation.deleteMany({ where: { id: fixture.metro.id } });
    await prisma.location.deleteMany({ where: { id: fixture.district.id } });
    await prisma.developer.deleteMany({
      where: { id: { in: [
        fixture.firstDeveloper.id,
        fixture.secondDeveloper.id,
        fixture.fallbackDeveloper.id,
      ] } },
    });
  }

  function createSearchIntent(hardFilterOverrides) {
    return {
      taskType: 'SEARCH',
      comparisonTargets: [],
      hardFilters: { ...createEmptyAssistantSearchFilters(), ...hardFilterOverrides },
      softPreferences: createEmptyAssistantSearchFilters(),
      requiredFacts: ['PRICE', 'AVAILABILITY', 'FRESHNESS', 'LINK'],
      needsClarification: false,
      clarificationQuestion: null,
    };
  }

  function assertRelaxationAnswer(answer, expectedType) {
    assert.equal(answer.exactResults.length, 0);
    assert.equal(answer.alternatives.length > 0 && answer.alternatives.length <= 2, true);
    assert.equal(
      answer.alternatives.every(({ deviations }) =>
        deviations.length === 1 && deviations[0].type === expectedType),
      true,
    );
  }
}
