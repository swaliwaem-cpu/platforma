const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');

const {
  CianXmlFeedParser,
  YandexRealtyFeedParser,
  createFeedSourceAnalysis,
  loadXmlFromUrl,
  normalizeFeedUnitStatus,
} = require('../dist/index.js');

const fixtureDir = resolve(__dirname, 'fixtures');

function readFixture(name) {
  return readFileSync(resolve(fixtureDir, name), 'utf8');
}

test('YandexRealtyFeedParser normalizes residential units from fixture', () => {
  const parser = new YandexRealtyFeedParser();

  const result = parser.parse(readFixture('yandex.xml'));
  const first = result.units[0];

  assert.equal(result.units.length, 92);
  assert.deepEqual(result.warnings, []);
  assert.equal(first.externalId, '1323ff84-468e-46bd-bceb-a24573e4d766');
  assert.equal(first.type, 'RESIDENTIAL');
  assert.equal(first.status, 'AVAILABLE');
  assert.equal(first.price, '49775900.00');
  assert.equal(first.currency, 'RUR');
  assert.equal(first.area, '69.50');
  assert.equal(first.pricePerMeter, '716200.00');
  assert.equal(first.floor, 18);
  assert.equal(first.rooms, 2);
  assert.equal(first.completionYear, 2027);
  assert.equal(first.completionQuarter, 4);
  assert.equal(first.address, 'Москва, Большая Тульская улица, д.8');
  assert.equal(first.building, 'Аура');
  assert.equal(first.section, 'Бронзовая башня');
  assert.equal(first.media.length, 14);
  assert.deepEqual(first.media.slice(0, 3), [
    {
      sourceUrl: 'https://6feeds.ru/sl/dc9b4c7195308779800df0a12b37546d',
      sortOrder: 0,
      label: 'plan',
    },
    {
      sourceUrl: 'https://6feeds.ru/sl/83e07e09447f989523ff0607d662d806',
      sortOrder: 1,
      label: 'floor-plan',
    },
    {
      sourceUrl: 'https://6feeds.ru/new_images/mangazeya_tulskaya/new_renders/001_glavn.png?d=1323ff84-468e-46bd-bceb-a24573e4d766',
      sortOrder: 2,
      label: null,
    },
  ]);
  assert.equal(first.residentialDetails.apartmentNumber, '611');
  assert.equal(first.residentialDetails.livingArea, '29.00');
  assert.equal(first.commercialDetails, null);
});

test('YandexRealtyFeedParser normalizes Etalon-style Yandex fields', () => {
  const parser = new YandexRealtyFeedParser();
  const xml = `<?xml version="1.0"?>
    <realty-feed>
      <offer internal-id="97420">
        <type>продажа</type>
        <property-type>жилая</property-type>
        <category>квартира</category>
        <location>
          <country>Россия</country>
          <locality-name>Москва</locality-name>
          <latitude>55.688233</latitude>
          <longitude>37.654625</longitude>
        </location>
        <Address>Москва, ЮАО, Даниловский, пр-кт Андропова</Address>
        <price><value>17597954</value><currency>RUB</currency></price>
        <area><value>25.3</value><unit>кв. м</unit></area>
        <living-space><value>12.9</value><unit>кв. м</unit></living-space>
        <kitchen-space><value>5.1</value><unit>кв. м</unit></kitchen-space>
        <description>Продается квартира 1017, по адресу Москва, ЮАО, Даниловский.</description>
        <floor>29</floor>
        <studio>true</studio>
        <building-name>Нагатино Ай-Лэнд</building-name>
        <yandex-building-id>2133018</yandex-building-id>
        <yandex-house-id>2923598</yandex-house-id>
        <ceiling-height>3</ceiling-height>
        <image tag="plan">https://imgs.etalongroup.ru/plan.png</image>
      </offer>
    </realty-feed>`;

  const result = parser.parse(xml);
  const unit = result.units[0];

  assert.deepEqual(result.warnings, []);
  assert.equal(unit.externalId, '97420');
  assert.equal(unit.address, 'Москва, ЮАО, Даниловский, пр-кт Андропова');
  assert.equal(unit.rooms, 0);
  assert.equal(unit.title, 'Нагатино Ай-Лэнд, квартира, № 1017');
  assert.equal(unit.residentialDetails.apartmentNumber, '1017');
  assert.equal(unit.residentialDetails.kitchenArea, '5.10');
  assert.equal(unit.residentialDetails.detailsJson.yandexBuildingId, '2133018');
});

