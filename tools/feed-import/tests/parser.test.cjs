const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');

const {
  AvitoXmlFeedParser,
  CianXmlFeedParser,
  YandexRealtyFeedParser,
  analyzeFeedSourceInput,
  createFeedSourceAnalysis,
  detectFeedFormatFromXml,
  discoverFeedIndexLinks,
  loadXmlFromUrl,
  normalizeFeedUnitStatus,
} = require('../dist/index.js');

const fixtureDir = resolve(__dirname, 'fixtures');

function readFixture(name) {
  return readFileSync(resolve(fixtureDir, name), 'utf8');
}

function makeIndexYandexXml() {
  return `<?xml version="1.0"?>
    <realty-feed>
      <offer internal-id="yandex-1">
        <property-type>жилая</property-type>
        <category>квартира</category>
        <sales-agent><organization>Смайнекс</organization></sales-agent>
        <building-name>Лаврушинский</building-name>
        <price><value>10000000</value><currency>RUR</currency></price>
        <area><value>40</value></area>
      </offer>
    </realty-feed>`;
}

function makeIndexCianXml(externalId = 'cian-1', projectName = 'Муза') {
  return `<?xml version="1.0"?>
    <feed>
      <object>
        <ExternalId>${externalId}</ExternalId>
        <Category>flatSale</Category>
        <Address>Красноармейская, вл. 11</Address>
        <TotalArea>45</TotalArea>
        <BargainTerms><Price>12000000</Price><Currency>RUR</Currency></BargainTerms>
        <Developer><Name>Смайнекс</Name></Developer>
        <JKSchema><Name>${projectName}</Name><House><Name>Корпус 1</Name></House></JKSchema>
      </object>
    </feed>`;
}

function makeStoneCianLikeRealtyFeedXml() {
  return `<?xml version="1.0" encoding="utf-8"?>
    <realty-feed xmlns="http://webmaster.yandex.ru/schemas/feed/realty/2010-06">
      <object>
        <Category>officeSale</Category>
        <ExternalId>COM_SALE11188_v2</ExternalId>
        <Address>&#x41C;&#x43E;&#x441;&#x43A;&#x432;&#x430;, &#x411;&#x443;&#x43C;&#x430;&#x436;&#x43D;&#x44B;&#x439; &#x43F;&#x440;&#x43E;&#x435;&#x437;&#x434;, &#x432;&#x43B;.19</Address>
        <FloorNumber>8</FloorNumber>
        <Building><CeilingHeight>3.65</CeilingHeight></Building>
        <BargainTerms><Price>45240000.00</Price><Currency>RUR</Currency></BargainTerms>
        <TotalArea>69.60</TotalArea>
        <Photos>
          <PhotoSchema>
            <FullUrl>https://img.example.com/photo.jpg?x=1&amp;y=2</FullUrl>
            <isDefault>true</isDefault>
          </PhotoSchema>
        </Photos>
      </object>
    </realty-feed>`;
}

