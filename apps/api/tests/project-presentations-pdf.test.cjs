const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const sharp = require('sharp');

const {
  ProjectPresentationsPdfService,
} = require('../dist/project-presentations/project-presentations-pdf.service.js');
const {
  PROJECT_PRESENTATION_PAGE_HEIGHT,
  PROJECT_PRESENTATION_PAGE_WIDTH,
} = require('../dist/project-presentations/project-presentations.types.js');

const rootDir = path.resolve(__dirname, '../../..');
const logoPath = path.join(
  rootDir,
  'apps/api/assets/project-presentations/fluffywhite-logo-gold.png',
);
const displayFontPath = path.join(
  rootDir,
  'apps/api/assets/fonts/NotoSerifDisplay-Regular.ttf',
);
const pdfSourcePath = path.join(
  rootDir,
  'apps/api/src/project-presentations/project-presentations-pdf.service.ts',
);

function createSnapshot(objectsCount) {
  return {
    schemaVersion: 1,
    templateVersion: 'project-catalog-editorial-a-3x4-v2',
    page: {
      width: PROJECT_PRESENTATION_PAGE_WIDTH,
      height: PROJECT_PRESENTATION_PAGE_HEIGHT,
    },
    requestedAt: '2026-07-20T10:00:00.000Z',
    title: `Подборка из ${objectsCount} ЖК`,
    cover: {
      title: 'Лучшие проекты Москвы',
      subtitle: 'Персональная подборка',
      clientName: 'Анна',
      issueLabel: 'Июль 2026',
      image: null,
    },
    cta: {
      label: '@FluffyWhite',
      url: 'https://t.me/FluffyWhite',
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
      images: [],
    })),
  };
}

function inspectPdf(buffer) {
  const source = buffer.toString('latin1');
  return {
    header: source.slice(0, 8),
    mediaBoxes: source.match(/\/MediaBox\s*\[0 0 [\d.]+ [\d.]+\]/g) ?? [],
    pages: source.match(/\/Type\s*\/Page\b/g) ?? [],
    source,
  };
}

test('project PDF uses a 3:4 canvas and produces exactly N + 4 pages', async () => {
  assert.equal(PROJECT_PRESENTATION_PAGE_WIDTH / PROJECT_PRESENTATION_PAGE_HEIGHT, 3 / 4);

  for (const objectsCount of [1, 12]) {
    const progress = [];
    const service = new ProjectPresentationsPdfService({});
    const buffer = await service.generate(
      createSnapshot(objectsCount),
      async (value) => progress.push(value),
    );
    const inspected = inspectPdf(buffer);
    const expectedPages = objectsCount + 4;

    assert.equal(inspected.header, '%PDF-1.3');
    assert.equal(inspected.pages.length, expectedPages);
    assert.equal(inspected.mediaBoxes.length, expectedPages);
    assert.ok(
      inspected.mediaBoxes.every(
        (entry) => entry === `/MediaBox [0 0 ${PROJECT_PRESENTATION_PAGE_WIDTH} ${PROJECT_PRESENTATION_PAGE_HEIGHT}]`,
      ),
    );
    assert.equal(progress.at(-1), 99);
    assert.ok(progress.every((value, index) => index === 0 || value >= progress[index - 1]));
  }
});

test('project PDF embeds clickable FluffyWhite Telegram links', async () => {
  const service = new ProjectPresentationsPdfService({});
  const buffer = await service.generate(createSnapshot(1));
  const source = buffer.toString('latin1');
  const telegramLinks = source.match(/https:\/\/t\.me\/FluffyWhite/g) ?? [];

  assert.ok(telegramLinks.length >= 3, `expected at least 3 Telegram links, received ${telegramLinks.length}`);
  assert.match(fs.readFileSync(pdfSourcePath, 'utf8'), /УЗНАТЬ ПОДРОБНОСТИ[\s\S]*snapshot\.cta\.url/);
});

test('editorial map keeps legacy snapshots without coordinates renderable', async () => {
  const snapshot = createSnapshot(2);
  for (const object of snapshot.objects) {
    delete object.latitude;
    delete object.longitude;
  }

  const buffer = await new ProjectPresentationsPdfService({}).generate(snapshot);
  assert.equal(inspectPdf(buffer).pages.length, 6);
});

test('editorial template embeds the FluffyWhite logo and local Noto Serif Display font', async () => {
  const logoBuffer = fs.readFileSync(logoPath);
  const metadata = await sharp(logoBuffer).metadata();
  const source = fs.readFileSync(pdfSourcePath, 'utf8');

  assert.deepEqual([...logoBuffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(metadata.format, 'png');
  assert.ok((metadata.width ?? 0) >= 200);
  assert.ok((metadata.height ?? 0) >= 200);
  assert.ok(logoBuffer.length > 1_000);
  assert.ok(fs.statSync(displayFontPath).size > 100_000);
  assert.match(source, /resolveAsset\('fonts\/NotoSerifDisplay-Regular\.ttf'\)/);
  assert.match(source, /resolveAsset\('project-presentations\/fluffywhite-logo-gold\.png'\)/);
  assert.match(source, /registerFont\('NotoSerifDisplay'/);
});
