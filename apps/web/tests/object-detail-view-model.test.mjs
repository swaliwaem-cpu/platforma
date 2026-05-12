import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatCompletion,
  formatPrice,
  getObjectContentSections,
  getObjectLocationLine,
  getObjectParameterRows,
} from '../src/objects/objectDetailViewModel.ts';

const districtLocation = {
  id: 'district-1',
  name: 'Пресненский',
  type: 'DISTRICT',
};

const areaLocation = {
  id: 'area-1',
  name: 'Москва-Сити',
  type: 'AREA',
};

function createObject(overrides = {}) {
  return {
    priceFrom: null,
    pricePerMeterFrom: null,
    completionYear: null,
    completionQuarter: null,
    developer: null,
    krtName: null,
    apartmentAreaRange: null,
    ceilingHeight: null,
    propertyClass: null,
    floorRange: null,
    apartmentsCountText: null,
    primaryLocation: null,
    locations: [],
    ...overrides,
  };
}

test('getObjectLocationLine returns district and area line with fallback', () => {
  assert.deepEqual(
    getObjectLocationLine(
      createObject({
        primaryLocation: districtLocation,
        locations: [districtLocation, areaLocation],
      }),
    ),
    {
      district: districtLocation,
      areas: [areaLocation],
      line: 'Пресненский / Москва-Сити',
    },
  );

  assert.equal(getObjectLocationLine(createObject()).line, 'Район и окружение не указаны');
});

test('getObjectParameterRows returns ten rows in public order', () => {
  const rows = getObjectParameterRows(
    createObject({
      priceFrom: '12000000',
      developer: { name: 'Level Group' },
      krtName: 'Большое Сити',
      apartmentAreaRange: 'От 35 м²',
      ceilingHeight: '3,1 метра',
      pricePerMeterFrom: '350000',
      completionYear: 2027,
      completionQuarter: 1,
      propertyClass: 'Премиум-класс',
      floorRange: '8 - 25 этажей',
      apartmentsCountText: '672 квартиры',
    }),
  );

  assert.deepEqual(
    rows.map((row) => row.label),
    [
      'Цена от',
      'Застройщик',
      'КРТ',
      'Площадь квартир',
      'Высота потолков',
      'За метр от',
      'Срок сдачи',
      'Класс недвижимости',
      'Этажность',
      'Количество квартир',
    ],
  );

  assert.deepEqual(
    rows.map((row) => row.value),
    [
      formatPrice('12000000'),
      'Level Group',
      'Большое Сити',
      'От 35 м²',
      '3,1 метра',
      formatPrice('350000'),
      '1 кв. 2027',
      'Премиум-класс',
      '8 - 25 этажей',
      '672 квартиры',
    ],
  );
});

test('format helpers use neutral empty fallback', () => {
  assert.equal(formatPrice(null), 'Не указано');
  assert.equal(formatCompletion(null, null), 'Не указано');
});

test('getObjectContentSections returns public content sections with empty fallback', () => {
  const sections = getObjectContentSections(
    createObject({
      architectureDescription: 'Архитектурный код\n\nЛобби и фасады',
      infrastructureDescription: '  ',
      fillingDescription: null,
    }),
  );

  assert.deepEqual(
    sections.map((section) => section.label),
    ['Архитектура', 'Инфраструктура', 'Наполнение'],
  );

  assert.deepEqual(sections[0], {
    label: 'Архитектура',
    paragraphs: ['Архитектурный код', 'Лобби и фасады'],
    isEmpty: false,
  });
  assert.deepEqual(sections[1], {
    label: 'Инфраструктура',
    paragraphs: ['Не заполнено'],
    isEmpty: true,
  });
  assert.deepEqual(sections[2], {
    label: 'Наполнение',
    paragraphs: ['Не заполнено'],
    isEmpty: true,
  });
});
