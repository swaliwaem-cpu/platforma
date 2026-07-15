const test = require('node:test');
const assert = require('node:assert/strict');

const { LocationType, ObjectFileType, ObjectStatus, RealEstateObjectType } = require('@prisma/client');
const { mapWordPressSource, slugify } = require('../dist/mapper.js');
const { createDeveloperAliases, loadDeveloperAliases, resolveDeveloperName } = require('../dist/developer-aliases.js');
const { commercialWordPressImportProfile } = require('../dist/profiles.js');

function makePost(overrides) {
  return {
    ID: 101,
    post_title: 'Fallback title',
    post_name: 'fallback-slug',
    post_content: '<p>Fallback description</p>',
    post_status: 'publish',
    post_date: '2026-04-01 12:30:00',
    post_modified: '2026-04-02 13:40:00',
    ...overrides,
  };
}

function makeAttachment(overrides) {
  return makePost({
    ID: 201,
    post_title: 'Attachment',
    post_name: 'attachment',
    post_content: '',
    post_status: 'inherit',
    attachedFile: '2026/04/image.jpg',
    localPath: '/tmp/image.jpg',
    localExists: true,
    sizeBytes: 12345,
    mimeType: 'image/jpeg',
    guid: 'https://example.test/uploads/2026/04/image.jpg',
    ...overrides,
  });
}

function makeMeta(entries) {
  return new Map(
    Object.entries(entries).map(([key, value]) => [key, Array.isArray(value) ? value : [value]]),
  );
}

function makeSource(overrides = {}) {
  const object = makePost({
    ID: 101,
    post_title: 'ЖК Северный',
    post_name: 'zhk-severnyy',
    post_content: '<p>Описание из WordPress</p>',
  });
  const terms = [
    { term_id: 1, name: 'Районы', slug: 'rajony', taxonomy: 'category', parent: 0 },
    { term_id: 2, name: 'Центральный', slug: 'centralnyy', taxonomy: 'category', parent: 1 },
    { term_id: 3, name: 'Район около', slug: 'rajon-okolo', taxonomy: 'category', parent: 0 },
    { term_id: 4, name: 'У воды', slug: 'u-vody', taxonomy: 'category', parent: 3 },
    { term_id: 10, name: 'Метро', slug: 'metro', taxonomy: 'category', parent: 0 },
    { term_id: 11, name: 'Красная линия', slug: 'red-line', taxonomy: 'category', parent: 10 },
    { term_id: 12, name: 'Площадь 1905 года', slug: 'ploshhad-1905-goda', taxonomy: 'category', parent: 11 },
    { term_id: 20, name: 'Год', slug: 'god', taxonomy: 'category', parent: 0 },
    { term_id: 21, name: '2027', slug: '2027', taxonomy: 'category', parent: 20 },
    { term_id: 30, name: 'Сдача', slug: 'sdacha', taxonomy: 'category', parent: 0 },
    { term_id: 31, name: '2 кв. 2027', slug: '2-kv-2027', taxonomy: 'category', parent: 30 },
  ];
  const attachments = [
    makeAttachment({ ID: 201, mimeType: 'image/jpeg', attachedFile: '2026/04/cover.jpg' }),
    makeAttachment({ ID: 202, mimeType: 'image/webp', attachedFile: '2026/04/gallery.webp' }),
    makeAttachment({
      ID: 301,
      mimeType: 'application/pdf',
      attachedFile: '2026/04/presentation.pdf',
      guid: 'https://example.test/uploads/2026/04/presentation.pdf',
    }),
    makeAttachment({
      ID: 302,
      mimeType: 'application/pdf',
      attachedFile: '2026/04/missing.pdf',
      localExists: false,
    }),
  ];

  return {
    siteUrl: 'https://example.test',
    uploadsPath: '/var/www/uploads',
    objects: [object],
    metaByPostId: new Map([
      [
        101,
        makeMeta({
          zagolovok_1: ' ЖК "Северный" ',
          korotkoe_opisanie: '<p>Короткое описание</p>',
          opisanie_2: '<p>Основное описание</p>',
          opisanie_3: '<p>Архитектура объекта</p>',
          opisanie_4_1: '<p>Инфраструктура объекта</p>',
          opisanie_4_2: '<p>Наполнение объекта</p>',
          opisanie_5: '<p>Расположение объекта</p>',
          imya_zastrojshhika: 'Девелопер',
          karta_koordinaty: '55.751244, 37.618423',
          stoimost: 'от 12 500 000 ₽',
          za_m2: '350000,50',
          adres: '<p>Екатеринбург, ул. Ленина, 1</p>',
          izobrazhenie_miniatyura: '201',
          izobrazhenie_1: '201',
          czikl_vyvoda_galerei_0_izobrazhenie: '202',
          czikl_vyvoda_galerei_0_izobrazhenie_alt: 'Двор',
          czikl_vyvoda_galerei_0_izobrazhenie_title: 'Вид во двор',
          pdf_fajl: '301',
          plan_pdf: '302',
        }),
      ],
    ]),
    termsByObjectId: new Map([
      [
        101,
        [4, 2, 12, 21, 31].map((termId) => ({
          ...terms.find((term) => term.term_id === termId),
          object_id: 101,
        })),
      ],
    ]),
    termsById: new Map(terms.map((term) => [term.term_id, term])),
    termMetaById: new Map([[11, makeMeta({ czvet_metro: '#ff0000' })]]),
    attachmentsById: new Map(attachments.map((attachment) => [attachment.ID, attachment])),
    referencedAttachmentIds: new Set([201, 202, 301, 302]),
    ...overrides,
  };
}