function makeIndexAvitoXml() {
  return `<?xml version="1.0" encoding="utf-8"?>
    <Ads target="Avito.ru" formatVersion="3">
      <Ad>
        <Id>avito-1</Id>
        <Address>Красноармейская, вл. 11</Address>
        <Price>9000000</Price>
        <Category>Квартиры</Category>
        <NewDevelopmentId>1234567</NewDevelopmentId>
        <Square>30</Square>
      </Ad>
    </Ads>`;
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

test('YandexRealtyFeedParser treats Aura separate rooms type as studio only when room count is missing', () => {
  const parser = new YandexRealtyFeedParser();
  const xml = `<?xml version="1.0"?>
    <realty-feed>
      <offer internal-id="aura-studio">
        <property-type>жилая</property-type>
        <category>квартира</category>
        <building-name>Аура</building-name>
        <location><apartment>17</apartment></location>
        <price><value>25099560</value><currency>RUR</currency></price>
        <area><value>33.9</value></area>
        <rooms-type>раздельные</rooms-type>
      </offer>
      <offer internal-id="aura-two-room">
        <property-type>жилая</property-type>
        <category>квартира</category>
        <building-name>Аура</building-name>
        <location><apartment>611</apartment></location>
        <price><value>49775900</value><currency>RUR</currency></price>
        <area><value>69.5</value></area>
        <rooms>2</rooms>
        <rooms-type>раздельные</rooms-type>
      </offer>
    </realty-feed>`;

  const result = parser.parse(xml);

  assert.deepEqual(result.warnings, []);
  assert.equal(result.units[0].rooms, 0);
  assert.equal(result.units[0].residentialDetails.layoutType, 'раздельные');
  assert.equal(result.units[1].rooms, 2);
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

test('CianXmlFeedParser forces Sminex residential titles to apartment number', () => {
  const parser = new CianXmlFeedParser();
  const xml = `<?xml version="1.0"?>
    <feed>
      <object>
        <ExternalId>000029025</ExternalId>
        <title>Электрический 1, newBuildingFlatSale, 000029025</title>
        <Category>newBuildingFlatSale</Category>
        <Address>Электрический 1</Address>
        <FloorNumber>2</FloorNumber>
        <FlatRoomsCount>1</FlatRoomsCount>
        <TotalArea>45.6</TotalArea>
        <BargainTerms><Price>72150000</Price><Currency>RUR</Currency></BargainTerms>
        <Developer><Name>Sminex</Name></Developer>
        <JKSchema>
          <Name>Электрический 1</Name>
          <House>
            <Name>К4С1</Name>
            <Flat>
              <FlatNumber>193</FlatNumber>
              <SectionNumber>1</SectionNumber>
            </Flat>
          </House>
        </JKSchema>
      </object>
    </feed>`;

  const result = parser.parse(xml);
  const unit = result.units[0];

  assert.equal(unit.title, 'Квартира №193');
  assert.equal(unit.address, 'Электрический 1');
  assert.equal(unit.externalId, '000029025');
  assert.equal(unit.residentialDetails.apartmentNumber, '193');
});

test('CianXmlFeedParser normalizes CIAN-like realty-feed objects and decodes XML entities', () => {
  const parser = new CianXmlFeedParser();

  const result = parser.parse(makeStoneCianLikeRealtyFeedXml());
  const unit = result.units[0];

  assert.deepEqual(result.warnings, []);
  assert.equal(result.units.length, 1);
  assert.equal(unit.externalId, 'COM_SALE11188_v2');
  assert.equal(unit.type, 'COMMERCIAL');
  assert.equal(unit.status, 'AVAILABLE');
  assert.equal(unit.price, '45240000.00');
  assert.equal(unit.currency, 'RUR');
  assert.equal(unit.area, '69.60');
  assert.equal(unit.pricePerMeter, '650000.00');
  assert.equal(unit.floor, 8);
  assert.equal(unit.address, 'Москва, Бумажный проезд, вл.19');
  assert.equal(unit.commercialDetails.ceilingHeight, '3.65');
  assert.deepEqual(unit.media, [
    {
      sourceUrl: 'https://img.example.com/photo.jpg?x=1&y=2',
      sortOrder: 0,
      label: 'photo',
    },
  ]);
});

test('AvitoXmlFeedParser normalizes residential units, studio rooms and media', () => {
  const parser = new AvitoXmlFeedParser();
  const xml = `<?xml version="1.0" encoding="utf-8"?>
    <Ads target="Avito.ru" formatVersion="3">
      <Ad>
        <Id>000080284</Id>
        <Status>Квартира</Status>
        <Address>Челобитьево, корпус 12.1</Address>
        <Price>6520000</Price>
        <Category>Квартиры</Category>
        <MarketType>Новостройка</MarketType>
        <NewDevelopmentId>8605163</NewDevelopmentId>
        <Square>24.7</Square>
        <LivingSpace>10.4</LivingSpace>
        <KitchenSpace>5.4</KitchenSpace>
        <Rooms>Студия</Rooms>
        <Floor>2</Floor>
        <Decoration>Без отделки</Decoration>
        <CeilingHeight>2.82</CeilingHeight>
        <Images>
          <Image url="https://feeds.example.test/plan.jpg"/>
        </Images>
      </Ad>
    </Ads>`;

  const result = parser.parse(xml);
  const unit = result.units[0];

  assert.deepEqual(result.warnings, []);
  assert.equal(unit.externalId, '000080284');
  assert.equal(unit.type, 'RESIDENTIAL');
  assert.equal(unit.status, 'AVAILABLE');
  assert.equal(unit.title, 'Челобитьево, корпус 12.1, Квартиры, 000080284');
  assert.equal(unit.address, 'Челобитьево, корпус 12.1');
  assert.equal(unit.building, 'корпус 12.1');
  assert.equal(unit.floor, 2);
  assert.equal(unit.rooms, 0);
  assert.equal(unit.price, '6520000.00');
  assert.equal(unit.currency, 'RUR');
  assert.equal(unit.area, '24.70');
  assert.equal(unit.pricePerMeter, '263967.61');
  assert.deepEqual(unit.media, [
    {
      sourceUrl: 'https://feeds.example.test/plan.jpg',
      sortOrder: 0,
      label: 'photo',
    },
  ]);
  assert.equal(unit.residentialDetails.layoutType, 'Студия');
  assert.equal(unit.residentialDetails.livingArea, '10.40');
  assert.equal(unit.residentialDetails.kitchenArea, '5.40');
  assert.equal(unit.residentialDetails.detailsJson.avitoDevelopmentId, '8605163');
  assert.equal(unit.residentialDetails.detailsJson.ceilingHeight, '2.82');
  assert.equal(unit.commercialDetails, null);
});

test('createFeedSourceAnalysis summarizes Avito development groups', () => {
  const parser = new AvitoXmlFeedParser();
  const xml = `<?xml version="1.0" encoding="utf-8"?>
    <Ads target="Avito.ru" formatVersion="3">
      <Ad>
        <Id>flat-1</Id>
        <Address>Челобитьево, корпус 12.1</Address>
        <Price>6520000</Price>
        <Category>Квартиры</Category>
        <NewDevelopmentId>8605163</NewDevelopmentId>
        <Square>24.7</Square>
        <Rooms>Студия</Rooms>
        <Floor>2</Floor>
      </Ad>
      <Ad>
        <Id>flat-2</Id>
        <Address>Челобитьево, корпус 11.1</Address>
        <Price>7000000</Price>
        <Category>Квартиры</Category>
        <NewDevelopmentId>8605163</NewDevelopmentId>
        <Square>30</Square>
        <Rooms>1</Rooms>
        <Floor>3</Floor>
      </Ad>
      <Ad>
        <Id>flat-3</Id>
        <Address>Москва, другой корпус</Address>
        <Price>9000000</Price>
        <Category>Квартиры</Category>
        <NewDevelopmentId>1234567</NewDevelopmentId>
        <Square>45</Square>
        <Rooms>2</Rooms>
        <Floor>5</Floor>
      </Ad>
    </Ads>`;
  const parsed = parser.parse(xml);

  const analysis = createFeedSourceAnalysis('AVITO_XML', parsed);

  assert.equal(analysis.format, 'AVITO_XML');
  assert.equal(analysis.unitsCount, 3);
  assert.equal(analysis.objects.length, 2);
  assert.deepEqual(
    analysis.objects.map((object) => [object.title, object.unitsCount]),
    [
      ['Avito ЖК 8605163', 2],
      ['Avito ЖК 1234567', 1],
    ],
  );
  assert.deepEqual(analysis.objects[0].avitoDevelopmentIds, ['8605163']);
  assert.deepEqual(analysis.objects[0].filterJson, {
    avitoDevelopmentIds: ['8605163'],
  });
});

test('detectFeedFormatFromXml detects supported XML roots', () => {
  assert.equal(detectFeedFormatFromXml(makeIndexYandexXml()), 'YANDEX_REALTY');
  assert.equal(detectFeedFormatFromXml(makeIndexCianXml()), 'CIAN_XML');
  assert.equal(detectFeedFormatFromXml('<Feed><Object><ExternalId>1</ExternalId></Object></Feed>'), 'CIAN_XML');
  assert.equal(detectFeedFormatFromXml(makeStoneCianLikeRealtyFeedXml()), 'CIAN_XML');
  assert.equal(detectFeedFormatFromXml(makeIndexAvitoXml()), 'AVITO_XML');
  assert.equal(detectFeedFormatFromXml('<unknown-feed />'), null);
});

test('discoverFeedIndexLinks resolves same-origin XML links from index HTML', () => {
  const links = discoverFeedIndexLinks(
    `<html>
      <body>
        <a href="yandex.xml">Yandex</a>
        <a href="/xml/cian.xml?token=1">Cian</a>
        <a href="https://feeds.example.test/xml/avito.XML">Avito</a>
        <a href="https://other.example.test/xml/ignored.xml">Ignored</a>
        <a href="/xml/cian.xml?token=1">Duplicate</a>
      </body>
    </html>`,
    'https://feeds.example.test/xml/',
  );

  assert.deepEqual(links, [
    'https://feeds.example.test/xml/yandex.xml',
    'https://feeds.example.test/xml/cian.xml?token=1',
    'https://feeds.example.test/xml/avito.XML',
  ]);
});

test('analyzeFeedSourceInput returns index discovery for auto format', async () => {
  const indexUrl = 'https://feeds.test/xml/';
  const responses = new Map([
    [
      indexUrl,
      `<html><body>
        <a href="yandex.xml">Yandex</a>
        <a href="cian.xml">Cian</a>
        <a href="avito.xml">Avito</a>
        <a href="bad.xml">Broken</a>
      </body></html>`,
    ],
    ['https://feeds.test/xml/yandex.xml', makeIndexYandexXml()],
    ['https://feeds.test/xml/cian.xml', makeIndexCianXml()],
    ['https://feeds.test/xml/avito.xml', makeIndexAvitoXml()],
    ['https://feeds.test/xml/bad.xml', '<not-xml'],
  ]);

  const result = await analyzeFeedSourceInput({
    format: 'AUTO',
    sourceKind: 'INDEX_URL',
    url: indexUrl,
    xmlFetcher: async (url) => responses.get(url),
  });

  assert.equal(result.analysis, null);
  assert.equal(result.discovery.sourceUrl, indexUrl);
  assert.equal(result.discovery.files.length, 4);

  const platformsByFormat = Object.fromEntries(
    result.discovery.platforms.map((platform) => [platform.format, platform]),
  );
  assert.equal(platformsByFormat.YANDEX_REALTY.filesCount, 1);
  assert.equal(platformsByFormat.YANDEX_REALTY.unitsCount, 1);
  assert.equal(platformsByFormat.CIAN_XML.filesCount, 1);
  assert.equal(platformsByFormat.CIAN_XML.unitsCount, 1);
  assert.equal(platformsByFormat.AVITO_XML.filesCount, 1);
  assert.equal(platformsByFormat.AVITO_XML.unitsCount, 1);

  const brokenFile = result.discovery.files.find((file) => file.url.endsWith('/bad.xml'));
  assert.equal(brokenFile.format, null);
  assert.equal(typeof brokenFile.error, 'string');
});

test('analyzeFeedSourceInput analyzes selected index platform files together', async () => {
  const indexUrl = 'https://feeds.test/xml/';
  const responses = new Map([
    [
      indexUrl,
      `<html><body>
        <a href="yandex.xml">Yandex</a>
        <a href="cian-a.xml">Cian A</a>
        <a href="cian-b.xml">Cian B</a>
      </body></html>`,
    ],
    ['https://feeds.test/xml/yandex.xml', makeIndexYandexXml()],
    ['https://feeds.test/xml/cian-a.xml', makeIndexCianXml('cian-1', 'Муза')],
    ['https://feeds.test/xml/cian-b.xml', makeIndexCianXml('cian-2', 'Аура')],
  ]);

  const result = await analyzeFeedSourceInput({
    format: 'CIAN_XML',
    sourceKind: 'INDEX_URL',
    url: indexUrl,
    xmlFetcher: async (url) => responses.get(url),
  });

  assert.equal(result.discovery, null);
  assert.equal(result.analysis.format, 'CIAN_XML');
  assert.equal(result.analysis.developerName, 'Смайнекс');
  assert.equal(result.analysis.unitsCount, 2);
  assert.deepEqual(
    result.analysis.objects.map((object) => [object.title, object.unitsCount]),
    [
      ['Аура', 1],
      ['Муза', 1],
    ],
  );
});

test('analyzeFeedSourceInput auto analyzes CIAN-like realty-feed objects', async () => {
  const result = await analyzeFeedSourceInput({
    format: 'AUTO',
    sourceKind: 'URL',
    url: 'https://feeds.test/stone.xml',
    xmlFetcher: async () => makeStoneCianLikeRealtyFeedXml(),
  });

  assert.equal(result.discovery, null);
  assert.equal(result.analysis.format, 'CIAN_XML');
  assert.equal(result.analysis.unitsCount, 1);
  assert.deepEqual(
    result.analysis.objects.map((object) => [object.title, object.unitsCount]),
    [['Москва, Бумажный проезд, вл.19', 1]],
  );
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
