const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');

const {
  executeFeedImport,
  parseFeedAnalyzeCliArgs,
  parseFeedImportCliArgs,
} = require('../dist/index.js');

const fixedDate = new Date('2026-05-23T10:00:00.000Z');

function makeYandexFeed({ secondMediaUrl = 'https://cdn.test/b.png' } = {}) {
  return `<?xml version="1.0"?>
    <realty-feed>
      <offer internal-id="unit-1">
        <type>продажа</type>
        <property-type>жилая</property-type>
        <category>квартира</category>
        <location><address>Москва</address><apartment>11</apartment></location>
        <price><value>10000000</value><currency>RUR</currency></price>
        <area><value>50</value></area>
        <floor>7</floor>
        <rooms>2</rooms>
        <built-year>2028</built-year>
        <ready-quarter>4</ready-quarter>
        <image tag="plan">https://cdn.test/a.png</image>
      </offer>
      <offer internal-id="unit-2">
        <type>продажа</type>
        <property-type>жилая</property-type>
        <category>квартира</category>
        <location><address>Москва</address><apartment>12</apartment></location>
        <price><value>12000000</value><currency>RUR</currency></price>
        <area><value>60</value></area>
        <floor>9</floor>
        <rooms>3</rooms>
        <built-year>2027</built-year>
        <ready-quarter>2</ready-quarter>
        <image>${secondMediaUrl}</image>
        <image>${secondMediaUrl}</image>
      </offer>
    </realty-feed>`;
}

function makeYandexDiscountFeed() {
  return `<?xml version="1.0"?>
    <realty-feed>
      <offer internal-id="discount-1">
        <type>продажа</type>
        <property-type>жилая</property-type>
        <category>квартира</category>
        <location><address>Москва</address></location>
        <building-name>ЖК Скидочный</building-name>
        <price><value>10000000</value><currency>RUR</currency></price>
        <discount><final-price>8000000</final-price></discount>
        <area><value>40</value></area>
        <floor>7</floor>
        <rooms>2</rooms>
        <built-year>2028</built-year>
        <ready-quarter>4</ready-quarter>
        <flat-number>42</flat-number>
      </offer>
      <offer internal-id="base-1">
        <type>продажа</type>
        <property-type>жилая</property-type>
        <category>квартира</category>
        <location><address>Москва</address></location>
        <building-name>ЖК Скидочный</building-name>
        <price><value>9000000</value><currency>RUR</currency></price>
        <area><value>45</value></area>
        <floor>8</floor>
        <rooms>2</rooms>
        <built-year>2028</built-year>
        <ready-quarter>4</ready-quarter>
        <flat-number>43</flat-number>
      </offer>
    </realty-feed>`;
}

function makeMultiBuildingYandexFeed() {
  return `<?xml version="1.0"?>
    <realty-feed>
      <offer internal-id="nagatino-1">
        <type>продажа</type>
        <property-type>жилая</property-type>
        <category>квартира</category>
        <Address>Москва, ЮАО, Даниловский, пр-кт Андропова</Address>
        <price><value>10000000</value><currency>RUB</currency></price>
        <area><value>25.3</value></area>
        <floor>29</floor>
        <studio>true</studio>
        <building-name>Нагатино Ай-Лэнд</building-name>
        <yandex-building-id>2133018</yandex-building-id>
        <yandex-house-id>2923598</yandex-house-id>
      </offer>
      <offer internal-id="shagal-1">
        <type>продажа</type>
        <property-type>жилая</property-type>
        <category>квартира</category>
        <Address>г. Москва, ЮАО, ул. Автозаводская, вл. 23</Address>
        <price><value>12000000</value><currency>RUB</currency></price>
        <area><value>40.1</value></area>
        <floor>7</floor>
        <rooms>2</rooms>
        <building-name>Шагал</building-name>
        <yandex-building-id>2577904</yandex-building-id>
        <yandex-house-id>3401695</yandex-house-id>
      </offer>
    </realty-feed>`;
}

function makeMultiProjectCianFeed() {
  return `<?xml version="1.0"?>
    <feed>
      <object>
        <ExternalId>shagal-1</ExternalId>
        <title>Квартира №659</title>
        <Category>flatSale</Category>
        <Address>г. Москва, ЮАО, ул. Автозаводская, вл. 23/75</Address>
        <FloorNumber>12</FloorNumber>
        <FlatRoomsCount>9</FlatRoomsCount>
        <TotalArea>31.4</TotalArea>
        <BargainTerms><Price>15000000</Price><Currency>RUR</Currency></BargainTerms>
        <JKSchema><Name>Шагал</Name><House><Name>Корпус 8</Name></House></JKSchema>
      </object>
      <object>
        <ExternalId>nagatino-1</ExternalId>
        <title>Квартира №1017</title>
        <Category>flatSale</Category>
        <Address>Москва, ЮАО, Даниловский, пр-кт Андропова</Address>
        <FloorNumber>29</FloorNumber>
        <FlatRoomsCount>1</FlatRoomsCount>
        <TotalArea>25.3</TotalArea>
        <BargainTerms><Price>17597954</Price><Currency>RUR</Currency></BargainTerms>
        <JKSchema><Name>Нагатино Ай-Лэнд</Name><House><Name>Корпус 1</Name></House></JKSchema>
      </object>
    </feed>`;
}

function makeIndexCianFeed(externalId, projectName = 'Муза') {
  return `<?xml version="1.0"?>
    <feed>
      <object>
        <ExternalId>${externalId}</ExternalId>
        <title>Квартира ${externalId}</title>
        <Category>flatSale</Category>
        <Address>Красноармейская, вл. 11</Address>
        <TotalArea>45</TotalArea>
        <BargainTerms><Price>12000000</Price><Currency>RUR</Currency></BargainTerms>
        <Developer><Name>Смайнекс</Name></Developer>
        <JKSchema><Name>${projectName}</Name><House><Name>Корпус 1</Name></House></JKSchema>
      </object>
    </feed>`;
}

function makeSminexIndexYandexFeed() {
  return `<?xml version="1.0"?>
    <realty-feed>
      <offer internal-id="000110621">
        <type>Продажа</type>
        <property-type>Жилая</property-type>
        <category>Квартира</category>
        <location>
          <address>г. Москва, пер. Большой Палашёвский, д. 11</address>
          <apartment>18</apartment>
        </location>
        <price><value>264130000</value><currency>RUR</currency></price>
        <area><value>72.4</value><unit>кв. м</unit></area>
        <rooms>1</rooms>
        <floor>6</floor>
        <built-year>2030</built-year>
        <ready-quarter>1</ready-quarter>
        <building-name>Палашёвский 11</building-name>
        <building-section>11</building-section>
        <image tag="plan">https://cdn.test/yandex-plan.jpg</image>
      </offer>
    </realty-feed>`;
}

function makeSminexIndexCianFeed() {
  return `<?xml version="1.0"?>
    <feed>
      <object>
        <ExternalId>000110621</ExternalId>
        <Address>г. Москва, пер. Большой Палашёвский, д. 11</Address>
        <Developer><Name>Sminex</Name></Developer>
        <Booking><Status>free</Status></Booking>
        <Category>newBuildingFlatSale</Category>
        <FlatRoomsCount>1</FlatRoomsCount>
        <TotalArea>72.4</TotalArea>
        <FloorNumber>6</FloorNumber>
        <JKSchema>
          <Name>Палашёвский 11</Name>
          <House>
            <Name>-</Name>
            <Flat>
              <FlatNumber>18</FlatNumber>
              <SectionNumber>1</SectionNumber>
            </Flat>
          </House>
        </JKSchema>
        <Building>
          <Deadline><Quarter>first</Quarter><Year>2030</Year></Deadline>
        </Building>
        <BargainTerms><Price>264130000</Price><Currency>RUR</Currency></BargainTerms>
        <LayoutPhoto>
          <FullUrl>https://cdn.test/cian-plan.jpg</FullUrl>
          <IsDefault>true</IsDefault>
        </LayoutPhoto>
      </object>
    </feed>`;
}

