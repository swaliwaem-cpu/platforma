import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatCompletion,
  formatArea,
  formatFileSize,
  formatMediaCount,
  formatObjectFeedUpdatedAt,
  formatFeedUnitPrice,
  formatPrice,
  formatPriceFrom,
  formatPricePerMeterFrom,
  formatCeilingHeight,
  getCarouselImages,
  getDescriptionParagraphs,
  getExternalObjectUrl,
  getFeedMediaDownloadFileName,
  getFeedMediaTitle,
  getFeedUnitRoomFilterValues,
  getImageDownloadFileName,
  getObjectContentSections,
  getObjectLocationLine,
  getObjectLotFactRows,
  getObjectLotPriceSummary,
  getObjectParameterRows,
  hasFeedUnitRealDiscount,
  hasFeedMediaFile,
  buildObjectLotPath,
  formatFeedUnitRoomFilterValues,
  wrapCarouselIndex,
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

test('getObjectParameterRows excludes hidden public parameter rows', () => {
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
      'За метр от',
      'Класс недвижимости',
      'Площадь квартир',
      'Высота потолков',
      'Срок сдачи',
      'Этажность',
    ],
  );

  assert.deepEqual(
    rows.map((row) => row.value),
    [
      formatPriceFrom('12000000'),
      'Level Group',
      formatPricePerMeterFrom('350000'),
      'Премиум-класс',
      'От 35 м²',
      formatCeilingHeight('3,1 метра'),
      '1 кв. 2027',
      '8 - 25 этажей',
    ],
  );
});

