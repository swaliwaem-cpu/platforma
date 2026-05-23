const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');

const {
  CianXmlFeedParser,
  YandexRealtyFeedParser,
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
