import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findFeedDeveloperSuggestion,
  findFeedObjectSuggestion,
  normalizeFeedMatchText,
} from '../src/admin/feedSourceMatching.ts';

const developerCity = {
  id: 'developer-city',
  wpTermId: null,
  name: 'Город Девелопмент',
  slug: 'city-development',
};

const developerOne = {
  id: 'developer-one',
  wpTermId: null,
  name: 'One Developer',
  slug: 'one-developer',
};

const developerPrivate = {
  id: 'developer-private',
  wpTermId: null,
  name: 'Private Developer',
  slug: 'private-developer',
};

function createObject(id, title, developer, slug = id) {
  return {
    id,
    title,
    slug,
    status: 'PUBLISHED',
    developer,
  };
}

function createFeedObject(overrides = {}) {
  return {
    title: 'Feed object',
    projectNames: [],
    externalIds: [],
    buildingNames: [],
    yandexBuildingIds: [],
    yandexHouseIds: [],
    avitoDevelopmentIds: [],
    addresses: [],
    filterJson: {},
    unitsCount: 1,
    ...overrides,
  };
}

function createAnalysis(objects, developerName = null) {
  return {
    format: 'CIAN_XML',
    developerName,
    unitsCount: 1,
    objects,
    warningsCount: 0,
    warnings: [],
  };
}

test('normalizeFeedMatchText keeps translit aliases comparable', () => {
  assert.equal(normalizeFeedMatchText('ЖК «Ситидзен»'), 'ситидзен');
  assert.equal(normalizeFeedMatchText('CITYZEN'), 'cityzen');
});

test('findFeedObjectSuggestion matches ЖК by translit and aliases', () => {
  const objects = [
    createObject('cityzen', 'ЖК Ситидзен', developerCity),
    createObject('one', 'ЖК Оне', developerOne),
  ];

  assert.equal(
    findFeedObjectSuggestion(createFeedObject({ title: 'Cityzen' }), objects),
    'cityzen',
  );
  assert.equal(
    findFeedObjectSuggestion(createFeedObject({ projectNames: ['ONE'] }), objects),
    'one',
  );
});

test('findFeedObjectSuggestion matches common latin feed names to Russian ЖК titles', () => {
  const objects = [
    createObject('city-bay', 'ЖК Сити Бэй', developerCity, 'object-city-bay'),
    createObject('veer', 'Веер', developerCity, 'object-veer'),
    createObject('cet', 'СЕТ', developerCity, 'object-cet'),
  ];

  assert.equal(
    findFeedObjectSuggestion(createFeedObject({ title: 'City Bay' }), objects),
    'city-bay',
  );
  assert.equal(
    findFeedObjectSuggestion(createFeedObject({ projectNames: ['Beep'] }), objects),
    'veer',
  );
  assert.equal(
    findFeedObjectSuggestion(createFeedObject({ projectNames: ['CET'] }), objects),
    'cet',
  );
});

test('findFeedObjectSuggestion treats Beep as visual latin spelling for Веер', () => {
  assert.equal(
    findFeedObjectSuggestion(createFeedObject({ title: 'Beep' }), [
      createObject('veer-2', 'Веер 2', developerCity, 'object-veer-2'),
    ]),
    'veer-2',
  );

  assert.equal(
    findFeedObjectSuggestion(createFeedObject({ title: 'Beep 2' }), [
      createObject('veer', 'Веер', developerCity, 'object-veer'),
      createObject('veer-2', 'Веер 2', developerCity, 'object-veer-2'),
    ]),
    'veer-2',
  );

  assert.equal(
    findFeedObjectSuggestion(createFeedObject({ title: 'Beep' }), [
      createObject('bip', 'Бип', developerCity, 'object-bip'),
      createObject('veer', 'Веер', developerCity, 'object-veer'),
    ]),
    'veer',
  );
});