test('format helpers use neutral empty fallback', () => {
  assert.equal(formatPrice(null), 'Не указано');
  assert.equal(formatPriceFrom('12000000'), `от ${formatPrice('12000000')}`);
  assert.equal(formatPricePerMeterFrom('350000'), `от ${formatPrice('350000')}/м²`);
  assert.equal(formatCeilingHeight('3,1 метра'), 'от 3,1 м');
  assert.equal(formatCeilingHeight(null), 'Не указано');
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

function createFeedUnit(overrides = {}) {
  return {
    id: 'unit-1',
    title: 'Апартамент 42',
    type: 'RESIDENTIAL',
    status: 'AVAILABLE',
    price: '12000000',
    discountPrice: null,
    effectivePrice: null,
    currency: 'RUB',
    area: '42.5',
    pricePerMeter: null,
    discountPricePerMeter: null,
    effectivePricePerMeter: null,
    rooms: 1,
    floor: 7,
    building: '1',
    section: '2',
    address: 'Москва',
    completionYear: 2027,
    completionQuarter: 2,
    residentialDetails: null,
    commercialDetails: null,
    media: [],
    ...overrides,
  };
}

test('object lot view model formats prices facts and paths', () => {
  const unit = createFeedUnit({
    discountPrice: '11000000',
    pricePerMeter: '282353',
  });

  assert.equal(formatArea('42.5'), '42,5 м²');
  assert.equal(formatFeedUnitPrice('12000000', 'RUB'), formatPrice('12000000'));
  assert.equal(formatFeedUnitPrice('900000', 'USD'), '900 000 USD');
  assert.equal(hasFeedUnitRealDiscount(unit), true);
  assert.deepEqual(getObjectLotPriceSummary(unit), {
    label: 'Цена со скидкой',
    primaryPrice: formatPrice('11000000'),
    secondaryPrice: formatPrice('12000000'),
    secondaryPricePerMeter: `${formatPrice('282353')}`,
  });
  assert.deepEqual(
    getObjectLotFactRows(unit).map((row) => row.label),
    ['Цена за м²', 'Площадь', 'Тип лота', 'Этаж', 'Корпус/секция', 'Срок сдачи', 'Адрес', 'Статус'],
  );
  assert.equal(buildObjectLotPath('level-michurinskiy', 'unit 1'), '/objects/level-michurinskiy/lots/unit%201');
});

test('object lot view model keeps legacy empty labels and fractional formatting', () => {
  const rows = getObjectLotFactRows(
    createFeedUnit({
      area: '42.55',
      completionYear: null,
      completionQuarter: null,
      floor: null,
      price: null,
      pricePerMeter: null,
    }),
  );

  assert.equal(rows.find((row) => row.label === 'Площадь')?.value, '42,6 м²');
  assert.equal(rows.find((row) => row.label === 'Этаж')?.value, 'Не указан');
  assert.equal(rows.find((row) => row.label === 'Срок сдачи')?.value, 'Не указан');
  assert.equal(rows.find((row) => row.label === 'Цена за м²')?.value, 'По запросу');
});

test('object feed room filters preserve known option order', () => {
  assert.deepEqual(getFeedUnitRoomFilterValues('2,0,unknown,2,5'), ['0', '2', '5']);
  assert.equal(formatFeedUnitRoomFilterValues(['5', '0', '2', '5']), '0,2,5');
});

test('object detail media helpers preserve carousel and file behavior', () => {
  const mediaWithFile = {
    id: 'media-1',
    label: 'Планировка',
    contentType: 'image/jpeg',
    file: {
      id: 'file-1',
      originalName: 'layout.jpg',
      mimeType: 'image/jpeg',
    },
  };
  const mediaWithoutFile = {
    id: 'media-2',
    label: null,
    contentType: 'image/png',
    file: null,
  };

  assert.equal(hasFeedMediaFile(mediaWithFile), true);
  assert.equal(hasFeedMediaFile(mediaWithoutFile), false);
  assert.equal(getFeedMediaTitle(mediaWithFile), 'Планировка');
  assert.equal(getFeedMediaTitle({ ...mediaWithFile, label: null }), 'layout.jpg');
  assert.equal(getFeedMediaTitle({ ...mediaWithoutFile, contentType: 'image/png' }), 'image/png');
  assert.equal(getFeedMediaDownloadFileName(mediaWithFile), 'layout.jpg');
  assert.equal(getFeedMediaDownloadFileName({ ...mediaWithFile, file: null, label: '  Рендер  ' }), 'Рендер');
  assert.equal(getFeedMediaDownloadFileName({ ...mediaWithoutFile, label: null }), 'original-media');
  assert.equal(wrapCarouselIndex(-1, 3), 2);
  assert.equal(wrapCarouselIndex(3, 3), 0);
  assert.equal(wrapCarouselIndex(1, 3), 1);
  assert.equal(wrapCarouselIndex(2, 0), 0);
});

test('object detail formatting helpers keep public labels and file names', () => {
  assert.equal(formatMediaCount(0), 'Нет');
  assert.equal(formatMediaCount(1), '1 файл');
  assert.equal(formatMediaCount(2), '2 файла');
  assert.equal(formatMediaCount(5), '5 файлов');
  assert.equal(formatObjectFeedUpdatedAt('2026-07-05T08:09:00'), '05.07.2026 08:09');
  assert.equal(formatObjectFeedUpdatedAt('not-a-date'), null);
  assert.equal(formatFileSize('512'), '1 КБ');
  assert.equal(formatFileSize('1536'), '2 КБ');
  assert.equal(formatFileSize(String(2.5 * 1024 * 1024)), '2.5 МБ');
  assert.equal(formatFileSize('unknown'), 'unknown');
  assert.equal(getImageDownloadFileName({ file: { originalName: ' cover.png ' } }, 'Object Title'), 'cover.png');
  assert.equal(getImageDownloadFileName({ file: { originalName: '  ' } }, 'Object Title'), 'Object Title.jpg');
  assert.equal(getImageDownloadFileName({ file: { originalName: null } }, '  '), 'object-image.jpg');
});

test('object detail content helpers keep description, gallery and external url behavior', () => {
  const firstImage = { id: 'image-1', isCover: false };
  const coverImage = { id: 'image-2', isCover: true };
  const thirdImage = { id: 'image-3', isCover: false };

  assert.deepEqual(
    getDescriptionParagraphs({
      description: 'Первый абзац\n\n  Второй абзац  \n\n\n',
    }),
    ['Первый абзац', 'Второй абзац'],
  );
  assert.deepEqual(getDescriptionParagraphs({ description: null }), []);
  assert.deepEqual(getCarouselImages({ images: [firstImage, coverImage, thirdImage] }), [coverImage, firstImage, thirdImage]);
  assert.deepEqual(getCarouselImages({ images: [] }), []);
  assert.equal(getExternalObjectUrl(' https://example.com/tour '), 'https://example.com/tour');
  assert.equal(getExternalObjectUrl('ftp://example.com/tour'), null);
  assert.equal(getExternalObjectUrl('not-url'), null);
});