function makeDeveloperDuplicateSource() {
  return makeSource({
    objects: [
      makePost({
        ID: 101,
        post_title: 'Первый объект',
        post_name: 'first-object',
      }),
      makePost({
        ID: 102,
        post_title: 'Второй объект',
        post_name: 'second-object',
      }),
    ],
    metaByPostId: new Map([
      [
        101,
        makeMeta({
          zagolovok_1: 'Первый объект',
          imya_zastrojshhika: 'Coldy',
        }),
      ],
      [
        102,
        makeMeta({
          zagolovok_1: 'Второй объект',
          imya_zastrojshhika: 'COLDY',
        }),
      ],
    ]),
    termsByObjectId: new Map([
      [101, []],
      [102, []],
    ]),
    attachmentsById: new Map(),
    referencedAttachmentIds: new Set(),
  });
}

test('mapWordPressSource maps object fields, taxonomies, images and files', () => {
  const mapped = mapWordPressSource(makeSource(), 'nedvizhimost', true);
  const [object] = mapped.objects;

  assert.equal(mapped.summary.objectsFound, 1);
  assert.equal(mapped.summary.objectsMapped, 1);
  assert.equal(mapped.summary.developersMapped, 1);
  assert.equal(mapped.summary.locationsMapped, 2);
  assert.equal(mapped.summary.metroStationsMapped, 1);
  assert.equal(mapped.summary.validImagesMapped, 2);
  assert.equal(mapped.summary.validFilesMapped, 1);
  assert.equal(mapped.summary.referencedAttachments, 4);
  assert.equal(mapped.summary.dryRun, true);
  assert.equal(mapped.summary.profile, 'residential');
  assert.equal(mapped.summary.objectType, RealEstateObjectType.RESIDENTIAL);

  assert.equal(object.type, RealEstateObjectType.RESIDENTIAL);
  assert.equal(object.title, 'ЖК "Северный"');
  assert.equal(object.slug, 'zhk-severnyy');
  assert.equal(object.status, ObjectStatus.PUBLISHED);
  assert.equal(object.description, 'Основное описание');
  assert.equal(object.architectureDescription, 'Архитектура объекта');
  assert.equal(object.infrastructureDescription, 'Инфраструктура объекта');
  assert.equal(object.fillingDescription, 'Наполнение объекта');
  assert.equal(object.shortDescription, null);
  assert.equal(Object.hasOwn(object.featuresJson, 'shortDescription'), false);
  assert.equal(object.priceFrom, '12500000');
  assert.equal(object.pricePerMeterFrom, '350000.5');
  assert.equal(object.address, 'Екатеринбург, ул. Ленина, 1');
  assert.equal(object.latitude, '55.751244');
  assert.equal(object.longitude, '37.618423');
  assert.equal(object.completionYear, 2027);
  assert.equal(object.completionQuarter, 2);
  assert.equal(object.developer.slug, 'developer');
  assert.equal(object.primaryLocation.type, LocationType.DISTRICT);
  assert.equal(object.primaryLocation.name, 'Центральный');
  assert.equal(object.locations.some((location) => location.type === LocationType.AREA && location.name === 'У воды'), true);
  assert.equal(
    object.locations.some((location) => location.type === LocationType.DISTRICT && location.name === 'Центральный'),
    true,
  );
  assert.equal(object.metroStations[0].lineName, 'Красная линия');
  assert.equal(object.metroStations[0].lineColor, '#ff0000');
  assert.equal(object.images[0].attachment.ID, 201);
  assert.equal(object.images[0].isCover, true);
  assert.equal(object.images[1].attachment.ID, 202);
  assert.equal(object.images[1].alt, 'Двор');
  assert.equal(object.files[0].type, ObjectFileType.PRESENTATION);
  assert.equal(object.files[0].attachment.ID, 301);
  assert.equal(mapped.warnings.some((warning) => warning.code === 'missing_local_file'), true);
});

