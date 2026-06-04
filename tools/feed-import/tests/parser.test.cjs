const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');

const {
  AvitoXmlFeedParser,
  CianXmlFeedParser,
  FskXmlFeedParser,
  TektaXmlFeedParser,
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

function makeFskXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <Data>
      <Generation-date>2026-05-31T04:00:00.121Z</Generation-date>
      <FlatTypes>
        <FlatType ID="0" Name="Квартира"/>
        <FlatType ID="2" Name="Нежилое"/>
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
                    <Flat Id="61c97b374e2acff6814913c2" Id1C="141281" Type="0" Number="656" Floor="3" Rooms="2" Price_metr_sale="588700" Price_tot_sale="48979840" Square_tot="83.2" Square_live="46.3" Square_kitchen="14.3" Balcony_quantity="1" Flat_plan="https://cdn.fsk.ru/plans/flat.png" Floor_plan="https://cdn.fsk.ru/plans/floor.png"/>
                  </Floor>
                  <Floor Num="17">
                    <Flat Id="61caaa36ec8c5874694603e6" Id1C="145526" Type="7" Number="260" Floor="17" Rooms="1" Price_metr_sale="362430" Price_tot_sale="8952021" Square_tot="24.7" Square_live="9.8" Square_kitchen="6.8"/>
                  </Floor>
                  <Floor Num="2">
                    <Flat Id="67ec137b0b9889d30df128ad" Id1C="248212" Type="2" Number="1.1" Floor="2" Rooms="1" Price_metr_sale="425750" Price_tot_sale="258217375" Square_tot="606.5"/>
                  </Floor>
                </Section>
              </Corpus>
            </Buildings>
          </Object>
        </Region>
      </Regions>
    </Data>`;
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

test('YandexRealtyFeedParser keeps base and discount prices and reads flat-number fields', () => {
  const parser = new YandexRealtyFeedParser();
  const xml = `<?xml version="1.0"?>
    <realty-feed>
      <offer internal-id="forma-1">
        <type>продажа</type>
        <property-type>жилая</property-type>
        <category>квартира</category>
        <location><address>г. Москва, улица Южнопортовая 42</address></location>
        <building-name>ЖК ПОРТЛЕНД</building-name>
        <price><value>10000000</value><currency>RUR</currency></price>
        <discount><final-price>8000000</final-price></discount>
        <area><value>40</value></area>
        <floor>12</floor>
        <rooms>1</rooms>
        <built-year>2026</built-year>
        <ready-quarter>2</ready-quarter>
        <flat-number>679</flat-number>
        <balcony>1</balcony>
      </offer>
    </realty-feed>`;

  const result = parser.parse(xml);
  const unit = result.units[0];

  assert.deepEqual(result.warnings, []);
  assert.equal(unit.title, 'ЖК ПОРТЛЕНД, квартира, № 679');
  assert.equal(unit.price, '10000000.00');
  assert.equal(unit.discountPrice, '8000000.00');
  assert.equal(unit.effectivePrice, '8000000.00');
  assert.equal(unit.pricePerMeter, '250000.00');
  assert.equal(unit.discountPricePerMeter, '200000.00');
  assert.equal(unit.effectivePricePerMeter, '200000.00');
  assert.equal(unit.residentialDetails.apartmentNumber, '679');
  assert.equal(unit.residentialDetails.balconyCount, 1);
});

test('YandexRealtyFeedParser treats hand-over buildings as delivered without completion date', () => {
  const parser = new YandexRealtyFeedParser();
  const xml = `<?xml version="1.0"?>
    <realty-feed>
      <offer internal-id="soul-1">
        <type>продажа</type>
        <property-type>жилая</property-type>
        <category>квартира</category>
        <location><address>г. Москва, Часовая улица</address></location>
        <building-name>ЖК СОУЛ</building-name>
        <building-section>Корпус 1</building-section>
        <building-state>hand_over</building-state>
        <price><value>10000000</value><currency>RUR</currency></price>
        <area><value>40</value></area>
        <floor>12</floor>
        <rooms>1</rooms>
        <built-year>1970</built-year>
        <ready-quarter>1</ready-quarter>
        <flat-number>250</flat-number>
      </offer>
    </realty-feed>`;

  const result = parser.parse(xml);
  const unit = result.units[0];

  assert.deepEqual(result.warnings, []);
  assert.equal(unit.completionYear, null);
  assert.equal(unit.completionQuarter, null);
  assert.equal(unit.rawPayload['building-state'], 'hand_over');
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

test('CianXmlFeedParser reads completion from building deadline and snake case fields', () => {
  const parser = new CianXmlFeedParser();
  const xml = `<?xml version="1.0"?>
    <feed>
      <object>
        <ExternalId>deadline-1</ExternalId>
        <Category>flatSale</Category>
        <Address>Москва, пример 1</Address>
        <FloorNumber>10</FloorNumber>
        <FlatRoomsCount>2</FlatRoomsCount>
        <TotalArea>52.4</TotalArea>
        <BargainTerms><Price>20000000</Price><Currency>RUR</Currency></BargainTerms>
        <Building>
          <Name>Корпус 1</Name>
          <Deadline>
            <Year>2027</Year>
            <Quarter>third</Quarter>
          </Deadline>
        </Building>
      </object>
      <object>
        <ExternalId>deadline-2</ExternalId>
        <Category>flatSale</Category>
        <Address>Москва, пример 2</Address>
        <FloorNumber>11</FloorNumber>
        <FlatRoomsCount>1</FlatRoomsCount>
        <TotalArea>39.1</TotalArea>
        <BargainTerms><Price>15000000</Price><Currency>RUR</Currency></BargainTerms>
        <built_year>2026</built_year>
        <ready_quarter>2кв</ready_quarter>
      </object>
      <object>
        <ExternalId>deadline-3</ExternalId>
        <Category>officeSale</Category>
        <Address>Москва, пример 3</Address>
        <FloorNumber>2</FloorNumber>
        <TotalArea>80.5</TotalArea>
        <BargainTerms><Price>30000000</Price><Currency>RUR</Currency></BargainTerms>
        <Building>
          <Name>Офисы</Name>
          <BuildYear>2028</BuildYear>
        </Building>
      </object>
      <object>
        <ExternalId>deadline-4</ExternalId>
        <Category>flatSale</Category>
        <Address>Москва, пример 4</Address>
        <FloorNumber>3</FloorNumber>
        <FlatRoomsCount>1</FlatRoomsCount>
        <TotalArea>41</TotalArea>
        <BargainTerms><Price>12000000</Price><Currency>RUR</Currency></BargainTerms>
        <Building>
          <Name>Сданный корпус</Name>
          <Deadline>
            <IsComplete>true</IsComplete>
            <Year>1</Year>
            <Quarter>first</Quarter>
          </Deadline>
        </Building>
      </object>
    </feed>`;

  const result = parser.parse(xml);
  const [deadlineUnit, snakeCaseUnit, buildYearUnit, deliveredUnit] = result.units;

  assert.deepEqual(result.warnings, []);
  assert.equal(deadlineUnit.completionYear, 2027);
  assert.equal(deadlineUnit.completionQuarter, 3);
  assert.equal(snakeCaseUnit.completionYear, 2026);
  assert.equal(snakeCaseUnit.completionQuarter, 2);
  assert.equal(buildYearUnit.completionYear, 2028);
  assert.equal(buildYearUnit.completionQuarter, null);
  assert.equal(deliveredUnit.completionYear, null);
  assert.equal(deliveredUnit.completionQuarter, null);
  assert.equal(deliveredUnit.rawPayload.Building.Deadline.IsComplete, 'true');
});

test('CianXmlFeedParser reads discount price and house deadline fields', () => {
  const parser = new CianXmlFeedParser();
  const xml = `<?xml version="1.0"?>
    <feed>
      <object>
        <ExternalId>discount-deadline-1</ExternalId>
        <Category>flatSale</Category>
        <Address>Москва, пример скидки</Address>
        <FloorNumber>7</FloorNumber>
        <FlatRoomsCount>2</FlatRoomsCount>
        <TotalArea>45</TotalArea>
        <BargainTerms>
          <Price>10000000</Price>
          <DiscountPrice>9000000</DiscountPrice>
          <Currency>RUR</Currency>
        </BargainTerms>
        <JKSchema>
          <Name>Скидочный корпус</Name>
          <House>
            <Name>Корпус 2</Name>
            <Deadline>
              <Date>2028-12-31</Date>
            </Deadline>
          </House>
        </JKSchema>
      </object>
    </feed>`;

  const result = parser.parse(xml);
  const unit = result.units[0];

  assert.deepEqual(result.warnings, []);
  assert.equal(unit.price, '10000000.00');
  assert.equal(unit.discountPrice, '9000000.00');
  assert.equal(unit.effectivePrice, '9000000.00');
  assert.equal(unit.pricePerMeter, '222222.22');
  assert.equal(unit.discountPricePerMeter, '200000.00');
  assert.equal(unit.effectivePricePerMeter, '200000.00');
  assert.equal(unit.completionYear, 2028);
  assert.equal(unit.completionQuarter, 4);
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

test('CianXmlFeedParser uses Pioneer Apartment field as apartment number', () => {
  const parser = new CianXmlFeedParser();
  const xml = `<?xml version="1.0"?>
    <feed>
      <object>
        <ExternalId>261-1-2-6</ExternalId>
        <Category>newBuildingFlatSale</Category>
        <Address>Москва, переулок Котляковский 2-й</Address>
        <FloorNumber>2</FloorNumber>
        <FlatRoomsCount>1</FlatRoomsCount>
        <TotalArea>39.79</TotalArea>
        <SubAgent><FirstName>Компания Пионер</FirstName></SubAgent>
        <JKSchema>
          <Name>Жилой квартал LIFE-Варшавская</Name>
          <House>
            <Name>Корпус 261</Name>
            <Flat><SectionNumber>1</SectionNumber></Flat>
          </House>
        </JKSchema>
        <Apartment>КВ-01006</Apartment>
        <BargainTerms><Price>23782483</Price><Currency>RUR</Currency></BargainTerms>
      </object>
    </feed>`;

  const result = parser.parse(xml);
  const unit = result.units[0];

  assert.equal(unit.title, 'Квартира №КВ-01006');
  assert.equal(unit.externalId, '261-1-2-6');
  assert.equal(unit.residentialDetails.apartmentNumber, 'КВ-01006');
});

test('CianXmlFeedParser falls back to apartment number title when title is missing', () => {
  const parser = new CianXmlFeedParser();
  const xml = `<?xml version="1.0"?>
    <feed>
      <object>
        <ExternalId>1-1-2-2</ExternalId>
        <Category>newBuildingFlatSale</Category>
        <Address>Москва, 2-й Донской проезд, 10</Address>
        <FloorNumber>2</FloorNumber>
        <FlatRoomsCount>1</FlatRoomsCount>
        <TotalArea>32.22</TotalArea>
        <JKSchema>
          <Name>Премиум-квартал SHIFT</Name>
          <House><Name>Корпус 1</Name></House>
        </JKSchema>
        <Apartment>КВ-1/002</Apartment>
        <BargainTerms><Price>24000000</Price><Currency>RUR</Currency></BargainTerms>
      </object>
    </feed>`;

  const result = parser.parse(xml);
  const unit = result.units[0];

  assert.equal(unit.title, 'Квартира №КВ-1/002');
  assert.equal(unit.residentialDetails.apartmentNumber, 'КВ-1/002');
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

test('CianXmlFeedParser normalizes Regions Development fl_status values', () => {
  const parser = new CianXmlFeedParser();
  const xml = `<?xml version="1.0"?>
    <feed>
      <object>
        <ExternalId>booking-priority</ExternalId>
        <Category>newBuildingFlatSale</Category>
        <fl_status>AVAILABLE</fl_status>
        <Status>0</Status>
        <Booking><Status>sold</Status></Booking>
      </object>
      <object>
        <ExternalId>regions-available</ExternalId>
        <Category>newBuildingFlatSale</Category>
        <fl_status>AVAILABLE</fl_status>
        <Status>0</Status>
      </object>
      <object>
        <ExternalId>regions-booked</ExternalId>
        <Category>newBuildingFlatSale</Category>
        <fl_status>BOOKED</fl_status>
        <Status>1</Status>
      </object>
      <object>
        <ExternalId>regions-sold</ExternalId>
        <Category>newBuildingFlatSale</Category>
        <fl_status>SOLD</fl_status>
        <Status>2</Status>
      </object>
      <object>
        <ExternalId>regions-unavailable</ExternalId>
        <Category>newBuildingFlatSale</Category>
        <fl_status>UNAVAILABLE</fl_status>
        <Status>1</Status>
      </object>
      <object>
        <ExternalId>regions-numeric-fallback</ExternalId>
        <Category>newBuildingFlatSale</Category>
        <Status>2</Status>
      </object>
    </feed>`;

  const result = parser.parse(xml);

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(
    result.units.map((unit) => [unit.externalId, unit.status]),
    [
      ['booking-priority', 'SOLD'],
      ['regions-available', 'AVAILABLE'],
      ['regions-booked', 'BOOKED'],
      ['regions-sold', 'SOLD'],
      ['regions-unavailable', 'ARCHIVED'],
      ['regions-numeric-fallback', 'SOLD'],
    ],
  );
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

test('FskXmlFeedParser normalizes only residential units and maps FSK studios to room zero', () => {
  const parser = new FskXmlFeedParser();

  const result = parser.parse(makeFskXml());

  assert.deepEqual(result.warnings, []);
  assert.equal(result.units.length, 2);

  const flat = result.units[0];
  assert.equal(flat.externalId, '141281');
  assert.equal(flat.type, 'RESIDENTIAL');
  assert.equal(flat.status, 'AVAILABLE');
  assert.equal(flat.title, 'Режиссер, Квартира, 141281');
  assert.equal(flat.projectName, 'Режиссер');
  assert.equal(flat.address, 'г. Москва, ул. Вильгельма Пика, д. 1');
  assert.equal(flat.building, '3');
  assert.equal(flat.section, '5');
  assert.equal(flat.floor, 3);
  assert.equal(flat.rooms, 2);
  assert.equal(flat.price, '48979840.00');
  assert.equal(flat.currency, 'RUR');
  assert.equal(flat.area, '83.20');
  assert.equal(flat.pricePerMeter, '588700.00');
  assert.equal(flat.completionYear, 2024);
  assert.equal(flat.completionQuarter, 3);
  assert.equal(flat.residentialDetails.apartmentNumber, '656');
  assert.equal(flat.residentialDetails.layoutType, 'Квартира');
  assert.equal(flat.residentialDetails.livingArea, '46.30');
  assert.equal(flat.residentialDetails.kitchenArea, '14.30');
  assert.equal(flat.residentialDetails.balconyCount, 1);
  assert.deepEqual(flat.media, [
    {
      sourceUrl: 'https://cdn.fsk.ru/plans/flat.png',
      sortOrder: 0,
      label: 'flat-plan',
    },
    {
      sourceUrl: 'https://cdn.fsk.ru/plans/floor.png',
      sortOrder: 1,
      label: 'floor-plan',
    },
  ]);

  const studio = result.units[1];
  assert.equal(studio.externalId, '145526');
  assert.equal(studio.rooms, 0);
  assert.equal(studio.residentialDetails.apartmentNumber, '260');
  assert.equal(studio.residentialDetails.layoutType, 'Студия');
  assert.equal(result.units.some((unit) => unit.externalId === '248212'), false);
});

test('FskXmlFeedParser keeps base price and sale price as discount price', () => {
  const parser = new FskXmlFeedParser();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <Data>
      <FlatTypes><FlatType ID="0" Name="Квартира"/></FlatTypes>
      <Regions>
        <Region Region_name="Москва и МО">
          <Object Complex_name="Режиссер" Complex_id="67" ID1C="00320">
            <Buildings>
              <Corpus Num="1" Corpus_Delivery="2027-03-31">
                <Section Num="1">
                  <Floor Num="5">
                    <Flat
                      Id="discount-fsk-id"
                      Id1C="discount-fsk-1"
                      Type="0"
                      Number="501"
                      Floor="5"
                      Rooms="1"
                      Price_metr="250000"
                      Price_metr_sale="200000"
                      Price_tot="10000000"
                      Price_tot_sale="8000000"
                      Square_tot="40"
                    />
                  </Floor>
                </Section>
              </Corpus>
            </Buildings>
          </Object>
        </Region>
      </Regions>
    </Data>`;

  const result = parser.parse(xml);
  const unit = result.units[0];

  assert.deepEqual(result.warnings, []);
  assert.equal(unit.price, '10000000.00');
  assert.equal(unit.discountPrice, '8000000.00');
  assert.equal(unit.effectivePrice, '8000000.00');
  assert.equal(unit.pricePerMeter, '250000.00');
  assert.equal(unit.discountPricePerMeter, '200000.00');
  assert.equal(unit.effectivePricePerMeter, '200000.00');
  assert.equal(unit.completionYear, 2027);
  assert.equal(unit.completionQuarter, 1);
});