function makeMrGroupCianFeed() {
  return `<?xml version="1.0"?>
    <Feed>
      <Object>
        <Category>newBuildingFlatSale</Category>
        <ExternalId>9a9d0581-87a1-ed11-be7d-00155dfc99c4</ExternalId>
        <Address>город Москва, Волоколамское шоссе, дом 97</Address>
        <RoomType>separate</RoomType>
        <FlatRoomsCount>2</FlatRoomsCount>
        <TotalArea>52.54</TotalArea>
        <FloorNumber>12</FloorNumber>
        <JKSchema>
          <Name>City Bay</Name>
          <House>
            <Name>City Bay 2 корпус 3</Name>
            <Flat>
              <FlatNumber>89</FlatNumber>
              <SectionNumber>1</SectionNumber>
            </Flat>
          </House>
        </JKSchema>
        <BargainTerms><Price>23995737.80</Price><Currency>rur</Currency></BargainTerms>
      </Object>
    </Feed>`;
}

function makeMangazeyaCianFeed() {
  return `<?xml version="1.0"?>
    <feed>
      <object>
        <Category>newBuildingFlatSale</Category>
        <ExternalId>1323ff84-468e-46bd-bceb-a24573e4d766</ExternalId>
        <Address>Москва, Большая Тульская улица д. 8</Address>
        <Title>Квартиры в премиальной доминанте</Title>
        <FlatRoomsCount>2</FlatRoomsCount>
        <TotalArea>69.50</TotalArea>
        <FloorNumber>18</FloorNumber>
        <JKSchema>
          <Name>Аура</Name>
          <House>
            <Flat>
              <FlatNumber>611</FlatNumber>
            </Flat>
          </House>
        </JKSchema>
        <BargainTerms><Price>49775900</Price><Currency>rur</Currency></BargainTerms>
      </object>
    </feed>`;
}

function makePioneerCianFeed() {
  return `<?xml version="1.0"?>
    <feed>
      <object>
        <Category>newBuildingFlatSale</Category>
        <ExternalId>1-1-2-2</ExternalId>
        <Address>Москва, Дербеневская улица</Address>
        <FlatRoomsCount>1</FlatRoomsCount>
        <TotalArea>32.22</TotalArea>
        <FloorNumber>2</FloorNumber>
        <JKSchema>
          <Name>Премиум-квартал SHIFT</Name>
          <House>
            <Name>Корпус 1</Name>
            <Flat><SectionNumber>1</SectionNumber></Flat>
          </House>
        </JKSchema>
        <Apartment>КВ-1/002</Apartment>
        <BargainTerms><Price>24000000</Price><Currency>rur</Currency></BargainTerms>
      </object>
    </feed>`;
}