test('mapWordPressSource preserves nearby places from the ACF repeater in source order', () => {
  const source = makeSource({
    metaByPostId: new Map([
      [
        101,
        makeMeta({
          czikl_vyvoda_mest_ryadom: '2',
          czikl_vyvoda_mest_ryadom_1_nazvanie: 'ТЦ Ереван Плаза',
          czikl_vyvoda_mest_ryadom_1_koordinaty: '55.709328, 37.621255',
          czikl_vyvoda_mest_ryadom_1_skolko_dobiratsya: '6 мин. пешком',
          czikl_vyvoda_mest_ryadom_0_nazvanie: 'Даниловский рынок',
          czikl_vyvoda_mest_ryadom_0_koordinaty: '55.711883, 37.620677',
          czikl_vyvoda_mest_ryadom_0_skolko_dobiratsya: '10 мин. пешком',
        }),
      ],
    ]),
  });
  const [object] = mapWordPressSource(source, 'nedvizhimost', true).objects;

  assert.deepEqual(object.featuresJson.nearbyPlaces, [
    {
      nazvanie: 'Даниловский рынок',
      koordinaty: '55.711883, 37.620677',
      skolko_dobiratsya: '10 мин. пешком',
    },
    {
      nazvanie: 'ТЦ Ереван Плаза',
      koordinaty: '55.709328, 37.621255',
      skolko_dobiratsya: '6 мин. пешком',
    },
  ]);
});

test('mapWordPressSource maps commercial profile without importing PDFs', () => {
  const mapped = mapWordPressSource(
    makeSource(),
    'commercials',
    true,
    undefined,
    commercialWordPressImportProfile,
  );
  const [object] = mapped.objects;

  assert.equal(mapped.summary.profile, 'commercial');
  assert.equal(mapped.summary.objectType, RealEstateObjectType.COMMERCIAL);
  assert.equal(mapped.summary.postType, 'commercials');
  assert.equal(mapped.summary.validImagesMapped, 2);
  assert.equal(mapped.summary.validFilesMapped, 0);
  assert.equal(object.type, RealEstateObjectType.COMMERCIAL);
  assert.deepEqual(object.files, []);
  assert.equal(object.featuresJson.wp.importProfile, 'commercial');
  assert.equal(object.featuresJson.wp.postType, 'commercials');
  assert.equal(object.featuresJson.wp.sourceUrl, 'https://example.test/commercial/zhk-severnyy/');
  assert.equal(mapped.warnings.some((warning) => warning.code === 'missing_local_file'), false);
});

test('mapWordPressSource ignores WordPress short description meta when description content is empty', () => {
  const source = makeSource({
    objects: [
      makePost({
        ID: 101,
        post_title: 'ЖК Северный',
        post_name: 'zhk-severnyy',
        post_content: '',
      }),
    ],
    metaByPostId: new Map([
      [
        101,
        makeMeta({
          korotkoe_opisanie: '<p>Короткое описание</p>',
        }),
      ],
    ]),
  });

  const mapped = mapWordPressSource(source, 'nedvizhimost', true);
  const [object] = mapped.objects;

  assert.equal(object.description, null);
  assert.equal(object.shortDescription, null);
});

