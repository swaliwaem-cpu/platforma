require('reflect-metadata');

const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const test = require('node:test');

const { runAssistantAgent, pageMentionsPrice } = require('../dist/assistant/assistant-agent.js');
const { stripProjectPrefix } = require('../dist/assistant/assistant-catalog.tools.js');
const {
  AssistantWebTools,
  extractLotRecords,
  parseYandexSearchXml,
  selectSearchResults,
  validatePublicUrl,
} = require('../dist/assistant/assistant-web.tools.js');
const { AssistantService, isAssistantEnabledForActor } = require('../dist/assistant/assistant.service.js');

const veerLot = {
  source: 'PLATFORMA',
  unitId: '11111111-1111-4111-8111-111111111111',
  projectTitle: 'Жилой комплекс Веер 2',
  href: '/objects/veer-2/lots/11111111-1111-4111-8111-111111111111',
  projectHref: '/objects/veer-2',
  developer: 'MR Group',
  rooms: 1,
  areaM2: 34.8,
  floor: 2,
  priceRub: 18_229_960,
  building: null,
  completion: '3 кв. 2030',
  updatedAt: '2026-09-23T07:00:00.000Z',
};

function scriptedLlm(steps) {
  const requests = [];
  return {
    requests,
    isConfigured: () => true,
    async complete(request) {
      requests.push(structuredClone({ ...request, signal: undefined }));
      const step = steps[requests.length - 1];
      if (!step) throw new Error(`unexpected model call ${requests.length}`);
      return { content: step.content ?? null, toolCalls: step.toolCalls ?? [], usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
}

function call(name, args, id = name) {
  return { id, name, arguments: JSON.stringify(args) };
}

function fakeCatalog({ projects = [], searches = [] } = {}) {
  const calls = { findProjects: [], searchLots: [] };
  return {
    calls,
    async findProjects(query) {
      calls.findProjects.push(query);
      return { projects, partialMatch: false };
    },
    async searchLots(input) {
      calls.searchLots.push(input);
      return searches[calls.searchLots.length - 1] ?? { total: 0, lots: [] };
    },
  };
}

function fakeWeb({ searchConfigured = false, pages = {} } = {}) {
  const opened = [];
  return {
    opened,
    isSearchConfigured: () => searchConfigured,
    async search() {
      return [{ title: 'Sminex', url: 'https://www.sminex.com/podbor', snippet: '' }];
    },
    async openPage(url) {
      opened.push(url);
      const page = pages[url];
      if (!page) throw new Error('unexpected page');
      return page;
    },
  };
}

function context(content, extra = {}) {
  return { history: [{ role: 'user', content }], pageProject: null, now: new Date('2026-09-23T10:00:00Z'), ...extra };
}

test('assistant shows only platform lots that the lot search actually returned', async () => {
  const llm = scriptedLlm([
    { toolCalls: [call('find_projects', { query: 'Веер 2' })] },
    { toolCalls: [call('search_lots', { projectIds: ['p-veer'], rooms: [1], budgetMaxRub: 20_000_000 })] },
    {
      toolCalls: [call('give_answer', {
        text: 'Нашёл однушки в Веер 2.',
        platformLotIds: [veerLot.unitId, '99999999-9999-4999-8999-999999999999'],
      })],
    },
  ]);
  const catalog = fakeCatalog({
    projects: [{ projectId: 'p-veer', title: 'Жилой комплекс Веер 2', slug: 'veer-2', developer: 'MR Group', district: null, metro: [], address: null, availableLots: 69, priceFromRub: 18_229_960, roomsAvailable: [1, 2] }],
    searches: [{ total: 69, lots: [veerLot] }],
  });
  const steps = [];

  const result = await runAssistantAgent(
    { llm, catalog, web: fakeWeb() },
    context('однушка до 20 млн в ЖК Веер 2', { onStep: (step) => steps.push(step) }),
  );

  assert.equal(catalog.calls.findProjects[0], 'Веер 2');
  assert.deepEqual(catalog.calls.searchLots[0].projectIds, ['p-veer']);
  assert.deepEqual(catalog.calls.searchLots[0].rooms, [1]);
  assert.equal(catalog.calls.searchLots[0].budgetMaxRub, 20_000_000);
  assert.deepEqual(result.answer.lots.map((lot) => lot.unitId), [veerLot.unitId]);
  assert.match(result.answer.historyNote, new RegExp(veerLot.unitId));
  assert.deepEqual(steps, ['Ищу «Веер 2» в Platforma', 'Подбираю лоты в Platforma', 'Формирую ответ']);
  assert.equal(result.usage.modelCalls, 3);
});

test('an empty budget search comes back with the cheapest lots outside the budget', async () => {
  const llm = scriptedLlm([
    { toolCalls: [call('search_lots', { rooms: [0], budgetMaxRub: 12_000_000 })] },
    { toolCalls: [call('give_answer', { text: 'В бюджете студий нет.', platformLotIds: [veerLot.unitId] })] },
  ]);
  const catalog = fakeCatalog({ searches: [{ total: 0, lots: [] }, { total: 613, lots: [veerLot] }] });

  const result = await runAssistantAgent({ llm, catalog, web: fakeWeb() }, context('студия до 12 млн'));

  assert.equal(catalog.calls.searchLots[1].budgetMaxRub, undefined);
  assert.equal(catalog.calls.searchLots[1].sort, 'price_asc');
  const toolResult = JSON.parse(llm.requests[1].messages.at(-1).content);
  assert.equal(toolResult.nearestWithoutBudget.total, 613);
  assert.deepEqual(result.answer.lots.map((lot) => lot.unitId), [veerLot.unitId]);
});

test('web lots survive only for opened sites and keep only prices seen on the page', async () => {
  const pageUrl = 'https://www.sminex.com/podbor-nedvizhimosti';
  const page = {
    url: pageUrl,
    title: 'Подбор',
    text: 'Обыденский №1 пентхаус 781,3 м²',
    links: [],
    data: [{ url: 'https://apikey.sminex.com/', json: '[{"flatPrice":"7087510000","flatArea":"781.3"}]' }],
  };
  const llm = scriptedLlm([
    { toolCalls: [call('open_page', { url: pageUrl })] },
    {
      toolCalls: [call('give_answer', {
        text: 'Нашёл на сайте Sminex.',
        webLots: [
          { projectTitle: 'Обыденский №1', rooms: 5, areaM2: 781.3, priceRub: 7_087_510_000, url: pageUrl },
          { projectTitle: 'Обыденский №1', rooms: 4, areaM2: 400, priceRub: 999_000_000, url: 'https://www.sminex.com/other' },
          { projectTitle: 'Выдумка', priceRub: 1_000_000, url: 'https://invented.example/flat' },
          { projectTitle: 'Только ссылка', url: pageUrl },
        ],
      })],
    },
  ]);
  const web = fakeWeb({ pages: { [pageUrl]: page } });

  const result = await runAssistantAgent({ llm, catalog: fakeCatalog(), web }, context(`что есть в Обыденском? ${pageUrl}`));

  assert.deepEqual(web.opened, [pageUrl]);
  assert.equal(result.answer.lots.length, 2);
  assert.deepEqual(result.answer.lots.map((lot) => [lot.source, lot.siteName, lot.priceRub]), [
    ['WEB', 'sminex.com', 7_087_510_000],
    ['WEB', 'sminex.com', null],
  ]);
  assert.deepEqual(result.answer.webSources, [{ url: pageUrl, siteName: 'sminex.com', title: 'Подбор' }]);
});

test('a web lot that duplicates a shown Platforma lot is dropped', async () => {
  const pageUrl = 'https://www.mr-group.ru/veer/';
  const page = { url: pageUrl, title: 'Веер', text: `Однушка ${veerLot.priceRub} ₽`, links: [], data: [] };
  const llm = scriptedLlm([
    { toolCalls: [call('search_lots', { rooms: [1] })] },
    { toolCalls: [call('open_page', { url: pageUrl })] },
    {
      toolCalls: [call('give_answer', {
        text: 'Нашёл.',
        platformLotIds: [veerLot.unitId],
        webLots: [{ projectTitle: 'Веер 2', rooms: 1, priceRub: veerLot.priceRub, url: pageUrl }],
      })],
    },
  ]);

  const result = await runAssistantAgent(
    { llm, catalog: fakeCatalog({ searches: [{ total: 1, lots: [veerLot] }] }), web: fakeWeb({ pages: { [pageUrl]: page } }) },
    context('однушка в Веер 2'),
  );

  assert.deepEqual(result.answer.lots.map((lot) => lot.source), ['PLATFORMA']);
});

test('web search is offered to the model only when Yandex search is configured', async () => {
  const answer = { toolCalls: [call('give_answer', { text: 'ok' })] };
  const withoutSearch = scriptedLlm([answer]);
  await runAssistantAgent({ llm: withoutSearch, catalog: fakeCatalog(), web: fakeWeb() }, context('привет'));
  assert.ok(!withoutSearch.requests[0].tools.some((tool) => tool.name === 'web_search'));

  const withSearch = scriptedLlm([answer]);
  await runAssistantAgent({ llm: withSearch, catalog: fakeCatalog(), web: fakeWeb({ searchConfigured: true }) }, context('привет'));
  assert.ok(withSearch.requests[0].tools.some((tool) => tool.name === 'web_search'));
});

test('a plain-text reply is turned into a forced give_answer call without leaking pseudo calls', async () => {
  const llm = scriptedLlm([
    { content: 'Лотов нет.\n\ngive_answer(text="Лотов нет")' },
    { content: 'Лотов нет. give_answer(text="Лотов нет")' },
  ]);

  const result = await runAssistantAgent({ llm, catalog: fakeCatalog(), web: fakeWeb() }, context('лоты в Адмирале'));

  assert.equal(llm.requests[0].requiredTool, undefined);
  assert.equal(llm.requests[1].requiredTool, 'give_answer');
  assert.equal(result.answer.text, 'Лотов нет.');
});

test('tool failures are reported to the model instead of failing the turn', async () => {
  const llm = scriptedLlm([
    { toolCalls: [call('open_page', { url: 'https://down.example/' })] },
    { toolCalls: [call('give_answer', { text: 'Сайт недоступен.' })] },
  ]);
  const web = fakeWeb();
  web.openPage = async () => {
    const { AssistantWebToolError } = require('../dist/assistant/assistant-web.tools.js');
    throw new AssistantWebToolError('PAGE_UNREACHABLE');
  };

  const result = await runAssistantAgent({ llm, catalog: fakeCatalog(), web }, context('https://down.example/'));

  assert.deepEqual(JSON.parse(llm.requests[1].messages.at(-1).content), { error: 'PAGE_UNREACHABLE' });
  assert.equal(result.answer.text, 'Сайт недоступен.');
  assert.deepEqual(result.answer.webSources, []);
});

test('page price check accepts whole rubles and «млн» notation', () => {
  const page = { text: 'Квартира 52 м² — 41,4 млн ₽, другая за 44 410 000 ₽', data: [] };
  assert.equal(pageMentionsPrice(page, 41_400_000), true);
  assert.equal(pageMentionsPrice(page, 44_410_000), true);
  assert.equal(pageMentionsPrice(page, 50_000_000), false);
});

test('lot records are pulled out of arbitrary site JSON', () => {
  const json = JSON.stringify({
    data: {
      filters: [{ id: 'rooms', title: 'Комнаты' }],
      lots: [
        { id: 'a', projectName: 'Foriver', flatPrice: '41420000', flatArea: '52', flatRooms: '2', floorNumber: '13', imageUrl: 'https://x/1.webp', __typename: 'Lot' },
        { id: 'b', projectName: 'Foriver', flatPrice: '44410000', flatArea: '55', flatRooms: '2', floorNumber: '13', layouts: [{ link: 'x' }] },
      ],
    },
  });

  const records = JSON.parse(extractLotRecords(json));

  assert.deepEqual(records, [
    { projectName: 'Foriver', flatPrice: '41420000', flatArea: '52', flatRooms: '2', floorNumber: '13' },
    { projectName: 'Foriver', flatPrice: '44410000', flatArea: '55', flatRooms: '2', floorNumber: '13' },
  ]);
  assert.equal(extractLotRecords(JSON.stringify({ buildings: [{ name: 'Корпус 1', floors: 18 }] })), null);
  assert.equal(extractLotRecords('not json'), null);
});

test('Yandex search XML is reduced to title, link and snippet', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?><yandexsearch><response><results><grouping>
    <group><doc><url>https://www.sminex.com/foriver</url><title>Квартал <hlword>Foriver</hlword></title>
      <passages><passage>Выбрать <hlword>квартиру</hlword></passage></passages></doc></group>
    <group><doc><url>ftp://bad.example/</url><title>bad</title></doc></group>
  </grouping></results></response></yandexsearch>`;

  assert.deepEqual(parseYandexSearchXml(xml), [
    { url: 'https://www.sminex.com/foriver', title: 'Квартал Foriver', snippet: 'Выбрать квартиру' },
  ]);
});

test('search engine result pages are reduced to external result links', () => {
  const results = selectSearchResults([
    { href: 'https://search.yahoo.com/settings', text: 'Настройки', block: '' },
    { href: 'https://r.search.yahoo.com/_ylt=abc/RU=https%3a%2f%2fzhk-admiral-moskva-i.cian.ru%2f/RK=2/RS=x', text: 'ЖК Адмирал — Циан', block: 'ЖК Адмирал — Циан Квартиры от застройщика' },
    { href: 'https://zhk-admiral-moskva-i.cian.ru/#flats', text: 'ЖК Адмирал — Циан', block: '' },
    { href: 'https://domclick.ru/complexes/zhk-admiral__122880', text: 'Домклик', block: 'Домклик Цены от 15 млн' },
    { href: 'https://www.youtube.com/watch?v=1', text: 'Видеообзор ЖК', block: '' },
    { href: 'javascript:void(0)', text: 'Ещё', block: '' },
  ], 'search.yahoo.com');

  assert.deepEqual(results, [
    { url: 'https://zhk-admiral-moskva-i.cian.ru/', title: 'ЖК Адмирал — Циан', snippet: 'Квартиры от застройщика' },
    { url: 'https://domclick.ru/complexes/zhk-admiral__122880', title: 'Домклик', snippet: 'Цены от 15 млн' },
  ]);
});

test('Yandex search client sends the API key and folder and decodes rawData', { concurrency: false }, async () => {
  const requests = [];
  const xml = '<yandexsearch><response><results><grouping><group><doc><url>https://cian.ru/zhk-1/</url><title>ЖК</title></doc></group></grouping></results></response></yandexsearch>';
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ authorization: request.headers.authorization, body: JSON.parse(body) });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ rawData: Buffer.from(xml).toString('base64') }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previous = {
    key: process.env.YANDEX_SEARCH_API_KEY,
    folder: process.env.YANDEX_SEARCH_FOLDER_ID,
    url: process.env.YANDEX_SEARCH_API_URL,
  };
  process.env.YANDEX_SEARCH_API_KEY = 'test-search-key';
  process.env.YANDEX_SEARCH_FOLDER_ID = 'test-folder';
  process.env.YANDEX_SEARCH_API_URL = `http://127.0.0.1:${server.address().port}/v2/web/search`;
  try {
    const web = new AssistantWebTools();
    assert.equal(web.isSearchConfigured(), true);
    const results = await web.search('ЖК Адмирал квартиры');
    assert.deepEqual(results, [{ url: 'https://cian.ru/zhk-1/', title: 'ЖК', snippet: '' }]);
    assert.equal(requests[0].authorization, 'Api-Key test-search-key');
    assert.equal(requests[0].body.folderId, 'test-folder');
    assert.equal(requests[0].body.query.queryText, 'ЖК Адмирал квартиры');
  } finally {
    for (const [name, value] of [['YANDEX_SEARCH_API_KEY', previous.key], ['YANDEX_SEARCH_FOLDER_ID', previous.folder], ['YANDEX_SEARCH_API_URL', previous.url]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await new Promise((resolve) => server.close(resolve));
  }
});

test('pages on private networks are never opened', async () => {
  await assert.rejects(validatePublicUrl('http://postgres/', async () => ['172.18.0.2']), { code: 'URL_HOST_NOT_PUBLIC' });
  await assert.rejects(validatePublicUrl('file:///etc/passwd', async () => ['8.8.8.8']), { code: 'URL_NOT_ALLOWED' });
  await assert.rejects(validatePublicUrl('https://example.com:8443/', async () => ['8.8.8.8']), { code: 'URL_NOT_ALLOWED' });
  const url = await validatePublicUrl('https://www.sminex.com/foriver#flats', async () => ['185.1.1.1']);
  assert.equal(url.toString(), 'https://www.sminex.com/foriver');
});

test('project prefixes are stripped before the catalog search', () => {
  assert.equal(stripProjectPrefix('ЖК «Веер 2»'), 'Веер 2');
  assert.equal(stripProjectPrefix('Клубный дом Аристарховский'), 'Аристарховский');
  assert.equal(stripProjectPrefix('Lion Gate'), 'Lion Gate');
});

test('assistant access follows the module flag, objects:read and the rollout stage', () => {
  const admin = { id: 'a', permissions: ['objects:read', 'admin:access'] };
  const broker = { id: 'b', permissions: ['objects:read'] };
  const enabled = { ASSISTANT_MODULE_ENABLED: 'true' };

  assert.equal(isAssistantEnabledForActor(admin, {}), false);
  assert.equal(isAssistantEnabledForActor(admin, enabled), true);
  assert.equal(isAssistantEnabledForActor(broker, enabled), false);
  assert.equal(isAssistantEnabledForActor(broker, { ...enabled, ASSISTANT_ROLLOUT_STAGE: 'PILOT', ASSISTANT_PILOT_USER_IDS: 'x, b' }), true);
  assert.equal(isAssistantEnabledForActor(broker, { ...enabled, ASSISTANT_ROLLOUT_STAGE: 'ALL' }), true);
  assert.equal(isAssistantEnabledForActor({ id: 'c', permissions: ['admin:access'] }, { ...enabled, ASSISTANT_ROLLOUT_STAGE: 'ALL' }), false);
});

test('assistant jobs belong to their owner and one runs at a time per user', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const llm = {
    isConfigured: () => true,
    async complete() {
      await blocked;
      return { content: null, toolCalls: [call('give_answer', { text: 'Готово' })], usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const prisma = { realEstateObject: { findFirst: async () => ({ id: 'p-veer', title: 'Веер 2' }) } };
  const service = new AssistantService(prisma, llm, fakeCatalog(), fakeWeb());
  const owner = { id: 'owner', permissions: ['objects:read'] };
  const stranger = { id: 'stranger', permissions: ['objects:read'] };

  await assert.rejects(service.startJob(owner, { messages: [{ role: 'assistant', content: 'привет' }] }), /ASSISTANT_MESSAGE_REQUIRED/);
  const job = await service.startJob(owner, { messages: [{ role: 'user', content: 'однушка' }], pageObjectSlug: 'veer-2' });
  assert.equal(job.status, 'RUNNING');
  await assert.rejects(service.startJob(owner, { messages: [{ role: 'user', content: 'ещё' }] }), /ASSISTANT_JOB_ALREADY_RUNNING/);
  assert.throws(() => service.getJob(stranger, job.id), /ASSISTANT_JOB_NOT_FOUND/);

  release();
  for (let attempt = 0; attempt < 50 && service.getJob(owner, job.id).status === 'RUNNING'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const finished = service.getJob(owner, job.id);
  assert.equal(finished.status, 'COMPLETED');
  assert.equal(finished.answer.text, 'Готово');
  service.onModuleDestroy();
});

test('eval checks compare tool arguments, projects and answer words', () => {
  const { checkCase } = require('../scripts/assistant-eval.cjs');
  const calls = [
    { name: 'find_projects', args: { query: 'ЖК Веер 2' } },
    { name: 'search_lots', args: { propertyClasses: ['Делюкс', 'Премиум-класс'], budgetMaxRub: 300000000, district: 'Хамовники' } },
  ];
  const answer = { text: 'Нашёл лоты в Делюксе.', lots: [{ projectTitle: 'Клубный квартал Фрунзенская набережная' }], sources: [] };

  const checks = checkCase({
    tools: [
      { name: 'find_projects', args: { query: 'веер' } },
      { name: 'search_lots', args: { propertyClasses: ['Делюкс'], budgetMaxRub: 300000000, district: 'Хамовник' } },
      { name: 'search_lots', args: { budgetMaxRub: 200000000 } },
      { name: 'get_project_facts' },
    ],
    notTools: ['web_search', 'find_projects'],
    projectsInclude: ['фрунзенская'],
    projectsExclude: ['Веер'],
    textIncludes: [['делюкс', 'элит'], 'отделк'],
    textExcludes: ['lotId'],
  }, { answer, calls });

  assert.deepEqual(checks.map((check) => check.passed), [true, true, false, false, true, false, true, true, true, false, true]);
});