test('createFeedSourceAnalysis summarizes FSK objects for automatic mapping', () => {
  const parser = new FskXmlFeedParser();
  const parsed = parser.parse(makeFskXml());

  const analysis = createFeedSourceAnalysis('FSK_XML', parsed);

  assert.equal(analysis.format, 'FSK_XML');
  assert.equal(analysis.unitsCount, 2);
  assert.deepEqual(
    analysis.objects.map((object) => [object.title, object.unitsCount]),
    [['Режиссер', 2]],
  );
  assert.deepEqual(analysis.objects[0].projectNames, ['Режиссер']);
  assert.deepEqual(analysis.objects[0].filterJson, {
    projectNames: ['Режиссер'],
  });
});

test('TektaXmlFeedParser normalizes flats and offices while skipping hidden statuses and parking', () => {
  const parser = new TektaXmlFeedParser();

  const result = parser.parse(readFixture('tekta.xml'));
  const first = result.units[0];
  const office = result.units.find((unit) => unit.externalId === 'tekta-office-201');

  assert.equal(result.units.length, 6);
  assert.deepEqual(result.warnings, []);
  assert.equal(first.externalId, 'tekta-flat-101');
  assert.equal(first.type, 'RESIDENTIAL');
  assert.equal(first.status, 'AVAILABLE');
  assert.equal(first.title, 'Квартира №101');
  assert.equal(first.projectName, 'TWELVE');
  assert.equal(first.address, 'г. Москва, ЮАО, Электролитный');
  assert.equal(first.building, 'TW1');
  assert.equal(first.section, '1');
  assert.equal(first.floor, 12);
  assert.equal(first.rooms, 2);
  assert.equal(first.price, '25000000.00');
  assert.equal(first.discountPrice, '24000000.00');
  assert.equal(first.effectivePrice, '24000000.00');
  assert.equal(first.pricePerMeter, '500000.00');
  assert.equal(first.discountPricePerMeter, '480000.00');
  assert.equal(first.effectivePricePerMeter, '480000.00');
  assert.equal(first.area, '50.00');
  assert.equal(first.completionYear, 2026);
  assert.equal(first.completionQuarter, 1);
  assert.equal(first.residentialDetails.apartmentNumber, '101');
  assert.equal(first.residentialDetails.layoutType, '2Е');
  assert.equal(first.residentialDetails.livingArea, '30.00');
  assert.equal(first.residentialDetails.balconyCount, 1);
  assert.equal(first.commercialDetails, null);
  assert.equal(office.type, 'COMMERCIAL');
  assert.equal(office.title, 'Офис №201');
  assert.equal(office.commercialDetails.commercialType, 'Офис');
  assert.equal(office.commercialDetails.ceilingHeight, '4.20');
  assert.equal(office.commercialDetails.powerKw, '25.00');
  assert.deepEqual(
    result.units.map((unit) => [unit.externalId, unit.status]),
    [
      ['tekta-flat-101', 'AVAILABLE'],
      ['tekta-flat-102', 'BOOKED'],
      ['tekta-flat-103', 'BOOKED'],
      ['tekta-flat-104', 'RESERVED'],
      ['tekta-flat-105', 'SOLD'],
      ['tekta-office-201', 'AVAILABLE'],
    ],
  );
  assert.equal(result.units.some((unit) => unit.externalId === 'tekta-flat-106'), false);
  assert.equal(result.units.some((unit) => unit.externalId === 'tekta-flat-107'), false);
  assert.equal(result.units.some((unit) => unit.externalId === 'tekta-parking-301'), false);
});