test('mapWordPressSource falls back to post content without merging extra content sections', () => {
  const source = makeSource({
    metaByPostId: new Map([
      [
        101,
        makeMeta({
          korotkoe_opisanie: '<p>Короткое описание</p>',
          opisanie_3: '<p>Архитектура объекта</p>',
          opisanie_4_1: '<p>Инфраструктура объекта</p>',
          opisanie_4_2: '<p>Наполнение объекта</p>',
          opisanie_5: '<p>Расположение объекта</p>',
        }),
      ],
    ]),
  });

  const mapped = mapWordPressSource(source, 'nedvizhimost', true);
  const [object] = mapped.objects;

  assert.equal(object.description, 'Описание из WordPress');
  assert.equal(object.architectureDescription, 'Архитектура объекта');
  assert.equal(object.infrastructureDescription, 'Инфраструктура объекта');
  assert.equal(object.fillingDescription, 'Наполнение объекта');
  assert.equal(object.description.includes('Архитектура объекта'), false);
  assert.equal(object.description.includes('Короткое описание'), false);
});

test('mapWordPressSource falls back to AREA as primary location when district is missing', () => {
  const terms = [
    { term_id: 3, name: 'Район около', slug: 'rajon-okolo', taxonomy: 'category', parent: 0 },
    { term_id: 4, name: 'У парка', slug: 'u-parka', taxonomy: 'category', parent: 3 },
  ];
  const source = makeSource({
    termsByObjectId: new Map([
      [
        101,
        [4].map((termId) => ({
          ...terms.find((term) => term.term_id === termId),
          object_id: 101,
        })),
      ],
    ]),
    termsById: new Map(terms.map((term) => [term.term_id, term])),
  });

  const mapped = mapWordPressSource(source, 'nedvizhimost', true);
  const [object] = mapped.objects;

  assert.equal(mapped.summary.locationsMapped, 1);
  assert.equal(object.primaryLocation.type, LocationType.AREA);
  assert.equal(object.primaryLocation.name, 'У парка');
});

test('mapWordPressSource prefers the last mapped district when multiple rajony terms exist', () => {
  const terms = [
    { term_id: 9, name: 'Районы', slug: 'rajony', taxonomy: 'category', parent: 0 },
    { term_id: 69, name: 'З', slug: 'z', taxonomy: 'category', parent: 9 },
    { term_id: 70, name: 'Запад', slug: 'zapad', taxonomy: 'category', parent: 69 },
    { term_id: 389, name: 'О', slug: 'o', taxonomy: 'category', parent: 9 },
    { term_id: 390, name: 'Очаково-Матвеевское', slug: 'ochakovo-matveevskoe', taxonomy: 'category', parent: 389 },
  ];
  const source = makeSource({
    termsByObjectId: new Map([
      [
        101,
        [70, 390].map((termId) => ({
          ...terms.find((term) => term.term_id === termId),
          object_id: 101,
        })),
      ],
    ]),
    termsById: new Map(terms.map((term) => [term.term_id, term])),
  });

  const mapped = mapWordPressSource(source, 'nedvizhimost', true);
  const [object] = mapped.objects;

  assert.equal(object.primaryLocation.type, LocationType.DISTRICT);
  assert.equal(object.primaryLocation.name, 'Очаково-Матвеевское');
});