test('createFeedSourceAnalysis summarizes Yandex developer and object groups', () => {
  const parser = new YandexRealtyFeedParser();
  const xml = `<?xml version="1.0"?>
    <realty-feed>
      <offer internal-id="flat-1">
        <property-type>жилая</property-type>
        <category>квартира</category>
        <sales-agent><organization>АО «ГК «ЭТАЛОН»</organization></sales-agent>
        <Address>Москва, пр-кт Андропова</Address>
        <building-name>Нагатино Ай-Лэнд</building-name>
        <yandex-building-id>2133018</yandex-building-id>
        <yandex-house-id>2923598</yandex-house-id>
        <price><value>10000000</value><currency>RUB</currency></price>
        <area><value>40</value></area>
      </offer>
      <offer internal-id="flat-2">
        <property-type>жилая</property-type>
        <category>квартира</category>
        <sales-agent><organization>АО «ГК «ЭТАЛОН»</organization></sales-agent>
        <Address>Москва, пр-кт Андропова</Address>
        <building-name>Нагатино Ай-Лэнд</building-name>
        <yandex-building-id>2133018</yandex-building-id>
        <yandex-house-id>2923285</yandex-house-id>
        <price><value>11000000</value><currency>RUB</currency></price>
        <area><value>42</value></area>
      </offer>
      <offer internal-id="flat-3">
        <property-type>жилая</property-type>
        <category>квартира</category>
        <sales-agent><organization>АО «ГК «ЭТАЛОН»</organization></sales-agent>
        <Address>ЦАО, ул. Летниковская</Address>
        <building-name>Воксхолл</building-name>
        <yandex-building-id>2708049</yandex-building-id>
        <yandex-house-id>2708699</yandex-house-id>
        <price><value>12000000</value><currency>RUB</currency></price>
        <area><value>44</value></area>
      </offer>
    </realty-feed>`;
  const parsed = parser.parse(xml);

  const analysis = createFeedSourceAnalysis('YANDEX_REALTY', parsed);

  assert.equal(analysis.developerName, 'АО «ГК «ЭТАЛОН»');
  assert.equal(analysis.unitsCount, 3);
  assert.equal(analysis.objects.length, 2);
  assert.deepEqual(
    analysis.objects.map((object) => [object.title, object.unitsCount]),
    [
      ['Нагатино Ай-Лэнд', 2],
      ['Воксхолл', 1],
    ],
  );
  assert.deepEqual(analysis.objects[0].filterJson, {
    buildingNames: ['Нагатино Ай-Лэнд'],
    yandexBuildingIds: ['2133018'],
    yandexHouseIds: ['2923598', '2923285'],
    addressIncludes: ['Москва, пр-кт Андропова'],
  });
});

test('CianXmlFeedParser normalizes commercial units from fixture', () => {
  const parser = new CianXmlFeedParser();

  const result = parser.parse(readFixture('MNF_Cian_5827_.xml'));
  const first = result.units[0];
  const booked = result.units.find((unit) => unit.externalId === '000110569');

  assert.equal(result.units.length, 47);
  assert.deepEqual(result.warnings, []);
  assert.equal(first.externalId, '000110548');
  assert.equal(first.type, 'COMMERCIAL');
  assert.equal(first.status, 'AVAILABLE');
  assert.equal(first.price, '184880000.00');
  assert.equal(first.currency, 'RUR');
  assert.equal(first.area, '288.40');
  assert.equal(first.pricePerMeter, '641054.09');
  assert.equal(first.floor, 1);
  assert.equal(first.rooms, null);
  assert.equal(first.address, 'Мануфактура XIX');
  assert.equal(first.building, 'Ретейл');
  assert.equal(first.completionYear, null);
  assert.equal(first.completionQuarter, null);
  assert.equal(first.media.length, 4);
  assert.deepEqual(first.media.slice(0, 2), [
    {
      sourceUrl: 'https://feeds.sminex.com/Planirovki/Manufactura/1/R4/260403_MPA_2_R_LRUMV_1_R4_V1_L.JPG',
      sortOrder: 0,
      label: 'layout-photo',
    },
    {
      sourceUrl: 'https://feeds.sminex.com/Planirovki/Manufactura/1/R4/260403_MPA_2_R_LRUMG_1_R4_V1_L.JPG',
      sortOrder: 1,
      label: 'photo',
    },
  ]);
  assert.equal(first.commercialDetails.commercialType, 'freeAppointmentSale');
  assert.equal(first.commercialDetails.ceilingHeight, '3.86');
  assert.equal(first.residentialDetails, null);
  assert.equal(booked.status, 'BOOKED');
});

