const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const sharp = require('sharp');

// Automated tests never reach the external map tiles.
process.env.PROJECT_PRESENTATIONS_MAP_ENABLED = 'false';

const {
  ProjectPresentationsPdfService,
  resolveBrowserExecutablePath,
} = require('../dist/project-presentations/project-presentations-pdf.service.js');
const {
  getProjectPresentationMapConfig,
  renderProjectPresentationMap,
} = require('../dist/project-presentations/project-presentations-map.js');
const {
  PROJECT_PRESENTATION_PAGE_HEIGHT,
  PROJECT_PRESENTATION_PAGE_WIDTH,
} = require('../dist/project-presentations/project-presentations.types.js');

const rootDir = path.resolve(__dirname, '../../..');
const fontsDir = path.join(rootDir, 'packages/shared/assets/project-presentation-fonts');
const loadTemplate = () => import('@platforma/shared/project-presentation-template');

function createSnapshot(objectsCount) {
  return {
    schemaVersion: 3,
    templateVersion: 'project-catalog-fw-html-3x4-v4',
    page: {
      width: PROJECT_PRESENTATION_PAGE_WIDTH,
      height: PROJECT_PRESENTATION_PAGE_HEIGHT,
    },
    requestedAt: '2026-09-16T10:00:00.000Z',
    title: `Подборка из ${objectsCount} ЖК`,
    cover: {
      title: 'ТОП 12 ЖК у парков',
      subtitle: 'Архитектура и зелёные маршруты для жизни в Москве.',
      clientName: 'Анны',
      issueLabel: 'Каталог 2026',
      image: { fileId: 'cover', checksum: null, role: 'COVER', sortOrder: 0 },
      features: [
        { title: 'Локация и факты', caption: 'Район, метро и класс' },
        { title: 'Наши условия', caption: '' },
        { title: 'Старты продаж', caption: 'Новые предложения' },
        { title: 'Условия покупки', caption: 'Стоимость и рассрочка' },
      ],
    },
    map: { title: 'Москва рядом с парком' },
    cta: {
      label: '@svetlana_fluffywhite',
      url: 'https://t.me/svetlana_fluffywhite',
    },
    broker: {
      name: 'Мария Брокер',
      phone: '+7 999 111-22-33',
      email: 'broker@example.com',
      profilePhoto: null,
    },
    objects: Array.from({ length: objectsCount }, (_, index) => ({
      sourceObjectId: `object-${index + 1}`,
      sortOrder: index,
      title: `Жилой комплекс ${index + 1}`,
      description: `Краткое описание проекта ${index + 1}`,
      advantages: ['Рядом с парком', 'Закрытый двор', 'Готовая инфраструктура', 'Виды на город'],
      propertyClass: 'Бизнес',
      completion: '4 кв. 2027',
      price: 'от 25 000 000 ₽',
      district: 'Хамовники',
      developer: 'Девелопер',
      metro: 'Спортивная',
      latitude: 55.73 + index * 0.01,
      longitude: 37.55 + index * 0.01,
      images: [0, 1, 2].map((slot) => ({ fileId: `photo-${slot}`, checksum: null, role: 'PROJECT', sortOrder: slot })),
    })),
  };
}

async function createFilesService() {
  const buffer = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#8aa1b1' } }).jpeg().toBuffer();
  return { getContent: async () => ({ buffer }) };
}

function inspectPdf(buffer) {
  const source = buffer.toString('latin1');
  return {
    header: source.slice(0, 5),
    mediaBoxes: source.match(/\/MediaBox\s*\[0 0 [\d.]+ [\d.]+\]/g) ?? [],
    pages: source.match(/\/Type\s*\/Page\b/g) ?? [],
    source,
  };
}

test('project PDF is printed by Chromium on a 3:4 canvas with exactly N + 4 pages', async () => {
  assert.equal(PROJECT_PRESENTATION_PAGE_WIDTH / PROJECT_PRESENTATION_PAGE_HEIGHT, 3 / 4);
  assert.ok(resolveBrowserExecutablePath(), 'a Chromium executable is required to print project presentations');
  const filesService = await createFilesService();

  for (const objectsCount of [1, 12]) {
    const progress = [];
    const buffer = await new ProjectPresentationsPdfService(filesService).generate(
      createSnapshot(objectsCount),
      async (value) => progress.push(value),
    );
    const inspected = inspectPdf(buffer);
    const expectedPages = objectsCount + 4;

    assert.equal(inspected.header, '%PDF-');
    assert.equal(inspected.pages.length, expectedPages);
    assert.equal(inspected.mediaBoxes.length, expectedPages);
    assert.ok(inspected.mediaBoxes.every((entry) => entry === '/MediaBox [0 0 540 720]'));
    assert.equal(progress.at(-1), 99);
    assert.ok(progress.every((value, index) => index === 0 || value >= progress[index - 1]));
  }
});