test('mapWordPressSource maps Palashevsky-like terms with district as primary location', () => {
  const terms = [
    { term_id: 6, name: 'Район около', slug: 'rajon-okolo', taxonomy: 'category', parent: 0 },
    { term_id: 9, name: 'Районы', slug: 'rajony', taxonomy: 'category', parent: 0 },
    { term_id: 19, name: 'На Патриарших', slug: 'na-patriarshih', taxonomy: 'category', parent: 6 },
    { term_id: 1238, name: 'Т', slug: 't', taxonomy: 'category', parent: 9 },
    { term_id: 1242, name: 'Тверской', slug: 'tverskoj', taxonomy: 'category', parent: 1238 },
    { term_id: 1747, name: 'Центр', slug: 'czentr', taxonomy: 'category', parent: 6 },
  ];
  const source = makeSource({
    objects: [
      makePost({
        ID: 41747,
        post_title: 'Дом «Палашёвский 11»',
        post_name: 'dom-palashyovskij-11',
      }),
    ],
    metaByPostId: new Map([
      [
        41747,
        makeMeta({
          zagolovok_1: 'Дом «Палашёвский 11»',
          imya_zastrojshhika: 'Sminex',
        }),
      ],
    ]),
    termsByObjectId: new Map([
      [
        41747,
        [19, 1747, 1242].map((termId) => ({
          ...terms.find((term) => term.term_id === termId),
          object_id: 41747,
        })),
      ],
    ]),
    termsById: new Map(terms.map((term) => [term.term_id, term])),
    attachmentsById: new Map(),
    referencedAttachmentIds: new Set(),
  });

  const mapped = mapWordPressSource(source, 'nedvizhimost', true);
  const [object] = mapped.objects;
  const areaNames = object.locations
    .filter((location) => location.type === LocationType.AREA)
    .map((location) => location.name)
    .sort();

  assert.equal(object.primaryLocation.type, LocationType.DISTRICT);
  assert.equal(object.primaryLocation.name, 'Тверской');
  assert.deepEqual(areaNames, ['На Патриарших', 'Центр']);
});

test('mapWordPressSource reports potential developer duplicates without aliases', () => {
  const mapped = mapWordPressSource(makeDeveloperDuplicateSource(), 'nedvizhimost', true);
  const developerNames = mapped.objects.map((object) => object.developer?.name);

  assert.deepEqual(developerNames, ['Coldy', 'COLDY']);
  assert.equal(mapped.summary.developersMapped, 2);
  assert.equal(
    mapped.warnings.some(
      (warning) => warning.code === 'possible_developer_duplicate' && warning.message.includes('Coldy, COLDY'),
    ),
    true,
  );
});

test('mapWordPressSource applies explicit developer aliases only', () => {
  const aliases = createDeveloperAliases({
    groups: [
      {
        canonicalName: 'Coldy',
        aliases: ['COLDY'],
      },
    ],
  });
  const mapped = mapWordPressSource(makeDeveloperDuplicateSource(), 'nedvizhimost', true, aliases);
  const developerNames = mapped.objects.map((object) => object.developer?.name);

  assert.deepEqual(developerNames, ['Coldy', 'Coldy']);
  assert.equal(mapped.summary.developersMapped, 1);
  assert.equal(
    mapped.warnings.some((warning) => warning.code === 'possible_developer_duplicate'),
    false,
  );
});

test('default developer aliases merge MR Office into MR Group', async () => {
  const aliases = await loadDeveloperAliases();

  assert.equal(resolveDeveloperName('MR Office', aliases), 'MR Group');
});

test('mapWordPressSource reports missing optional data without failing the import', () => {
  const source = makeSource({
    objects: [makePost({ ID: 102, post_title: null, post_name: null, post_status: 'draft' })],
    metaByPostId: new Map([[102, makeMeta({ izobrazhenie_miniatyura: '999' })]]),
    termsByObjectId: new Map([[102, []]]),
    attachmentsById: new Map(),
    referencedAttachmentIds: new Set([999]),
  });

  const mapped = mapWordPressSource(source, 'nedvizhimost', false);
  const [object] = mapped.objects;

  assert.equal(object.title, 'WordPress object 102');
  assert.equal(object.slug, 'wordpress-object-102-102');
  assert.equal(object.status, ObjectStatus.DRAFT);
  assert.equal(object.developer, null);
  assert.equal(object.latitude, null);
  assert.equal(object.longitude, null);
  assert.deepEqual(
    mapped.warnings.map((warning) => warning.code).sort(),
    ['missing_attachment', 'missing_coordinates', 'missing_developer'].sort(),
  );
  assert.equal(mapped.errors.length, 0);
});

test('slugify transliterates Russian titles and falls back to item', () => {
  assert.equal(slugify('ЖК Южный Берег!'), 'zhk-yuzhnyy-bereg');
  assert.equal(slugify('!!!'), 'item');
});