function makeFskFeed() {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <Data>
      <FlatTypes>
        <FlatType ID="0" Name="Квартира"/>
        <FlatType ID="7" Name="Студия"/>
      </FlatTypes>
      <Regions>
        <Region Region_name="Москва и МО">
          <Object Complex_name="Режиссер" Complex_id="67" ID1C="00320" Ready="true">
            <Info>
              <Complex_address>г. Москва, ул. Вильгельма Пика, д. 1</Complex_address>
            </Info>
            <Buildings>
              <Corpus Num="3" Corpus_Delivery="2024-08-30">
                <Section Num="5" Floor_Count="38">
                  <Floor Num="3">
                    <Flat Id="61c97b374e2acff6814913c2" Id1C="141281" Type="0" Number="656" Floor="3" Rooms="2" Price_tot_sale="48979840" Square_tot="83.2"/>
                  </Floor>
                </Section>
              </Corpus>
            </Buildings>
          </Object>
        </Region>
      </Regions>
    </Data>`;
}

function makeMultiDevelopmentAvitoFeed() {
  return `<?xml version="1.0" encoding="utf-8"?>
    <Ads target="Avito.ru" formatVersion="3">
      <Ad>
        <Id>bg-1</Id>
        <Address>Челобитьево, корпус 12.1</Address>
        <Price>6520000</Price>
        <Category>Квартиры</Category>
        <NewDevelopmentId>8605163</NewDevelopmentId>
        <Square>24.7</Square>
        <Rooms>Студия</Rooms>
        <Floor>2</Floor>
      </Ad>
      <Ad>
        <Id>bg-2</Id>
        <Address>Челобитьево, корпус 11.1</Address>
        <Price>7000000</Price>
        <Category>Квартиры</Category>
        <NewDevelopmentId>8605163</NewDevelopmentId>
        <Square>30</Square>
        <Rooms>1</Rooms>
        <Floor>3</Floor>
      </Ad>
      <Ad>
        <Id>other-1</Id>
        <Address>Москва, другой корпус</Address>
        <Price>9000000</Price>
        <Category>Квартиры</Category>
        <NewDevelopmentId>1234567</NewDevelopmentId>
        <Square>45</Square>
        <Rooms>2</Rooms>
        <Floor>5</Floor>
      </Ad>
    </Ads>`;
}

test('parseFeedImportCliArgs accepts preview/run with source id', () => {
  assert.deepEqual(parseFeedImportCliArgs(['preview', '--source', 'source-1']), {
    command: 'preview',
    sourceId: 'source-1',
    runId: null,
  });
  assert.deepEqual(parseFeedImportCliArgs(['run', '--source=source-1']), {
    command: 'run',
    sourceId: 'source-1',
    runId: null,
  });
  assert.deepEqual(parseFeedImportCliArgs(['run', '--source=source-1', '--run-id=run-1']), {
    command: 'run',
    sourceId: 'source-1',
    runId: 'run-1',
  });
  assert.equal(parseFeedImportCliArgs(['preview']), null);
  assert.equal(parseFeedImportCliArgs(['bad', '--source', 'source-1']), null);
});

test('parseFeedAnalyzeCliArgs accepts pnpm argument separator', () => {
  assert.deepEqual(
    parseFeedAnalyzeCliArgs([
      'analyze',
      '--',
      '--format',
      'YANDEX_REALTY',
      '--file',
      '/tmp/feed.xml',
      '--output',
      '/tmp/analysis.json',
    ]),
    {
      command: 'analyze',
      format: 'YANDEX_REALTY',
      sourceKind: 'FILE',
      url: null,
      filePath: '/tmp/feed.xml',
      outputPath: '/tmp/analysis.json',
    },
  );
});

test('parseFeedAnalyzeCliArgs accepts auto format for index URLs', () => {
  assert.deepEqual(
    parseFeedAnalyzeCliArgs([
      'analyze',
      '--format=AUTO',
      '--source-kind=INDEX_URL',
      '--url',
      'https://feeds.test/xml/',
    ]),
    {
      command: 'analyze',
      format: 'AUTO',
      sourceKind: 'INDEX_URL',
      url: 'https://feeds.test/xml/',
      filePath: null,
      outputPath: null,
    },
  );
});

test('executeFeedImport preview counts changes without writing feed units or media', async () => {
  const { db, state } = createFakeDb({
    units: [
      makeUnit({ id: 'existing-1', externalId: 'unit-1', status: 'AVAILABLE' }),
      makeUnit({ id: 'stale-1', externalId: 'stale-1', status: 'AVAILABLE' }),
    ],
    mediaAssets: [
      {
        id: 'asset-a',
        sourceUrl: 'https://cdn.test/a.png',
        fileId: 'file-a',
        contentType: 'image/png',
        checksum: 'checksum-a',
      },
    ],
  });
  const unitSnapshot = JSON.stringify(state.units);

  const result = await executeFeedImport({
    mode: 'preview',
    sourceId: 'source-1',
    db,
    xmlFetcher: async () => makeYandexFeed(),
    now: () => fixedDate,
  });

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.summary.created, 1);
  assert.equal(result.summary.updated, 1);
  assert.equal(result.summary.archived, 1);
  assert.deepEqual(result.summary.media, {
    total: 2,
    unique: 2,
    existing: 1,
    created: 1,
    downloaded: 0,
    failed: 0,
    variantsCreated: 0,
  });
  assert.equal(JSON.stringify(state.units), unitSnapshot);
  assert.equal(state.unitMedia.length, 0);
  assert.equal(state.storagePuts.length, 0);
  assert.equal(state.object.feedUpdatedAt, null);
  assert.equal(state.runs[0].mode, 'PREVIEW');
  assert.equal(state.runs[0].status, 'SUCCESS');
  assert.deepEqual(state.source.lastPreviewAt, fixedDate);
  assert.equal(state.source.lastRunAt, null);
});

test('executeFeedImport applies Yandex source filter before planning changes', async () => {
  const { db } = createFakeDb({
    source: {
      filterJson: {
        buildingNames: ['Нагатино Ай-Лэнд'],
        yandexBuildingIds: ['2133018'],
      },
    },
  });

  const result = await executeFeedImport({
    mode: 'preview',
    sourceId: 'source-1',
    db,
    xmlFetcher: async () => makeMultiBuildingYandexFeed(),
    now: () => fixedDate,
  });

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.summary.unitsParsed, 1);
  assert.equal(result.summary.created, 1);
  assert.equal(result.summary.updated, 0);
  assert.equal(result.summary.archived, 0);
  assert.deepEqual(result.warnings, []);
});

test('executeFeedImport routes Yandex units through active source mappings', async () => {
  const { db, state } = createFakeDb({
    source: {
      objectId: null,
      mappings: [
        makeSourceMapping({
          id: 'mapping-nagatino',
          objectId: 'object-1',
          sourceKey: 'nagatino',
          sourceTitle: 'Нагатино Ай-Лэнд',
          filterJson: {
            buildingNames: ['Нагатино Ай-Лэнд'],
            yandexBuildingIds: ['2133018'],
          },
        }),
        makeSourceMapping({
          id: 'mapping-shagal',
          objectId: 'object-2',
          sourceKey: 'shagal',
          sourceTitle: 'Шагал',
          filterJson: {
            buildingNames: ['Шагал'],
            yandexBuildingIds: ['2577904'],
          },
        }),
      ],
    },
    objects: [
      makeObjectAggregate({ id: 'object-1' }),
      makeObjectAggregate({ id: 'object-2' }),
      makeObjectAggregate({
        id: 'object-3',
        feedUnitsCount: 1,
        feedUnitsCountText: '1 лот',
        feedUpdatedAt: new Date('2026-05-22T10:00:00.000Z'),
      }),
    ],
    units: [
      makeUnit({
        id: 'stale-removed-mapping',
        objectId: 'object-3',
        externalId: 'removed-mapping-1',
        status: 'AVAILABLE',
        price: '5000000.00',
        area: '20.00',
        floor: 3,
      }),
    ],
  });

  const result = await executeFeedImport({
    mode: 'run',
    sourceId: 'source-1',
    db,
    storage: state.storage,
    xmlFetcher: async () => makeMultiBuildingYandexFeed(),
    now: () => fixedDate,
  });

  const nagatinoUnit = state.units.find((unit) => unit.externalId === 'nagatino-1');
  const shagalUnit = state.units.find((unit) => unit.externalId === 'shagal-1');
  const staleUnit = state.units.find((unit) => unit.externalId === 'removed-mapping-1');

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.summary.unitsParsed, 2);
  assert.equal(nagatinoUnit.objectId, 'object-1');
  assert.equal(shagalUnit.objectId, 'object-2');
  assert.equal(staleUnit.status, 'ARCHIVED');
  assert.deepEqual(staleUnit.archivedAt, fixedDate);
  assert.equal(state.objects.get('object-1').feedUnitsCount, 1);
  assert.equal(state.objects.get('object-2').feedUnitsCount, 1);
  assert.equal(state.objects.get('object-3').feedUnitsCount, null);
  assert.deepEqual(state.refreshedObjectIds.sort(), ['object-1', 'object-2', 'object-3']);
});

test('executeFeedImport routes CIAN units through project name source mappings', async () => {
  const { db, state } = createFakeDb({
    source: {
      format: 'CIAN_XML',
      objectId: null,
      mappings: [
        makeSourceMapping({
          id: 'mapping-shagal',
          objectId: 'object-1',
          sourceKey: 'shagal',
          sourceTitle: 'Шагал',
          filterJson: {
            projectNames: ['Шагал'],
          },
        }),
        makeSourceMapping({
          id: 'mapping-nagatino',
          objectId: 'object-2',
          sourceKey: 'nagatino',
          sourceTitle: 'Нагатино Ай-Лэнд',
          filterJson: {
            projectNames: ['Нагатино Ай-Лэнд'],
          },
        }),
      ],
    },
    objects: [
      makeObjectAggregate({ id: 'object-1' }),
      makeObjectAggregate({ id: 'object-2' }),
    ],
  });

  const result = await executeFeedImport({
    mode: 'run',
    sourceId: 'source-1',
    db,
    storage: state.storage,
    xmlFetcher: async () => makeMultiProjectCianFeed(),
    now: () => fixedDate,
  });

  const shagalUnit = state.units.find((unit) => unit.externalId === 'shagal-1');
  const nagatinoUnit = state.units.find((unit) => unit.externalId === 'nagatino-1');

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.summary.unitsParsed, 2);
  assert.equal(shagalUnit.objectId, 'object-1');
  assert.equal(nagatinoUnit.objectId, 'object-2');
  assert.equal(state.objects.get('object-1').feedUnitsCount, 1);
  assert.equal(state.objects.get('object-2').feedUnitsCount, 1);
});

test('executeFeedImport imports selected platform files from index sources', async () => {
  const indexUrl = 'https://feeds.test/xml/';
  const { db, state } = createFakeDb({
    source: {
      sourceKind: 'INDEX_URL',
      url: indexUrl,
      format: 'CIAN_XML',
      objectId: null,
      mappings: [
        makeSourceMapping({
          id: 'mapping-muza',
          objectId: 'object-1',
          sourceKey: 'muza',
          sourceTitle: 'Муза',
          filterJson: {
            projectNames: ['Муза'],
          },
        }),
      ],
    },
  });
  const responses = new Map([
    [
      indexUrl,
      `<html><body>
        <a href="yandex.xml">Yandex</a>
        <a href="cian-a.xml">Cian A</a>
        <a href="cian-b.xml">Cian B</a>
      </body></html>`,
    ],
    ['https://feeds.test/xml/yandex.xml', makeMultiBuildingYandexFeed()],
    ['https://feeds.test/xml/cian-a.xml', makeIndexCianFeed('cian-1')],
    ['https://feeds.test/xml/cian-b.xml', makeIndexCianFeed('cian-2')],
  ]);

  const result = await executeFeedImport({
    mode: 'run',
    sourceId: 'source-1',
    db,
    storage: state.storage,
    xmlFetcher: async (url) => responses.get(url),
    now: () => fixedDate,
  });

  const importedUnits = state.units.filter((unit) => unit.rawPayload?.__feedIndexSourceUrl);

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.summary.unitsParsed, 2);
  assert.equal(importedUnits.length, 2);
  assert.deepEqual(
    importedUnits.map((unit) => unit.rawPayload.__rawExternalId).sort(),
    ['cian-1', 'cian-2'],
  );
  assert.equal(importedUnits.every((unit) => unit.externalId.endsWith(`:${unit.rawPayload.__rawExternalId}`)), true);
  assert.equal(importedUnits.every((unit) => unit.objectId === 'object-1'), true);
  assert.equal(state.units.some((unit) => unit.externalId === 'nagatino-1'), false);
});

test('executeFeedImport imports public Google Sheets index rows through source URL mappings', async () => {
  const sheetUrl = 'https://docs.google.com/spreadsheets/d/sheet-id/edit?gid=456#gid=456';
  const csvUrl = 'https://docs.google.com/spreadsheets/d/sheet-id/export?format=csv&gid=456';
  const cityzenUrl = 'https://feeds.test/cityzen.xml';
  const oneUrl = 'https://feeds.test/one.xml';
  const { db, state } = createFakeDb({
    source: {
      sourceKind: 'INDEX_URL',
      url: sheetUrl,
      format: 'CIAN_XML',
      objectId: null,
      mappings: [
        makeSourceMapping({
          id: 'mapping-cityzen',
          objectId: 'object-1',
          sourceKey: 'sheet-cityzen',
          sourceTitle: 'ЖК Ситидзен',
          filterJson: {
            feedIndexSourceUrls: [cityzenUrl],
          },
        }),
        makeSourceMapping({
          id: 'mapping-one',
          objectId: 'object-2',
          sourceKey: 'sheet-one',
          sourceTitle: 'ЖК Оне',
          filterJson: {
            feedIndexSourceUrls: [oneUrl],
          },
        }),
      ],
    },
    objects: [
      makeObjectAggregate({ id: 'object-1' }),
      makeObjectAggregate({ id: 'object-2' }),
    ],
  });
  const responses = new Map([
    [csvUrl, `ЖК,Фид\n"ЖК Ситидзен","${cityzenUrl}"\n"ЖК Оне","${oneUrl}"`],
    [cityzenUrl, makeIndexCianFeed('cityzen-1', 'Feed Cityzen')],
    [oneUrl, makeIndexCianFeed('one-1', 'Feed One')],
  ]);

  const result = await executeFeedImport({
    mode: 'run',
    sourceId: 'source-1',
    db,
    storage: state.storage,
    xmlFetcher: async (url) => responses.get(url),
    now: () => fixedDate,
  });

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.summary.unitsParsed, 2);
  assert.equal(state.units.find((unit) => unit.rawPayload.__rawExternalId === 'cityzen-1').objectId, 'object-1');
  assert.equal(state.units.find((unit) => unit.rawPayload.__rawExternalId === 'one-1').objectId, 'object-2');
});

test('executeFeedImport auto imports mixed index feed formats through source URL mappings', async () => {
  const indexUrl = 'https://feeds.test/xml/';
  const yandexUrl = 'https://feeds.test/xml/yandex.xml';
  const cianUrl = 'https://feeds.test/xml/cian.xml';
  const { db, state } = createFakeDb({
    source: {
      sourceKind: 'INDEX_URL',
      url: indexUrl,
      format: 'CIAN_XML',
      objectId: null,
      mappings: [
        makeSourceMapping({
          id: 'mapping-yandex',
          objectId: 'object-1',
          sourceKey: 'sheet-yandex',
          sourceTitle: 'ЖК Yandex',
          filterJson: {
            feedIndexSourceUrls: [yandexUrl],
          },
        }),
        makeSourceMapping({
          id: 'mapping-cian',
          objectId: 'object-2',
          sourceKey: 'sheet-cian',
          sourceTitle: 'ЖК Cian',
          filterJson: {
            feedIndexSourceUrls: [cianUrl],
          },
        }),
      ],
    },
    objects: [
      makeObjectAggregate({ id: 'object-1' }),
      makeObjectAggregate({ id: 'object-2' }),
    ],
  });
  const responses = new Map([
    [
      indexUrl,
      `<html><body>
        <a href="yandex.xml">Yandex</a>
        <a href="cian.xml">Cian</a>
      </body></html>`,
    ],
    [yandexUrl, makeYandexFeed()],
    [cianUrl, makeIndexCianFeed('cian-1', 'Feed Cian')],
  ]);

  const result = await executeFeedImport({
    mode: 'run',
    sourceId: 'source-1',
    db,
    storage: state.storage,
    xmlFetcher: async (url) => responses.get(url),
    mediaDownloader: async (url) => ({
      body: Buffer.from(`body:${url}`),
      contentType: 'image/png',
      originalName: 'feed.png',
    }),
    imageVariantGenerator: async () => [],
    now: () => fixedDate,
  });

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.summary.unitsParsed, 3);
  assert.equal(state.units.find((unit) => unit.rawPayload.__rawExternalId === 'unit-1').objectId, 'object-1');
  assert.equal(state.units.find((unit) => unit.rawPayload.__rawExternalId === 'unit-2').objectId, 'object-1');
  assert.equal(state.units.find((unit) => unit.rawPayload.__rawExternalId === 'cian-1').objectId, 'object-2');
});

test('executeFeedImport merges Sminex index duplicates by raw external id using CIAN as canonical unit', async () => {
  const indexUrl = 'https://feeds.sminex.com/xml/';
  const yandexUrl = 'https://feeds.sminex.com/xml/PLSH_YandexRealty_4194373_.xml';
  const cianUrl = 'https://feeds.sminex.com/xml/PLSH_Cian_5763981_.xml';
  const yandexExternalId = `${createIndexNamespace(yandexUrl)}:000110621`;
  const cianExternalId = `${createIndexNamespace(cianUrl)}:000110621`;
  const { db, state } = createFakeDb({
    source: {
      sourceKind: 'INDEX_URL',
      url: indexUrl,
      format: 'CIAN_XML',
      objectId: null,
      developer: {
        name: 'Sminex',
        normalizedName: 'sminex',
      },
      mappings: [
        makeSourceMapping({
          id: 'mapping-palashevsky',
          objectId: 'object-1',
          sourceKey: 'palashevsky',
          sourceTitle: 'Палашёвский 11',
          filterJson: {
            projectNames: ['Палашёвский 11'],
          },
        }),
      ],
    },
    units: [
      makeUnit({ id: 'existing-cian', externalId: cianExternalId, status: 'AVAILABLE' }),
      makeUnit({ id: 'existing-yandex', externalId: yandexExternalId, status: 'AVAILABLE' }),
    ],
  });
  const responses = new Map([
    [
      indexUrl,
      `<html><body>
        <a href="PLSH_YandexRealty_4194373_.xml">Yandex</a>
        <a href="PLSH_Cian_5763981_.xml">Cian</a>
      </body></html>`,
    ],
    [yandexUrl, makeSminexIndexYandexFeed()],
    [cianUrl, makeSminexIndexCianFeed()],
  ]);

  const result = await executeFeedImport({
    mode: 'run',
    sourceId: 'source-1',
    db,
    storage: state.storage,
    xmlFetcher: async (url) => responses.get(url),
    mediaDownloader: async (url) => ({
      body: Buffer.from(`body:${url}`),
      contentType: 'image/jpeg',
      originalName: 'plan.jpg',
    }),
    imageVariantGenerator: async () => [],
    now: () => fixedDate,
  });

  const cianUnit = state.units.find((unit) => unit.externalId === cianExternalId);
  const yandexUnit = state.units.find((unit) => unit.externalId === yandexExternalId);
  const linkedMediaUrls = state.unitMedia
    .filter((link) => link.unitId === cianUnit.id)
    .map((link) => state.mediaAssets.find((asset) => asset.id === link.mediaAssetId).sourceUrl)
    .sort();

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.summary.unitsParsed, 1);
  assert.equal(result.summary.updated, 1);
  assert.equal(result.summary.created, 0);
  assert.equal(result.summary.archived, 1);
  assert.equal(cianUnit.status, 'AVAILABLE');
  assert.equal(cianUnit.rawPayload.__feedDetectedFormat, 'CIAN_XML');
  assert.equal(cianUnit.rawPayload.__rawExternalId, '000110621');
  assert.equal(cianUnit.title, 'Квартира №18');
  assert.equal(cianUnit.building, 'Палашёвский 11');
  assert.equal(cianUnit.section, '1');
  assert.equal(state.residentialDetails.get(cianUnit.id).apartmentNumber, '18');
  assert.deepEqual(linkedMediaUrls, ['https://cdn.test/cian-plan.jpg', 'https://cdn.test/yandex-plan.jpg']);
  assert.equal(yandexUnit.status, 'ARCHIVED');
  assert.deepEqual(yandexUnit.archivedAt, fixedDate);
  assert.equal(state.object.feedUnitsCount, 1);
});

test('executeFeedImport routes Avito units through development id source mappings', async () => {
  const { db, state } = createFakeDb({
    source: {
      format: 'AVITO_XML',
      objectId: null,
      mappings: [
        makeSourceMapping({
          id: 'mapping-beliy-grad',
          objectId: 'object-1',
          sourceKey: 'avito-beliy-grad',
          sourceTitle: 'Avito ЖК 8605163',
          filterJson: {
            avitoDevelopmentIds: ['8605163'],
          },
        }),
        makeSourceMapping({
          id: 'mapping-other',
          objectId: 'object-2',
          sourceKey: 'avito-other',
          sourceTitle: 'Avito ЖК 1234567',
          filterJson: {
            avitoDevelopmentIds: ['1234567'],
          },
        }),
      ],
    },
    objects: [
      makeObjectAggregate({ id: 'object-1' }),
      makeObjectAggregate({ id: 'object-2' }),
    ],
  });

  const result = await executeFeedImport({
    mode: 'run',
    sourceId: 'source-1',
    db,
    storage: state.storage,
    xmlFetcher: async () => makeMultiDevelopmentAvitoFeed(),
    now: () => fixedDate,
  });

  const firstBeliyGradUnit = state.units.find((unit) => unit.externalId === 'bg-1');
  const secondBeliyGradUnit = state.units.find((unit) => unit.externalId === 'bg-2');
  const otherUnit = state.units.find((unit) => unit.externalId === 'other-1');

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.summary.unitsParsed, 3);
  assert.equal(firstBeliyGradUnit.objectId, 'object-1');
  assert.equal(secondBeliyGradUnit.objectId, 'object-1');
  assert.equal(otherUnit.objectId, 'object-2');
  assert.equal(firstBeliyGradUnit.rooms, 0);
  assert.equal(state.objects.get('object-1').feedUnitsCount, 2);
  assert.equal(state.objects.get('object-2').feedUnitsCount, 1);
});

test('executeFeedImport reads uploaded XML feed sources from storage', async () => {
  const { db, state } = createFakeDb({
    source: {
      sourceKind: 'FILE',
      url: null,
      xmlFileId: 'file-feed-1',
      xmlFile: {
        id: 'file-feed-1',
        key: 'uploads/2026/05/developer-feed.xml',
        url: 'https://minio.test/platforma/uploads/2026/05/developer-feed.xml',
        originalName: 'developer-feed.xml',
        mimeType: 'application/xml',
      },
    },
  });
  state.storageObjects.set('uploads/2026/05/developer-feed.xml', Buffer.from(makeYandexFeed()));

  const result = await executeFeedImport({
    mode: 'preview',
    sourceId: 'source-1',
    db,
    storage: state.storage,
    now: () => fixedDate,
  });

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.summary.created, 2);
  assert.equal(state.storageGets[0], 'uploads/2026/05/developer-feed.xml');
  assert.equal(state.runs[0].status, 'SUCCESS');
});

test('executeFeedImport rejects file feed sources without storage client', async () => {
  const { db } = createFakeDb({
    source: {
      sourceKind: 'FILE',
      url: null,
      xmlFileId: 'file-feed-1',
      xmlFile: {
        id: 'file-feed-1',
        key: 'uploads/2026/05/developer-feed.xml',
        originalName: 'developer-feed.xml',
        mimeType: 'application/xml',
      },
    },
  });

  await assert.rejects(
    () =>
      executeFeedImport({
        mode: 'preview',
        sourceId: 'source-1',
        db,
        now: () => fixedDate,
      }),
    /requires storage client/,
  );
});

test('executeFeedImport run upserts units, details, archives stale units and deduplicates media', async () => {
  const { db, state } = createFakeDb({
    units: [
      makeUnit({ id: 'existing-1', externalId: 'unit-1', status: 'AVAILABLE' }),
      makeUnit({ id: 'stale-1', externalId: 'stale-1', status: 'AVAILABLE' }),
    ],
    mediaAssets: [
      {
        id: 'asset-a',
        sourceUrl: 'https://cdn.test/a.png',
        fileId: 'file-a',
        contentType: 'image/png',
        checksum: 'checksum-a',
      },
    ],
  });

  const result = await executeFeedImport({
    mode: 'run',
    sourceId: 'source-1',
    db,
    storage: state.storage,
    xmlFetcher: async () => makeYandexFeed(),
    mediaDownloader: async (url) => ({
      body: Buffer.from(`body:${url}`),
      contentType: 'image/png',
      originalName: 'b.png',
    }),
    imageVariantGenerator: async (body, key) => [
      {
        variant: 'THUMBNAIL',
        key: `${key}.thumbnail.webp`,
        body,
        mimeType: 'image/webp',
        width: 10,
        height: 10,
        sizeBytes: BigInt(body.length),
        checksum: 'variant-checksum',
      },
    ],
    now: () => fixedDate,
  });

  const unit1 = state.units.find((unit) => unit.externalId === 'unit-1');
  const unit2 = state.units.find((unit) => unit.externalId === 'unit-2');
  const stale = state.units.find((unit) => unit.externalId === 'stale-1');

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.summary.created, 1);
  assert.equal(result.summary.updated, 1);
  assert.equal(result.summary.archived, 1);
  assert.equal(result.summary.media.existing, 1);
  assert.equal(result.summary.media.created, 1);
  assert.equal(result.summary.media.downloaded, 1);
  assert.equal(result.summary.media.variantsCreated, 1);
  assert.equal(unit1.price, '10000000.00');
  assert.equal(unit1.archivedAt, null);
  assert.equal(unit2.status, 'AVAILABLE');
  assert.equal(stale.status, 'ARCHIVED');
  assert.deepEqual(stale.archivedAt, fixedDate);
  assert.equal(state.residentialDetails.get(unit1.id).apartmentNumber, '11');
  assert.equal(state.residentialDetails.get(unit2.id).apartmentNumber, '12');
  assert.equal(state.mediaAssets.length, 2);
  assert.equal(state.files.length, 1);
  assert.equal(state.fileVariants.length, 1);
  assert.equal(state.unitMedia.length, 2);
  assert.deepEqual(state.source.lastRunAt, fixedDate);
  assert.deepEqual(state.source.lastSuccessAt, fixedDate);
});

test('executeFeedImport run persists discount prices and aggregates by effective price', async () => {
  const { db, state } = createFakeDb();

  await executeFeedImport({
    mode: 'run',
    sourceId: 'source-1',
    db,
    storage: state.storage,
    xmlFetcher: async () => makeYandexDiscountFeed(),
    mediaDownloader: async () => {
      throw new Error('media should not be downloaded in this test');
    },
    imageVariantGenerator: async () => [],
    now: () => fixedDate,
  });

  const discountedUnit = state.units.find((unit) => unit.externalId === 'discount-1');
  const baseUnit = state.units.find((unit) => unit.externalId === 'base-1');

  assert.equal(discountedUnit.title, 'ЖК Скидочный, квартира, № 42');
  assert.equal(discountedUnit.price, '10000000.00');
  assert.equal(discountedUnit.discountPrice, '8000000.00');
  assert.equal(discountedUnit.effectivePrice, '8000000.00');
  assert.equal(discountedUnit.pricePerMeter, '250000.00');
  assert.equal(discountedUnit.discountPricePerMeter, '200000.00');
  assert.equal(discountedUnit.effectivePricePerMeter, '200000.00');
  assert.equal(baseUnit.discountPrice, null);
  assert.equal(baseUnit.effectivePrice, '9000000.00');
  assert.equal(state.residentialDetails.get(discountedUnit.id).apartmentNumber, '42');
  assert.equal(state.object.feedPriceFrom, '8000000.00');
  assert.equal(state.object.feedPricePerMeterFrom, '200000.00');
});

test('executeFeedImport run titles MR Group CIAN residential units by apartment number', async () => {
  const { db, state } = createFakeDb({
    source: {
      format: 'CIAN_XML',
      url: 'https://crm-api.mr-group.ru/feed/api/v1/cianfeed/get/1f7aca01-a18f-ea11-bdf5-00155dfc99c4',
      developer: {
        name: 'MR Group',
        normalizedName: 'mr-group',
      },
    },
  });

  await executeFeedImport({
    mode: 'run',
    sourceId: 'source-1',
    db,
    storage: state.storage,
    xmlFetcher: async () => makeMrGroupCianFeed(),
    mediaDownloader: async () => {
      throw new Error('media should not be downloaded in this test');
    },
    imageVariantGenerator: async () => [],
    now: () => fixedDate,
  });

  const unit = state.units.find((currentUnit) => currentUnit.externalId === '9a9d0581-87a1-ed11-be7d-00155dfc99c4');

  assert.equal(unit.title, 'Квартира №89');
  assert.equal(unit.address, 'город Москва, Волоколамское шоссе, дом 97');
  assert.equal(state.residentialDetails.get(unit.id).apartmentNumber, '89');
});

test('executeFeedImport run titles Mangazeya CIAN residential units by apartment number', async () => {
  const { db, state } = createFakeDb({
    source: {
      format: 'CIAN_XML',
      url: 'https://newfeed.6feeds.ru/feeds/static/aura/cian',
      developer: {
        name: 'Мангазея',
        normalizedName: 'mangazeya',
      },
    },
  });

  await executeFeedImport({
    mode: 'run',
    sourceId: 'source-1',
    db,
    storage: state.storage,
    xmlFetcher: async () => makeMangazeyaCianFeed(),
    mediaDownloader: async () => {
      throw new Error('media should not be downloaded in this test');
    },
    imageVariantGenerator: async () => [],
    now: () => fixedDate,
  });

  const unit = state.units.find((currentUnit) => currentUnit.externalId === '1323ff84-468e-46bd-bceb-a24573e4d766');

  assert.equal(unit.title, 'Квартира №611');
  assert.equal(unit.address, 'Москва, Большая Тульская улица д. 8');
  assert.equal(state.residentialDetails.get(unit.id).apartmentNumber, '611');
});

test('executeFeedImport run titles Pioneer CIAN residential units by apartment number', async () => {
  const { db, state } = createFakeDb({
    source: {
      format: 'CIAN_XML',
      url: 'https://shift-home.ru/api/apart_manager/get_feed/living/Cian/2',
      developer: {
        name: 'Пионер',
        normalizedName: 'pioner',
      },
    },
  });

  await executeFeedImport({
    mode: 'run',
    sourceId: 'source-1',
    db,
    storage: state.storage,
    xmlFetcher: async () => makePioneerCianFeed(),
    mediaDownloader: async () => {
      throw new Error('media should not be downloaded in this test');
    },
    imageVariantGenerator: async () => [],
    now: () => fixedDate,
  });

  const unit = state.units.find((currentUnit) => currentUnit.externalId === '1-1-2-2');

  assert.equal(unit.title, 'Квартира №КВ-1/002');
  assert.equal(unit.address, 'Москва, Дербеневская улица');
  assert.equal(state.residentialDetails.get(unit.id).apartmentNumber, 'КВ-1/002');
});

test('executeFeedImport run titles FSK residential units by apartment number', async () => {
  const { db, state } = createFakeDb({
    source: {
      format: 'FSK_XML',
      url: 'https://export.fsk.ru/production/v3/fsk_sale.xml',
      developer: {
        name: 'ФСК',
        normalizedName: 'fsk',
      },
    },
  });

  await executeFeedImport({
    mode: 'run',
    sourceId: 'source-1',
    db,
    storage: state.storage,
    xmlFetcher: async () => makeFskFeed(),
    mediaDownloader: async () => {
      throw new Error('media should not be downloaded in this test');
    },
    imageVariantGenerator: async () => [],
    now: () => fixedDate,
  });

  const unit = state.units.find((currentUnit) => currentUnit.externalId === '141281');

  assert.equal(unit.title, 'Квартира №656');
  assert.equal(unit.address, 'г. Москва, ул. Вильгельма Пика, д. 1');
  assert.equal(state.residentialDetails.get(unit.id).apartmentNumber, '656');
});

test('executeFeedImport run writes pending progress while processing units', async () => {
  const { db, state } = createFakeDb();

  const result = await executeFeedImport({
    mode: 'run',
    sourceId: 'source-1',
    db,
    storage: state.storage,
    xmlFetcher: async () => makeYandexFeed(),
    mediaDownloader: async (url) => ({
      body: Buffer.from(`body:${url}`),
      contentType: 'image/png',
      originalName: 'image.png',
    }),
    imageVariantGenerator: async () => [],
    now: () => fixedDate,
  });

  const progressUpdates = state.runUpdates
    .map((update) => update.summaryJson?.progress)
    .filter(Boolean);

  assert.ok(progressUpdates.length >= 3);
  assert.deepEqual(progressUpdates[0], {
    stage: 'PROCESSING_UNITS',
    unitsTotal: 2,
    unitsProcessed: 0,
    unitsRemaining: 2,
    mediaTotal: 2,
    mediaProcessed: 0,
    mediaRemaining: 2,
    updatedAt: fixedDate.toISOString(),
  });
  assert.equal(progressUpdates.some((progress) => progress.unitsProcessed === 1 && progress.unitsRemaining === 1), true);
  assert.equal(progressUpdates.some((progress) => progress.stage === 'REFRESHING_OBJECT'), true);
  assert.equal(result.summary.progress.stage, 'COMPLETED');
  assert.equal(result.summary.progress.unitsProcessed, 2);
  assert.equal(result.summary.progress.unitsRemaining, 0);
  assert.equal(result.summary.progress.mediaProcessed, 2);
  assert.equal(result.summary.progress.mediaRemaining, 0);
});

test('executeFeedImport run recalculates object feed aggregates from active units', async () => {
  const { db, state } = createFakeDb({
    units: [
      makeUnit({ id: 'existing-1', externalId: 'unit-1', status: 'AVAILABLE' }),
      makeUnit({ id: 'booked-1', sourceId: 'source-2', externalId: 'booked-1', status: 'BOOKED', price: '9000000.00', pricePerMeter: '150000.00', area: '30.00', floor: 2, completionYear: 2026, completionQuarter: 3 }),
      makeUnit({ id: 'reserved-1', sourceId: 'source-2', externalId: 'reserved-1', status: 'RESERVED', price: null, pricePerMeter: null, area: null, floor: null, completionYear: null, completionQuarter: null }),
      makeUnit({ id: 'sold-1', sourceId: 'source-2', externalId: 'sold-1', status: 'SOLD', price: '1000.00', pricePerMeter: '1.00', area: '1.00', floor: 1, completionYear: 2025, completionQuarter: 1 }),
      makeUnit({ id: 'other-object-1', sourceId: 'source-3', objectId: 'object-2', externalId: 'other-object-1', status: 'AVAILABLE', price: '500.00', pricePerMeter: '1.00', area: '1.00', floor: 1, completionYear: 2025, completionQuarter: 1 }),
    ],
  });

  await executeFeedImport({
    mode: 'run',
    sourceId: 'source-1',
    db,
    storage: state.storage,
    xmlFetcher: async () => makeYandexFeed(),
    mediaDownloader: async (url) => ({
      body: Buffer.from(`body:${url}`),
      contentType: 'image/png',
      originalName: 'image.png',
    }),
    imageVariantGenerator: async () => [],
    now: () => fixedDate,
  });

  assert.deepEqual(
    state.feedUnitFindManyCalls.find((where) => where.objectId === 'object-1')?.source,
    { deletedAt: null },
  );
  assert.deepEqual(state.object, {
    id: 'object-1',
    feedPriceFrom: '9000000.00',
    feedPricePerMeterFrom: '150000.00',
    feedAreaRange: '30-60 м²',
    feedFloorRange: '2-9 этажей',
    feedUnitsCount: 4,
    feedUnitsCountText: '4 лота',
    feedCompletionYear: 2026,
    feedCompletionQuarter: 3,
    feedUpdatedAt: fixedDate,
  });
});

test('executeFeedImport run clears object feed aggregates when no active units remain', async () => {
  const { db, state } = createFakeDb({
    source: {
      format: 'CIAN_XML',
    },
    object: {
      feedPriceFrom: '7000000.00',
      feedPricePerMeterFrom: '200000.00',
      feedAreaRange: '35-60 м²',
      feedFloorRange: '4-12 этажей',
      feedUnitsCount: 2,
      feedUnitsCountText: '2 лота',
      feedCompletionYear: 2027,
      feedCompletionQuarter: 4,
      feedUpdatedAt: new Date('2026-05-22T10:00:00.000Z'),
    },
    units: [
      makeUnit({ id: 'existing-1', externalId: 'unit-1', status: 'AVAILABLE' }),
    ],
  });

  const result = await executeFeedImport({
    mode: 'run',
    sourceId: 'source-1',
    db,
    storage: state.storage,
    xmlFetcher: async () => `<?xml version="1.0"?>
      <feed>
        <object>
          <ExternalId>sold-1</ExternalId>
          <Booking><Status>sold</Status></Booking>
          <Address>Test object</Address>
          <Category>flatSale</Category>
          <TotalArea>45</TotalArea>
          <FloorNumber>5</FloorNumber>
          <BargainTerms><Price>7000000</Price><Currency>RUR</Currency></BargainTerms>
        </object>
      </feed>`,
    now: () => fixedDate,
  });

  assert.equal(result.summary.archived, 1);
  assert.deepEqual(state.object, {
    id: 'object-1',
    feedPriceFrom: null,
    feedPricePerMeterFrom: null,
    feedAreaRange: null,
    feedFloorRange: null,
    feedUnitsCount: null,
    feedUnitsCountText: null,
    feedCompletionYear: null,
    feedCompletionQuarter: null,
    feedUpdatedAt: null,
  });
});

test('executeFeedImport run records media failures as warnings and partial status', async () => {
  const { db, state } = createFakeDb();

  const result = await executeFeedImport({
    mode: 'run',
    sourceId: 'source-1',
    db,
    storage: state.storage,
    xmlFetcher: async () => makeYandexFeed({ secondMediaUrl: 'https://cdn.test/fail.png' }),
    mediaDownloader: async (url) => {
      if (url.endsWith('/fail.png')) {
        throw new Error('download failed');
      }

      return {
        body: Buffer.from(`body:${url}`),
        contentType: 'image/png',
        originalName: 'a.png',
      };
    },
    imageVariantGenerator: async () => [],
    now: () => fixedDate,
  });

  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.some((warning) => warning.code === 'MEDIA_DOWNLOAD_FAILED'), true);
  assert.equal(result.summary.media.failed, 1);
  assert.equal(result.summary.media.downloaded, 1);
  assert.equal(state.runs[0].status, 'PARTIAL');
  assert.deepEqual(state.source.lastRunAt, fixedDate);
  assert.deepEqual(state.source.lastSuccessAt, fixedDate);
});

function createFakeDb({ source = {}, object = {}, objects = null, units = [], mediaAssets = [] } = {}) {
  const primaryObject = makeObjectAggregate({
    ...object,
    id: object.id ?? 'object-1',
  });
  const state = {
    source: {
      id: 'source-1',
      sourceKind: 'URL',
      url: 'https://feeds.test/yandex.xml',
      xmlFileId: null,
      xmlFile: null,
      format: 'YANDEX_REALTY',
      filterJson: null,
      developerId: 'developer-1',
      objectId: 'object-1',
      mappings: [],
      isActive: true,
      lastPreviewAt: null,
      lastRunAt: null,
      lastSuccessAt: null,
      ...source,
    },
    object: primaryObject,
    objects: new Map(
      (objects ?? [primaryObject]).map((currentObject) => [currentObject.id, makeObjectAggregate(currentObject)]),
    ),
    units: units.map((unit) => ({ ...unit })),
    mediaAssets: mediaAssets.map((asset) => ({ ...asset })),
    residentialDetails: new Map(),
    commercialDetails: new Map(),
    unitMedia: [],
    files: [],
    fileVariants: [],
    runs: [],
    runUpdates: [],
    feedUnitFindManyCalls: [],
    storagePuts: [],
    storageGets: [],
    storageObjects: new Map(),
    refreshedObjectIds: [],
  };
  state.object = state.objects.get(primaryObject.id);
  state.storage = {
    getBucket: () => 'platforma',
    getPublicUrl: (key) => `https://minio.test/platforma/${key}`,
    getObject: async (key) => {
      state.storageGets.push(key);
      const object = state.storageObjects.get(key);

      if (!object) {
        throw new Error(`Storage object ${key} was not found`);
      }

      return object;
    },
    putObject: async (object) => {
      state.storagePuts.push(object);
    },
  };

  const db = {
    feedSource: {
      findUnique: async ({ where }) => (where.id === state.source.id ? { ...state.source } : null),
      update: async ({ where, data }) => {
        assert.equal(where.id, state.source.id);
        Object.assign(state.source, data);
        return { ...state.source };
      },
    },
    feedImportRun: {
      create: async ({ data }) => {
        const run = { id: `run-${state.runs.length + 1}`, ...data };
        state.runs.push(run);
        return { ...run };
      },
      findUnique: async ({ where }) => {
        const run = state.runs.find((currentRun) => currentRun.id === where.id);
        return run ? { ...run } : null;
      },
      update: async ({ where, data }) => {
        const run = state.runs.find((currentRun) => currentRun.id === where.id);
        state.runUpdates.push(data);
        Object.assign(run, data);
        return { ...run };
      },
    },
    feedUnit: {
      findMany: async ({ where }) => {
        state.feedUnitFindManyCalls.push(where);

        return state.units
          .filter((unit) => {
            if (where.sourceId) {
              return unit.sourceId === where.sourceId;
            }

            if (where.objectId) {
              const statuses = new Set(where.status.in);
              return unit.objectId === where.objectId && statuses.has(unit.status);
            }

            return true;
          })
          .map((unit) => ({ ...unit }));
      },
      upsert: async ({ where, update, create }) => {
        const unique = where.sourceId_externalId;
        let unit = state.units.find(
          (currentUnit) => currentUnit.sourceId === unique.sourceId && currentUnit.externalId === unique.externalId,
        );

        if (unit) {
          Object.assign(unit, update);
        } else {
          unit = {
            id: `unit-${state.units.length + 1}`,
            ...create,
          };
          state.units.push(unit);
        }

        return { id: unit.id };
      },
      updateMany: async ({ where, data }) => {
        const notIn = new Set(where.externalId.notIn);
        let count = 0;

        for (const unit of state.units) {
          if (unit.sourceId === where.sourceId && !notIn.has(unit.externalId) && unit.status !== where.status.not) {
            Object.assign(unit, data);
            count += 1;
          }
        }

        return { count };
      },
    },
    feedResidentialUnitDetails: {
      upsert: async ({ where, update, create }) => {
        state.residentialDetails.set(where.unitId, { unitId: where.unitId, ...create, ...update });
        return state.residentialDetails.get(where.unitId);
      },
      deleteMany: async ({ where }) => {
        const existed = state.residentialDetails.delete(where.unitId);
        return { count: existed ? 1 : 0 };
      },
    },
    feedCommercialUnitDetails: {
      upsert: async ({ where, update, create }) => {
        state.commercialDetails.set(where.unitId, { unitId: where.unitId, ...create, ...update });
        return state.commercialDetails.get(where.unitId);
      },
      deleteMany: async ({ where }) => {
        const existed = state.commercialDetails.delete(where.unitId);
        return { count: existed ? 1 : 0 };
      },
    },
    feedMediaAsset: {
      findMany: async ({ where }) => {
        const sourceUrls = new Set(where.sourceUrl.in);
        return state.mediaAssets.filter((asset) => sourceUrls.has(asset.sourceUrl)).map((asset) => ({ ...asset }));
      },
      upsert: async ({ where, update, create }) => {
        let asset = state.mediaAssets.find((currentAsset) => currentAsset.sourceUrl === where.sourceUrl);

        if (asset) {
          Object.assign(asset, update);
        } else {
          asset = {
            id: `asset-${state.mediaAssets.length + 1}`,
            fileId: null,
            contentType: null,
            checksum: null,
            ...create,
          };
          state.mediaAssets.push(asset);
        }

        return { ...asset };
      },
      update: async ({ where, data }) => {
        const asset = state.mediaAssets.find((currentAsset) => currentAsset.id === where.id);
        Object.assign(asset, data);
        return { ...asset };
      },
    },
    feedUnitMedia: {
      deleteMany: async ({ where }) => {
        const previousCount = state.unitMedia.length;
        state.unitMedia = state.unitMedia.filter((link) => link.unitId !== where.unitId);
        return { count: previousCount - state.unitMedia.length };
      },
      createMany: async ({ data }) => {
        state.unitMedia.push(...data);
        return { count: data.length };
      },
    },
    file: {
      upsert: async ({ where, update, create }) => {
        const unique = where.storage_bucket_key;
        let file = state.files.find(
          (currentFile) =>
            currentFile.storage === unique.storage &&
            currentFile.bucket === unique.bucket &&
            currentFile.key === unique.key,
        );

        if (file) {
          Object.assign(file, update);
        } else {
          file = {
            id: `file-${state.files.length + 1}`,
            ...create,
          };
          state.files.push(file);
        }

        return { id: file.id };
      },
    },
    fileVariant: {
      upsert: async ({ where, update, create }) => {
        const unique = where.fileId_variant;
        let variant = state.fileVariants.find(
          (currentVariant) => currentVariant.fileId === unique.fileId && currentVariant.variant === unique.variant,
        );

        if (variant) {
          Object.assign(variant, update);
        } else {
          variant = {
            ...create,
          };
          state.fileVariants.push(variant);
        }

        return { ...variant };
      },
    },
    realEstateObject: {
      update: async ({ where, data }) => {
        const target = state.objects.get(where.id);
        assert.ok(target, `Object ${where.id} must exist in fake db`);
        state.refreshedObjectIds.push(where.id);
        Object.assign(target, data);
        return { ...target };
      },
    },
  };

  return { db, state };
}