test('CianXmlFeedParser normalizes Etalon-style project, house, rooms and media fields', () => {
  const parser = new CianXmlFeedParser();
  const xml = `<?xml version="1.0"?>
    <feed>
      <object>
        <ExternalId>shagal-659</ExternalId>
        <title>Квартира №659</title>
        <Category>flatSale</Category>
        <Address>г. Москва, ЮАО, ул. Автозаводская, вл. 23/75</Address>
        <FloorNumber>12</FloorNumber>
        <FlatRoomsCount>9</FlatRoomsCount>
        <TotalArea>31.4</TotalArea>
        <LivingArea>18.2</LivingArea>
        <KitchenArea>5.1</KitchenArea>
        <BargainTerms><Price>15000000</Price><Currency>RUR</Currency></BargainTerms>
        <Developer><Name>Группа Эталон</Name></Developer>
        <JKSchema>
          <Name>Шагал</Name>
          <House>
            <Name>Корпус 8</Name>
            <Flat>
              <FlatNumber>659</FlatNumber>
              <SectionNumber>2</SectionNumber>
            </Flat>
          </House>
        </JKSchema>
        <LayoutPhoto>
          <FullUrl>https://img.example.com/layout-1.png</FullUrl>
          <FullUrl>https://img.example.com/layout-2.png</FullUrl>
        </LayoutPhoto>
        <Photos>
          <PhotoSchema><FullUrl>https://img.example.com/photo-1.jpg</FullUrl></PhotoSchema>
        </Photos>
      </object>
      <object>
        <ExternalId>shagal-701</ExternalId>
        <title>Квартира №701</title>
        <Category>flatSale</Category>
        <Address>г. Москва, ЮАО, ул. Автозаводская, вл. 23/74</Address>
        <FloorNumber>14</FloorNumber>
        <FlatRoomsCount>2</FlatRoomsCount>
        <TotalArea>54.2</TotalArea>
        <BargainTerms><Price>23000000</Price><Currency>RUR</Currency></BargainTerms>
        <Developer><Name>Группа Эталон</Name></Developer>
        <JKSchema>
          <Name>Шагал</Name>
          <House><Name>Корпус 9</Name><Flat><FlatNumber>701</FlatNumber></Flat></House>
        </JKSchema>
      </object>
      <object>
        <ExternalId>nag-1017</ExternalId>
        <title>Квартира №1017</title>
        <Category>flatSale</Category>
        <Address>Москва, ЮАО, Даниловский, пр-кт Андропова</Address>
        <FloorNumber>29</FloorNumber>
        <FlatRoomsCount>1</FlatRoomsCount>
        <TotalArea>25.3</TotalArea>
        <BargainTerms><Price>17597954</Price><Currency>RUR</Currency></BargainTerms>
        <Developer><Name>Группа Эталон</Name></Developer>
        <JKSchema>
          <Name>Нагатино Ай-Лэнд</Name>
          <House><Name>Корпус 1</Name><Flat><FlatNumber>1017</FlatNumber></Flat></House>
        </JKSchema>
      </object>
    </feed>`;

  const result = parser.parse(xml);
  const first = result.units[0];

  assert.deepEqual(result.warnings, []);
  assert.equal(first.status, 'AVAILABLE');
  assert.equal(first.title, 'Квартира №659');
  assert.equal(first.projectName, 'Шагал');
  assert.equal(first.building, 'Корпус 8');
  assert.equal(first.section, '2');
  assert.equal(first.rooms, 0);
  assert.equal(first.residentialDetails.apartmentNumber, '659');
  assert.deepEqual(first.media, [
    {
      sourceUrl: 'https://img.example.com/layout-1.png',
      sortOrder: 0,
      label: 'layout-photo',
    },
    {
      sourceUrl: 'https://img.example.com/layout-2.png',
      sortOrder: 1,
      label: 'layout-photo',
    },
    {
      sourceUrl: 'https://img.example.com/photo-1.jpg',
      sortOrder: 2,
      label: 'photo',
    },
  ]);

  const analysis = createFeedSourceAnalysis('CIAN_XML', result);

  assert.equal(analysis.developerName, 'Группа Эталон');
  assert.deepEqual(
    analysis.objects.map((object) => [object.title, object.unitsCount]),
    [
      ['Шагал', 2],
      ['Нагатино Ай-Лэнд', 1],
    ],
  );
  assert.deepEqual(analysis.objects[0].projectNames, ['Шагал']);
  assert.deepEqual(analysis.objects[0].buildingNames, ['Корпус 8', 'Корпус 9']);
  assert.deepEqual(analysis.objects[0].filterJson, {
    projectNames: ['Шагал'],
  });
});