test('project PDF links every project, the catalog contacts and always dials the catalog number', async () => {
  const buffer = await new ProjectPresentationsPdfService(await createFilesService()).generate(createSnapshot(2));
  const source = buffer.toString('latin1');

  // Each project button opens the chat with the project title typed in.
  for (const index of [1, 2]) {
    const url = `https://t.me/svetlana_fluffywhite?text=${encodeURIComponent(`Жилой комплекс ${index}`)}`;
    assert.ok(source.includes(`/URI (${url})`), url);
  }
  for (const url of [
    'https://clck.ru/3QmQoS',
    'https://www.instagram.com/fluffywhite.estate/',
    'https://t.me/+OacAOVxTqWM0Y2Ji',
    'https://www.youtube.com/@fluffywhite.moscow',
  ]) assert.ok(source.includes(`/URI (${url})`), url);
  // The presentation is published by the company, so the broker phone of the snapshot is never printed.
  assert.match(source, /tel:\+74954924858/);
  assert.doesNotMatch(source, /tel:\+79991112233/);
});

test('the final page always shows the catalog phone number', async () => {
  const template = await loadTemplate();
  const fontUrls = Object.fromEntries(template.PROJECT_PRESENTATION_FONT_FILES.map((file) => [file, `/fonts/${file}`]));
  const html = template.renderProjectPresentationHtml(
    { cover: { title: 'T', subtitle: '', issueLabel: '', imageSrc: null }, map: { title: 'M', imageSrc: null, markers: [] }, projects: [], contacts: { ctaUrl: 'https://t.me/svetlana_fluffywhite' } },
    { fontUrls, pageKeys: ['final'] },
  );

  assert.equal(template.PROJECT_PRESENTATION_DEFAULT_PHONE, '+7 (495) 492-48-58');
  assert.match(html, /href="tel:\+74954924858"[^>]*>\+7 \(495\) 492-48-58</);
});

test('every value of the project card keeps one font size instead of shrinking to its length', async () => {
  const template = await loadTemplate();
  const fontUrls = Object.fromEntries(template.PROJECT_PRESENTATION_FONT_FILES.map((file) => [file, `/fonts/${file}`]));
  const project = {
    key: 'p1',
    title: 'ЖК',
    description: 'Описание',
    price: 'от 421 200 300 ₽',
    propertyClass: 'Премиум-класс',
    metro: 'Улица Академика Янгеля',
    advantages: ['Р'.repeat(40), 'Два', 'Три', 'Четыре'],
    imageSrcs: [null, null, null],
  };
  const html = template.renderProjectPresentationHtml(
    { cover: { title: 'T', subtitle: '', issueLabel: '', imageSrc: null }, map: { title: 'M', imageSrc: null, markers: [] }, projects: [project], contacts: { ctaUrl: 'https://t.me/svetlana_fluffywhite' } },
    { fontUrls, pageKeys: ['p1'] },
  );

  // The price, both rows and the advantages are printed at their reference size whatever their length.
  for (const marker of ['fw-facts__price', 'fw-facts__advantage', '<dd>']) {
    assert.doesNotMatch(html.slice(html.indexOf(marker) - 120, html.indexOf(marker) + 40), /data-fit/, marker);
  }
  assert.match(html, /<dd>Премиум-класс<\/dd>/);
  assert.match(html, /<dd>Улица Академика Янгеля<\/dd>/);
});

test('legacy v1 snapshots without coordinates, map title or photos stay renderable', async () => {
  const snapshot = { ...createSnapshot(2), schemaVersion: 1 };
  delete snapshot.map;
  snapshot.cover.image = null;
  for (const object of snapshot.objects) {
    delete object.latitude;
    delete object.longitude;
    object.images = [];
    object.advantages = ['Только одно'];
  }
  const failingFiles = { getContent: async () => { throw new Error('missing'); } };

  const buffer = await new ProjectPresentationsPdfService(failingFiles).generate(snapshot);
  assert.equal(inspectPdf(buffer).pages.length, 6);
});