function makeSourceMapping({
  id,
  objectId,
  sourceKey,
  sourceTitle,
  filterJson,
  isActive = true,
}) {
  return {
    id,
    sourceId: 'source-1',
    objectId,
    sourceKey,
    sourceTitle,
    filterJson,
    isActive,
  };
}

function createIndexNamespace(sourceUrl) {
  return createHash('sha1').update(sourceUrl).digest('hex').slice(0, 12);
}

function makeObjectAggregate(overrides = {}) {
  return {
    id: 'object-1',
    feedPriceFrom: null,
    feedPricePerMeterFrom: null,
    feedAreaRange: null,
    feedFloorRange: null,
    feedUnitsCount: null,
    feedUnitsCountText: null,
    feedCompletionYear: null,
    feedCompletionQuarter: null,
    feedUpdatedAt: null,
    ...overrides,
  };
}

function makeUnit({
  id,
  sourceId = 'source-1',
  objectId = 'object-1',
  externalId,
  status,
  price = null,
  discountPrice = null,
  effectivePrice = price,
  pricePerMeter = null,
  discountPricePerMeter = null,
  effectivePricePerMeter = pricePerMeter,
  area = null,
  floor = null,
  completionYear = null,
  completionQuarter = null,
}) {
  return {
    id,
    sourceId,
    objectId,
    externalId,
    type: 'RESIDENTIAL',
    status,
    title: null,
    address: null,
    building: null,
    section: null,
    floor,
    rooms: null,
    price,
    discountPrice,
    effectivePrice,
    currency: null,
    area,
    pricePerMeter,
    discountPricePerMeter,
    effectivePricePerMeter,
    completionYear,
    completionQuarter,
    rawPayload: null,
    archivedAt: null,
  };
}
