const test = require('node:test');
const assert = require('node:assert/strict');
const { ObjectStatus } = require('@prisma/client');

const {
  collectManualObjectOverrides,
  collectManualObjectOverrideFields,
  resolveImportedObjectData,
} = require('../dist/importer.js');

test('collectManualObjectOverrideFields reads admin object update changes field-by-field', () => {
  const fields = collectManualObjectOverrideFields([
    {
      changes: {
        address: { from: null, to: 'Потаповский переулок, 5с4' },
        latitude: { from: '59.841541', to: '55.761614' },
        longitude: { from: '30.225039', to: '37.64136' },
        unknownField: { from: 'old', to: 'new' },
      },
    },
    {
      changes: {
        metroStationIds: { from: [], to: ['62535cf3-a046-4e37-a6df-121f398d3425'] },
      },
    },
  ]);

  assert.deepEqual([...fields].sort(), ['address', 'latitude', 'longitude', 'metroStationIds']);
});

test('resolveImportedObjectData keeps manually edited admin fields over WordPress values', () => {
  const existingObject = {
    wpPostId: 19356,
    title: 'Клубный дом «Чистые Пруды»',
    slug: 'klubnyj-dom-chistye-prudy',
    status: ObjectStatus.PUBLISHED,
    description: 'Manual description',
    architectureDescription: null,
    infrastructureDescription: null,
    fillingDescription: null,
    shortDescription: null,
    priceFrom: '275040000',
    pricePerMeterFrom: '2086232',
    completionYear: 2025,
    completionQuarter: null,
    address: 'Потаповский переулок, 5с4',
    latitude: '55.761614',
    longitude: '37.64136',
    featuresJson: {},
    developerId: 'f114fdfc-0478-47c8-a1ed-e614a8499108',
    primaryLocationId: 'cc0580d8-a670-47ff-8f10-d5c4d2522184',
    publishedAt: new Date('2024-04-14T01:59:48.000Z'),
  };
  const mappedObject = {
    wpPostId: 19356,
    title: 'Клубный дом «Чистые Пруды»',
    slug: 'klubnyj-dom-chistye-prudy',
    status: ObjectStatus.PUBLISHED,
    description: 'WordPress description',
    architectureDescription: null,
    infrastructureDescription: null,
    fillingDescription: null,
    shortDescription: null,
    priceFrom: '280000000',
    pricePerMeterFrom: '2100000',
    completionYear: 2025,
    completionQuarter: null,
    address: null,
    latitude: '59.841541',
    longitude: '30.225039',
    featuresJson: { wp: { postId: 19356 } },
    publishedAt: new Date('2024-04-14T01:59:48.000Z'),
  };

  const data = resolveImportedObjectData({
    object: mappedObject,
    slug: mappedObject.slug,
    existingObject,
    developerId: 'wordpress-developer-id',
    primaryLocationId: 'wordpress-primary-location-id',
    manualOverrideFields: new Set(['address', 'latitude', 'longitude']),
  });

  assert.equal(data.address, 'Потаповский переулок, 5с4');
  assert.equal(data.latitude, '55.761614');
  assert.equal(data.longitude, '37.64136');
  assert.equal(data.description, 'WordPress description');
  assert.equal(data.priceFrom, '280000000');
  assert.equal(data.developerId, 'wordpress-developer-id');
  assert.equal(data.primaryLocationId, 'wordpress-primary-location-id');
});

test('resolveImportedObjectData restores latest admin values from audit logs after an old import overwrote them', () => {
  const existingObject = {
    wpPostId: 19356,
    title: 'Клубный дом «Чистые Пруды»',
    slug: 'klubnyj-dom-chistye-prudy',
    status: ObjectStatus.PUBLISHED,
    description: 'Manual description',
    architectureDescription: null,
    infrastructureDescription: null,
    fillingDescription: null,
    shortDescription: null,
    priceFrom: '275040000',
    pricePerMeterFrom: '2086232',
    completionYear: 2025,
    completionQuarter: null,
    address: null,
    latitude: '59.841541',
    longitude: '30.225039',
    featuresJson: {},
    developerId: 'f114fdfc-0478-47c8-a1ed-e614a8499108',
    primaryLocationId: 'cc0580d8-a670-47ff-8f10-d5c4d2522184',
    publishedAt: new Date('2024-04-14T01:59:48.000Z'),
  };
  const mappedObject = {
    wpPostId: 19356,
    title: 'Клубный дом «Чистые Пруды»',
    slug: 'klubnyj-dom-chistye-prudy',
    status: ObjectStatus.PUBLISHED,
    description: 'WordPress description',
    architectureDescription: null,
    infrastructureDescription: null,
    fillingDescription: null,
    shortDescription: null,
    priceFrom: '280000000',
    pricePerMeterFrom: '2100000',
    completionYear: 2025,
    completionQuarter: null,
    address: null,
    latitude: '59.841541',
    longitude: '30.225039',
    featuresJson: { wp: { postId: 19356 } },
    publishedAt: new Date('2024-04-14T01:59:48.000Z'),
  };
  const manualOverrides = collectManualObjectOverrides([
    {
      changes: {
        address: { from: null, to: 'Потаповский переулок, 5с4' },
        latitude: { from: '59.841541', to: '55.761614' },
        longitude: { from: '30.225039', to: '37.64136' },
      },
    },
  ]);

  const data = resolveImportedObjectData({
    object: mappedObject,
    slug: mappedObject.slug,
    existingObject,
    developerId: 'wordpress-developer-id',
    primaryLocationId: 'wordpress-primary-location-id',
    manualOverrideFields: manualOverrides.fields,
    manualOverrideValues: manualOverrides.values,
  });

  assert.equal(data.address, 'Потаповский переулок, 5с4');
  assert.equal(data.latitude, '55.761614');
  assert.equal(data.longitude, '37.64136');
});