test('template renders the approved page order, escapes user text and links the catalog contacts', async () => {
  const template = await loadTemplate();
  const fontUrls = Object.fromEntries(template.PROJECT_PRESENTATION_FONT_FILES.map((file) => [file, `/fonts/${file}`]));
  const model = {
    cover: { title: '<script>alert(1)</script>', subtitle: 'Подзаголовок', issueLabel: 'Каталог 2026', imageSrc: null, features: [{ title: 'Локации рядом', caption: 'Метро и парки' }] },
    map: { title: 'Москва рядом с парком', imageSrc: 'https://example.test/map.jpg', markers: [{ x: 10, y: 20, label: 'КОД Сокольники' }, { x: 600, y: 40, label: 'Дом Дау' }] },
    projects: [{
      key: 'p1',
      title: 'КОД Сокольники',
      description: 'Описание',
      price: 'от 421 200 300 ₽',
      propertyClass: 'Бизнес',
      metro: 'Сокольники',
      advantages: ['Один', 'Два', 'Три', 'Четыре', 'Лишнее'],
      imageSrcs: [null, null, null],
    }],
    contacts: { ctaUrl: 'https://t.me/svetlana_fluffywhite' },
  };

  const html = template.renderProjectPresentationHtml(model, { fontUrls });
  const pages = [...html.matchAll(/data-page="([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(pages, template.getProjectPresentationPageKeys(['p1']));
  assert.deepEqual(pages, ['cover', 'map', 'p1', 'company', 'final']);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  // The client name and the "prepared for" line were dropped from the cover.
  assert.doesNotMatch(html, /Подготовлено для/);
  assert.doesNotMatch(html, /Локации проектов/);
  // The four cover tiles keep their slots: the first one is reworded, the rest fall back to the catalog wording.
  assert.match(html, /<strong>Локации рядом<\/strong><span>Метро и парки<\/span>/);
  assert.match(html, /<strong>Условия покупки<\/strong><span>Стоимость и рассрочка<\/span>/);
  assert.equal((html.match(/class="fw-feature"/g) ?? []).length, 4);
  assert.match(html, /<span class="fw-facts__from">от<\/span><strong> 421 200 300 ₽<\/strong>/);
  assert.equal((html.match(/class="fw-facts__number"/g) ?? []).length, 4);
  assert.doesNotMatch(html, /OpenStreetMap/);
  // Markers carry the project titles and flip to the left when they sit near the right edge of the frame.
  assert.match(html, /class="fw-map__marker" style="left:10px;top:20px"><span class="fw-map__label">КОД Сокольники<\/span>/);
  assert.match(html, /class="fw-map__marker is-flipped" style="left:600px;top:40px"><span class="fw-map__label">Дом Дау<\/span>/);
  assert.ok(html.includes(
    `class="fw-button fw-button--details" href="https://t.me/svetlana_fluffywhite?text=${encodeURIComponent('КОД Сокольники')}"`,
  ));
  // The caption rule must not reach the icon tile, which is a span too and would lose its centering grid.
  assert.match(html, /\.fw-feature>div>span\{display:block;margin-top:8px/);
  assert.doesNotMatch(html, /\.fw-feature span\{/);
  // Blurred shadows turn into grey boxes in PDF viewers, so the map markers draw none.
  assert.doesNotMatch(html, /\.fw-map__(?:marker|label)\{[^}]*box-shadow:[^;}]*\d+px \d+px \d+px/);
  assert.match(html, /class="fw-button fw-button--start" href="https:\/\/clck\.ru\/3QmQoS"/);
  assert.match(html, /<a href="https:\/\/www\.instagram\.com\/fluffywhite\.estate\/" class="fw-social"><span>Instagram<\/span>/);
  assert.match(html, /<a href="https:\/\/t\.me\/\+OacAOVxTqWM0Y2Ji" class="fw-social"><span>Telegram<\/span>/);
  assert.match(html, /<a href="https:\/\/www\.youtube\.com\/@fluffywhite\.moscow" class="fw-social"><span>YouTube<\/span>/);
  assert.doesNotMatch(html, /<span class="fw-social">/);
  assert.match(html, /href="tel:\+74954924858"/);
  assert.match(html, /font-kerning:none!important/);
  for (const file of template.PROJECT_PRESENTATION_FONT_FILES) assert.ok(html.includes(`/fonts/${file}`));

  const coverOnly = template.renderProjectPresentationHtml(model, { fontUrls, pageKeys: ['cover'] });
  assert.deepEqual([...coverOnly.matchAll(/data-page="([^"]+)"/g)].map((match) => match[1]), ['cover']);
});

test('description is cut to 430 characters on a word boundary and markers fit the map frame', async () => {
  const template = await loadTemplate();
  const long = `${'Квартал у парка с набережной '.repeat(20)}конец`;
  const cut = template.truncateProjectPresentationDescription(long);

  assert.equal(template.PROJECT_PRESENTATION_LIMITS.description, 430);
  assert.ok(cut.length <= 430);
  assert.ok(cut.endsWith('…'));
  assert.ok(long.startsWith(cut.slice(0, -1)));
  assert.match(cut, /\S…$/);
  assert.equal(template.truncateProjectPresentationDescription('  Коротко   и ясно '), 'Коротко и ясно');

  const markers = template.getProjectPresentationFallbackMarkers([
    { latitude: 55.79, longitude: 37.68, label: 'Первый' },
    { latitude: null, longitude: 37.6, label: 'Без координат' },
    { latitude: 55.7, longitude: 37.5, label: 'Второй' },
  ]);
  assert.equal(markers.length, 2);
  assert.deepEqual(markers.map((marker) => marker.label), ['Первый', 'Второй']);
  for (const { x, y } of markers) {
    assert.ok(x >= 0 && x <= template.PROJECT_PRESENTATION_MAP_SIZE.width);
    assert.ok(y >= 0 && y <= template.PROJECT_PRESENTATION_MAP_SIZE.height);
  }
});

test('map rendering retries a stalled attempt on a fresh page and reports every stage', async () => {
  const template = await loadTemplate();
  const stages = [];
  const retries = [];
  let contexts = 0;
  const failingBrowser = {
    newContext: async () => {
      contexts += 1;
      return {
        route: async () => undefined,
        newPage: async () => { throw new Error(`stalled ${contexts}`); },
        close: async () => undefined,
      };
    },
  };

  await assert.rejects(
    () => renderProjectPresentationMap(
      failingBrowser,
      template,
      [{ latitude: 55.75, longitude: 37.61 }],
      { enabled: true, styleUrl: 'https://example.test/style', timeoutMs: 1000, attempts: 2 },
      { onStage: async (stage) => stages.push(stage), onRetry: (error, attempt) => retries.push([attempt, error.message]) },
    ),
    /stalled 2/,
  );
  assert.equal(contexts, 2);
  assert.deepEqual(retries, [[1, 'stalled 1']]);
  assert.deepEqual(stages, []);
});

test('reference fonts are bundled with their OFL licenses and runtime settings have safe defaults', async () => {
  const template = await loadTemplate();
  for (const file of template.PROJECT_PRESENTATION_FONT_FILES) {
    const buffer = fs.readFileSync(path.join(fontsDir, file));
    assert.equal(buffer.subarray(0, 4).toString('latin1'), 'wOF2', file);
    assert.ok(buffer.length > 20_000, file);
  }
  for (const license of ['Involve-OFL.txt', 'Inter-OFL.txt', 'Lora-OFL.txt']) {
    assert.match(fs.readFileSync(path.join(fontsDir, license), 'utf8'), /SIL OPEN FONT LICENSE/i);
  }

  assert.equal(resolveBrowserExecutablePath({ PROJECT_PRESENTATIONS_BROWSER_EXECUTABLE_PATH: '/opt/chromium' }), '/opt/chromium');
  assert.deepEqual(getProjectPresentationMapConfig({}), {
    enabled: true,
    styleUrl: 'https://tiles.openfreemap.org/styles/liberty',
    timeoutMs: 20_000,
    attempts: 2,
  });
  assert.equal(getProjectPresentationMapConfig({ PROJECT_PRESENTATIONS_MAP_ATTEMPTS: '0' }).attempts, 1);
  assert.equal(getProjectPresentationMapConfig({ PROJECT_PRESENTATIONS_MAP_ENABLED: 'false' }).enabled, false);
});

test('project contact link carries the page title as the prefilled Telegram message', async () => {
  const template = await loadTemplate();

  assert.equal(
    template.getProjectPresentationContactUrl('https://t.me/svetlana_fluffywhite', 'Соул'),
    'https://t.me/svetlana_fluffywhite?text=%D0%A1%D0%BE%D1%83%D0%BB',
  );
  assert.equal(
    template.getProjectPresentationContactUrl('https://t.me/svetlana_fluffywhite', '  Шагал  '),
    `https://t.me/svetlana_fluffywhite?text=${encodeURIComponent('Шагал')}`,
  );
  assert.equal(
    template.getProjectPresentationContactUrl('https://t.me/svetlana_fluffywhite', ' '),
    'https://t.me/svetlana_fluffywhite',
  );
  assert.equal(template.PROJECT_PRESENTATION_LINKS.chat, 'https://t.me/svetlana_fluffywhite');
});