test('parsers report unknown statuses and broken numeric/media fields as warnings', () => {
  const parser = new CianXmlFeedParser();
  const xml = `<?xml version="1.0"?>
    <feed>
      <object>
        <ExternalId>broken-1</ExternalId>
        <Booking><Status>hold</Status></Booking>
        <Address>Test address</Address>
        <Category>officeSale</Category>
        <TotalArea>not-a-number</TotalArea>
        <FloorNumber>bad-floor</FloorNumber>
        <LayoutPhoto><FullUrl>ftp://example.com/layout.jpg</FullUrl></LayoutPhoto>
        <Photos><PhotoSchema><FullUrl>not-url</FullUrl></PhotoSchema></Photos>
        <Building><Name>Test building</Name><CeilingHeight>oops</CeilingHeight></Building>
        <BargainTerms><Price>bad-price</Price><Currency>RUR</Currency></BargainTerms>
      </object>
    </feed>`;

  const result = parser.parse(xml);
  const unit = result.units[0];
  const warningCodes = result.warnings.map((warning) => warning.code);

  assert.equal(unit.status, 'UNKNOWN');
  assert.equal(unit.price, null);
  assert.equal(unit.area, null);
  assert.equal(unit.floor, null);
  assert.equal(unit.media.length, 0);
  assert.equal(unit.commercialDetails.ceilingHeight, null);
  assert.deepEqual(warningCodes, [
    'UNKNOWN_STATUS',
    'INVALID_DECIMAL',
    'INVALID_INTEGER',
    'INVALID_DECIMAL',
    'INVALID_DECIMAL',
    'INVALID_MEDIA_URL',
    'INVALID_MEDIA_URL',
  ]);
  assert(result.warnings.every((warning) => warning.externalId === 'broken-1'));
});

test('normalizeFeedUnitStatus maps known feed statuses and reports unknown values', () => {
  assert.equal(normalizeFeedUnitStatus('free').status, 'AVAILABLE');
  assert.equal(normalizeFeedUnitStatus('booked').status, 'BOOKED');
  assert.equal(normalizeFeedUnitStatus('reserved').status, 'RESERVED');
  assert.equal(normalizeFeedUnitStatus('sold').status, 'SOLD');
  assert.equal(normalizeFeedUnitStatus('archived').status, 'ARCHIVED');
  assert.deepEqual(normalizeFeedUnitStatus('mystery'), {
    status: 'UNKNOWN',
    warning: {
      code: 'UNKNOWN_STATUS',
      field: 'status',
      message: 'Unknown feed unit status: mystery',
      value: 'mystery',
    },
  });
});

test('loadXmlFromUrl downloads XML text and rejects failed responses', async () => {
  const okFetch = async (url) => {
    assert.equal(url, 'https://example.com/feed.xml');

    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '<feed />',
    };
  };

  const failedFetch = async () => ({
    ok: false,
    status: 503,
    statusText: 'Service Unavailable',
    text: async () => 'unavailable',
  });

  assert.equal(await loadXmlFromUrl('https://example.com/feed.xml', okFetch), '<feed />');
  await assert.rejects(
    () => loadXmlFromUrl('https://example.com/feed.xml', failedFetch),
    /Failed to download feed XML from https:\/\/example\.com\/feed\.xml: 503 Service Unavailable/,
  );
});