test('createFeedSourceAnalysis summarizes Tekta XML objects for automatic mapping', () => {
  const parser = new TektaXmlFeedParser();
  const parsed = parser.parse(readFixture('tekta.xml'));

  const analysis = createFeedSourceAnalysis('TEKTA_XML', parsed);

  assert.equal(analysis.format, 'TEKTA_XML');
  assert.equal(analysis.developerName, 'Tekta');
  assert.equal(analysis.unitsCount, 6);
  assert.deepEqual(
    analysis.objects.map((object) => [object.title, object.unitsCount]),
    [['TWELVE', 6]],
  );
  assert.deepEqual(analysis.objects[0].projectNames, ['TWELVE']);
  assert.deepEqual(analysis.objects[0].filterJson, {
    projectNames: ['TWELVE'],
  });
});

test('detectFeedFormatFromXml detects supported XML roots', () => {
  assert.equal(detectFeedFormatFromXml(makeIndexYandexXml()), 'YANDEX_REALTY');
  assert.equal(detectFeedFormatFromXml(makeIndexCianXml()), 'CIAN_XML');
  assert.equal(detectFeedFormatFromXml('<Feed><Object><ExternalId>1</ExternalId></Object></Feed>'), 'CIAN_XML');
  assert.equal(detectFeedFormatFromXml(makeStoneCianLikeRealtyFeedXml()), 'CIAN_XML');
  assert.equal(detectFeedFormatFromXml(makeIndexAvitoXml()), 'AVITO_XML');
  assert.equal(detectFeedFormatFromXml(makeFskXml()), 'FSK_XML');
  assert.equal(detectFeedFormatFromXml(readFixture('tekta.xml')), 'TEKTA_XML');
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

test('analyzeFeedSourceInput auto analyzes every supported index XML format', async () => {
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

  assert.equal(result.discovery, null);
  assert.equal(result.analysis.format, 'YANDEX_REALTY');
  assert.equal(result.analysis.unitsCount, 3);
  assert.equal(result.analysis.warningsCount, 1);
  assert.deepEqual(
    result.analysis.objects.map((object) => [object.title, object.unitsCount]).sort(([leftTitle], [rightTitle]) =>
      leftTitle.localeCompare(rightTitle, 'ru'),
    ),
    [
      ['Лаврушинский', 1],
      ['Муза', 1],
      ['Avito ЖК 1234567', 1],
    ],
  );
  assert.equal(result.analysis.warnings[0].code, 'INDEX_XML_FAILED');
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

test('analyzeFeedSourceInput reads public Google Sheets index rows with object names', async () => {
  const sheetUrl = 'https://docs.google.com/spreadsheets/d/sheet-id/edit?gid=123#gid=123';
  const csvUrl = 'https://docs.google.com/spreadsheets/d/sheet-id/export?format=csv&gid=123';
  const cityzenUrl = 'https://feeds.test/cityzen.xml';
  const oneUrl = 'https://feeds.test/one.xml';
  const responses = new Map([
    [
      csvUrl,
      [
        'ЖК,Фид',
        `"ЖК Ситидзен","${cityzenUrl}"`,
        `"ЖК Оне","${oneUrl}"`,
      ].join('\n'),
    ],
    [cityzenUrl, makeIndexCianXml('cityzen-1', 'Feed Cityzen')],
    [oneUrl, makeIndexCianXml('one-1', 'Feed One')],
  ]);

  const result = await analyzeFeedSourceInput({
    format: 'AUTO',
    sourceKind: 'INDEX_URL',
    url: sheetUrl,
    xmlFetcher: async (url) => responses.get(url),
  });

  assert.equal(result.discovery, null);
  assert.deepEqual(
    result.analysis.objects.map((object) => [object.title, object.filterJson]),
    [
      ['ЖК Оне', { feedIndexSourceUrls: [oneUrl] }],
      ['ЖК Ситидзен', { feedIndexSourceUrls: [cityzenUrl] }],
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
  assert.equal(normalizeFeedUnitStatus('unavailable').status, 'ARCHIVED');
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