test('findFeedObjectSuggestion picks the best real MR object among aliases and duplicates', () => {
  const mrObjects = [
    createObject('cityzen-latin', 'Жилой квартал CITYZEN', developerCity, 'zhiloj-kompleks-cityzen'),
    createObject('cityzen-cyrillic', 'Жилой квартал СИТИДЗЕН', developerCity, 'zhk-cityzen'),
    createObject('veer', 'Жилой комплекс VEER (ЖК Веер)', developerCity, 'zhiloj-kvartal-veer'),
    createObject('veer-2', 'Жилой комплекс Веер 2', developerCity, 'veer-2'),
    createObject('jois', 'Жилой комплекс JOIS (Джойс)', developerCity, 'zhiloj-kompleks-jois'),
  ];

  assert.equal(findFeedObjectSuggestion(createFeedObject({ title: 'Cityzen' }), mrObjects), 'cityzen-latin');
  assert.equal(findFeedObjectSuggestion(createFeedObject({ title: 'Beep' }), mrObjects), 'veer');
  assert.equal(findFeedObjectSuggestion(createFeedObject({ title: 'Beep 2' }), mrObjects), 'veer-2');
  assert.equal(findFeedObjectSuggestion(createFeedObject({ title: 'JOIS' }), mrObjects), 'jois');
});

test('findFeedObjectSuggestion prefers the exact base object over a longer partial match', () => {
  const objects = [
    createObject('one', 'ЖК Оне', developerOne),
    createObject('one-tower', 'One Tower', developerOne),
  ];

  assert.equal(findFeedObjectSuggestion(createFeedObject({ title: 'ONE' }), objects), 'one');
});

test('findFeedDeveloperSuggestion derives developer from matched ЖК names', () => {
  const objects = [
    createObject('cityzen', 'ЖК Ситидзен', developerCity),
    createObject('one', 'ЖК Оне', developerOne),
  ];

  assert.equal(
    findFeedDeveloperSuggestion(createAnalysis([createFeedObject({ title: 'cityzen' })]), [developerCity, developerOne], objects),
    'developer-city',
  );
});

test('findFeedDeveloperSuggestion derives developer from latin feed ЖК names in one developer portfolio', () => {
  const objects = [
    createObject('city-bay', 'ЖК Сити Бэй', developerCity, 'object-city-bay'),
    createObject('veer', 'Веер', developerCity, 'object-veer'),
    createObject('one', 'ЖК Оне', developerOne),
  ];

  assert.equal(
    findFeedDeveloperSuggestion(
      createAnalysis([
        createFeedObject({ title: 'City Bay' }),
        createFeedObject({ title: 'Beep' }),
      ]),
      [developerCity, developerOne],
      objects,
    ),
    'developer-city',
  );
});

test('findFeedDeveloperSuggestion derives dominant developer when one linked ЖК belongs elsewhere', () => {
  const objects = [
    createObject('city-bay', 'Жилой комплекс Сити Бэй', developerCity, 'city-bay-siti-bej'),
    createObject('veer', 'Жилой комплекс VEER (ЖК Веер)', developerCity, 'zhiloj-kvartal-veer'),
    createObject('cet', 'ЖК СЕТ', developerCity, 'zhiloj-kompleks-set'),
    createObject('jois', 'Жилой комплекс JOIS (Джойс)', developerCity, 'zhiloj-kompleks-jois'),
    createObject('one', 'Жилой комплекс ОНЕ', developerPrivate, 'one'),
  ];

  assert.equal(
    findFeedDeveloperSuggestion(
      createAnalysis([
        createFeedObject({ title: 'City Bay' }),
        createFeedObject({ title: 'Beep' }),
        createFeedObject({ title: 'CET' }),
        createFeedObject({ title: 'JOIS' }),
        createFeedObject({ title: 'One' }),
      ]),
      [developerCity, developerPrivate],
      objects,
    ),
    'developer-city',
  );
});

test('findFeedDeveloperSuggestion does not guess developer across multiple matched developers', () => {
  const objects = [
    createObject('cityzen', 'ЖК Ситидзен', developerCity),
    createObject('one', 'ЖК Оне', developerOne),
  ];

  assert.equal(
    findFeedDeveloperSuggestion(
      createAnalysis([
        createFeedObject({ title: 'cityzen' }),
        createFeedObject({ title: 'one' }),
      ]),
      [developerCity, developerOne],
      objects,
    ),
    '',
  );
});
