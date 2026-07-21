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
const qrPath = path.join(
  rootDir,
  'apps/api/assets/project-presentations/telegram-qr.png',
);
const pdfSourcePath = path.join(
  rootDir,
  'apps/api/src/project-presentations/project-presentations-pdf.service.ts',
);

function createSnapshot(objectsCount) {
  return {
    schemaVersion: 1,
    templateVersion: 'project-catalog-4x5-v1',
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
      advantages: ['Рядом с парком', 'Закрытый двор', 'Готовая инфраструктура'],
      propertyClass: 'Бизнес',
      completion: '4 кв. 2027',
      price: 'от 25 000 000 ₽',
      district: 'Хамовники',
      developer: 'Девелопер',
      metro: 'Спортивная',
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

test('project PDF uses a 4:5 canvas and produces exactly N + 4 pages', async () => {
  assert.equal(PROJECT_PRESENTATION_PAGE_WIDTH / PROJECT_PRESENTATION_PAGE_HEIGHT, 4 / 5);

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
  assert.match(
    fs.readFileSync(pdfSourcePath, 'utf8'),
    /resolveAsset\('project-presentations\/telegram-qr\.png'\)[\s\S]*doc\.image\(qr,[\s\S]*doc\.link\([\s\S]*cta\.url/,
  );
});

test('Telegram QR asset is a non-empty square PNG used by the PDF template', async () => {
  const buffer = fs.readFileSync(qrPath);
  const metadata = await sharp(buffer).metadata();

  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, metadata.height);
  assert.ok((metadata.width ?? 0) >= 256);
  assert.ok(buffer.length > 1_000);
});
