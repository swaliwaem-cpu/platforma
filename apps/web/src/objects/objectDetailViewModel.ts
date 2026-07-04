import type { FeedUnit, FeedUnitStatus, FeedUnitType, ObjectLocation, RealEstateObjectDetail } from '@platforma/shared';

export type FeatureRow = {
  label: string;
  value: string;
};

export type ObjectContentSection = {
  label: string;
  paragraphs: string[];
  isEmpty: boolean;
};

export type DisplayLocation = Pick<ObjectLocation, 'id' | 'name' | 'type'>;

export type ObjectLocationLine = {
  district: DisplayLocation | null;
  areas: DisplayLocation[];
  line: string;
};

export type ObjectFeedUnitSortBy =
  | 'title'
  | 'status'
  | 'price'
  | 'discountPrice'
  | 'pricePerMeter'
  | 'area'
  | 'rooms'
  | 'floor'
  | 'building';
export type ObjectFeedUnitSortDirection = 'asc' | 'desc';

export type InitialObjectFeedUnitFilters = {
  priceMin: string;
  priceMax: string;
  pricePerMeterMin: string;
  pricePerMeterMax: string;
  rooms: string;
  floorMin: string;
  floorMax: string;
};

export const feedUnitStatusLabels: Record<FeedUnitStatus, string> = {
  AVAILABLE: 'Доступен',
  BOOKED: 'Забронирован',
  RESERVED: 'Резерв',
  SOLD: 'Продан',
  ARCHIVED: 'Архив',
  UNKNOWN: 'Неизвестно',
};

export const feedUnitTypeLabels: Record<FeedUnitType, string> = {
  RESIDENTIAL: 'Жилой',
  COMMERCIAL: 'Коммерческий',
};

export const publicFeedUnitStatuses: FeedUnitStatus[] = [
  'AVAILABLE',
  'BOOKED',
  'RESERVED',
];

export const feedUnitStatusFilterOptions = publicFeedUnitStatuses.map((status) => ({
  value: status,
  label: feedUnitStatusLabels[status],
}));

export const feedUnitTypeFilterOptions: {
  value: FeedUnitType;
  label: string;
}[] = [
  { value: 'RESIDENTIAL', label: feedUnitTypeLabels.RESIDENTIAL },
  { value: 'COMMERCIAL', label: feedUnitTypeLabels.COMMERCIAL },
];

export const feedUnitRoomFilterOptions = [
  { value: '0', label: 'Студия' },
  { value: '1', label: '1 спальня' },
  { value: '2', label: '2 спальни' },
  { value: '3', label: '3 спальни' },
  { value: '4', label: '4 спальни' },
  { value: '5', label: '5 спален' },
];

const emptyValueLabel = 'Не указано';
const emptyContentSectionLabel = 'Не заполнено';
const ceilingHeightPrefixPattern = /^от(?:\.|\s|$)\s*/iu;
const ceilingHeightUnitPattern = /\s*(?:м|метр(?:а|ов)?\.?)\s*$/iu;

export function getObjectContentSections(object: RealEstateObjectDetail): ObjectContentSection[] {
  return [
    {
      label: 'Архитектура',
      value: object.architectureDescription,
    },
    {
      label: 'Инфраструктура',
      value: object.infrastructureDescription,
    },
    {
      label: 'Наполнение',
      value: object.fillingDescription,
    },
  ].map((section) => {
    const paragraphs = getTextParagraphs(section.value);

    return {
      label: section.label,
      paragraphs: paragraphs.length > 0 ? paragraphs : [emptyContentSectionLabel],
      isEmpty: paragraphs.length === 0,
    };
  });
}

export function getObjectLocationLine(object: RealEstateObjectDetail): ObjectLocationLine {
  const district = getObjectDistrictLocation(object);
  const areas = getObjectAreaLocations(object);
  const parts = [
    district?.name ?? null,
    areas.length > 0 ? areas.map((location) => location.name).join(', ') : null,
  ].filter((part): part is string => Boolean(part));

  return {
    district,
    areas,
    line: parts.length > 0 ? parts.join(' / ') : 'Район и окружение не указаны',
  };
}

export function getObjectParameterRows(object: RealEstateObjectDetail): FeatureRow[] {
  return [
    {
      label: 'Цена от',
      value: formatPriceFrom(object.priceFrom),
    },
    {
      label: 'Застройщик',
      value: object.developer?.name ?? emptyValueLabel,
    },
    {
      label: 'За метр от',
      value: formatPricePerMeterFrom(object.pricePerMeterFrom),
    },
    {
      label: 'Класс недвижимости',
      value: object.propertyClass ?? emptyValueLabel,
    },
    {
      label: 'Площадь квартир',
      value: object.apartmentAreaRange ?? emptyValueLabel,
    },
    {
      label: 'Высота потолков',
      value: formatCeilingHeight(object.ceilingHeight),
    },
    {
      label: 'Срок сдачи',
      value: formatCompletion(object.completionYear, object.completionQuarter),
    },
    {
      label: 'Этажность',
      value: object.floorRange ?? emptyValueLabel,
    },
  ];
}

export function getLocationRows(object: RealEstateObjectDetail): FeatureRow[] {
  const rows: FeatureRow[] = [];
  const districtLocation = getObjectDistrictLocation(object);
  const areaLocations = getObjectAreaLocations(object);
  const otherLocations = getObjectOtherLocations(object);

  if (districtLocation) {
    rows.push({
      label: 'Район',
      value: districtLocation.name,
    });
  }

  if (areaLocations.length > 0) {
    rows.push({
      label: 'Окружение',
      value: areaLocations.map((location) => location.name).join(', '),
    });
  }

  if (otherLocations.length > 0) {
    rows.push({
      label: 'Дополнительно',
      value: otherLocations.map((location) => location.name).join(', '),
    });
  }

  return rows;
}

export function getObjectDistrictLocation(object: RealEstateObjectDetail): DisplayLocation | null {
  if (object.primaryLocation?.type === 'DISTRICT') {
    return object.primaryLocation;
  }

  return object.locations.find((location) => location.type === 'DISTRICT') ?? null;
}

export function getObjectAreaLocations(object: RealEstateObjectDetail): DisplayLocation[] {
  return uniqueLocationsById([
    ...(object.primaryLocation?.type === 'AREA' ? [object.primaryLocation] : []),
    ...object.locations.filter((location) => location.type === 'AREA'),
  ]);
}

function getObjectOtherLocations(object: RealEstateObjectDetail): DisplayLocation[] {
  return uniqueLocationsById([
    ...(object.primaryLocation?.type === 'CUSTOM' ? [object.primaryLocation] : []),
    ...object.locations.filter((location) => location.type === 'CUSTOM'),
  ]);
}

function uniqueLocationsById(locations: DisplayLocation[]) {
  const seenIds = new Set<string>();

  return locations.filter((location) => {
    if (seenIds.has(location.id)) {
      return false;
    }

    seenIds.add(location.id);
    return true;
  });
}

export function formatPrice(value: string | null) {
  if (!value) {
    return emptyValueLabel;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return value;
  }

  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 0,
    style: 'currency',
    currency: 'RUB',
  }).format(parsed);
}

export function formatPriceFrom(value: string | null) {
  if (!value) {
    return emptyValueLabel;
  }

  return `от ${formatPrice(value)}`;
}

export function formatPricePerMeterFrom(value: string | null) {
  if (!value) {
    return emptyValueLabel;
  }

  return `от ${formatPrice(value)}/м²`;
}

export function formatCeilingHeight(value: string | null) {
  if (!value) {
    return emptyValueLabel;
  }

  const normalizedValue = value.trim().replace(/\s+/g, ' ');

  if (!/^(?:от(?:\.|\s|$)|\d)/iu.test(normalizedValue)) {
    return normalizedValue;
  }

  const valueWithoutPrefix = normalizedValue.replace(ceilingHeightPrefixPattern, '').trim();
  const valueWithoutUnit = valueWithoutPrefix
    .replace(ceilingHeightUnitPattern, '')
    .trim()
    .replace(/(\d)\.(\d)/g, '$1,$2');

  return valueWithoutUnit ? `от ${valueWithoutUnit} м` : normalizedValue;
}

export function formatCompletion(year: number | null, quarter: number | null) {
  if (!year) {
    return emptyValueLabel;
  }

  return quarter ? `${quarter} кв. ${year}` : String(year);
}

export function sortFeedUnitsForDisplay(
  units: FeedUnit[],
  sortBy: ObjectFeedUnitSortBy,
  sortDirection: ObjectFeedUnitSortDirection,
) {
  const directionMultiplier = sortDirection === 'desc' ? -1 : 1;

  return [...units].sort((leftUnit, rightUnit) => {
    const result = compareFeedUnitsByField(leftUnit, rightUnit, sortBy);

    if (result !== 0) {
      return result * directionMultiplier;
    }

    return compareNullableText(leftUnit.title, rightUnit.title) || compareNullableText(leftUnit.id, rightUnit.id);
  });
}

export function getInitialObjectFeedUnitFiltersFromLocation(): InitialObjectFeedUnitFilters {
  const emptyFilters: InitialObjectFeedUnitFilters = {
    priceMin: '',
    priceMax: '',
    pricePerMeterMin: '',
    pricePerMeterMax: '',
    rooms: '',
    floorMin: '',
    floorMax: '',
  };

  if (typeof window === 'undefined') {
    return emptyFilters;
  }

  const params = new URLSearchParams(window.location.search);

  return {
    priceMin: sanitizeDecimalText(params.get('lotPriceMin') ?? ''),
    priceMax: sanitizeDecimalText(params.get('lotPriceMax') ?? ''),
    pricePerMeterMin: sanitizeDecimalText(params.get('lotPricePerMeterMin') ?? ''),
    pricePerMeterMax: sanitizeDecimalText(params.get('lotPricePerMeterMax') ?? ''),
    rooms: parseInitialObjectFeedUnitRooms(params.get('lotRooms')),
    floorMin: sanitizeIntegerText(params.get('lotFloorMin') ?? '', 3),
    floorMax: sanitizeIntegerText(params.get('lotFloorMax') ?? '', 3),
  };
}

export function makeRoomGroupExpansionKey(completionGroupKey: string, roomGroupKey: string) {
  return `${completionGroupKey}:${roomGroupKey}`;
}

export function formatFeedUnitRange(valueMin: string | null, valueMax: string | null, formatter: (value: string) => string) {
  if (!valueMin && !valueMax) {
    return emptyValueLabel;
  }

  if (valueMin && valueMax && valueMin !== valueMax) {
    return `${formatter(valueMin)} - ${formatter(valueMax)}`;
  }

  return formatter(valueMin ?? valueMax ?? '');
}

export function getFeedUnitRoomFilterValues(value: string) {
  const valueSet = new Set(
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

  return feedUnitRoomFilterOptions.filter((option) => valueSet.has(option.value)).map((option) => option.value);
}

export function formatFeedUnitRoomFilterValues(values: string[]) {
  const valueSet = new Set(values);

  return feedUnitRoomFilterOptions
    .filter((option) => valueSet.has(option.value))
    .map((option) => option.value)
    .join(',');
}

export function setOptionalParam(params: URLSearchParams, key: string, value: string) {
  if (value.trim()) {
    params.set(key, value);
  }
}

export function sanitizeIntegerText(value: string, maxLength: number) {
  return value.replace(/\D/g, '').slice(0, maxLength);
}

export function sanitizeDecimalText(value: string) {
  return value.replace(/[^\d,.]/g, '').replace(',', '.').slice(0, 15);
}

export function formatFeedUnitPrice(value: string | null, currency: string | null) {
  if (!value) {
    return 'По запросу';
  }

  if (currency && !['RUB', 'RUR'].includes(currency.toUpperCase())) {
    return `${formatNumber(Number(value))} ${currency}`;
  }

  return formatPrice(value);
}

export function formatFeedUnitDiscountPrice(unit: FeedUnit) {
  return formatFeedUnitPrice(unit.discountPrice ?? unit.price, unit.currency);
}

export function formatArea(value: string | null) {
  if (!value) {
    return 'Не указана';
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return `${value} м²`;
  }

  return `${formatNumber(parsed)} м²`;
}

export function formatFeedUnitPricePerMeter(unit: FeedUnit) {
  const pricePerMeter = getFeedUnitPricePerMeterValue(unit);

  return pricePerMeter === null ? 'По запросу' : formatFeedUnitPrice(String(pricePerMeter), unit.currency);
}

export function formatComputedFeedUnitPricePerMeter(unit: FeedUnit) {
  return formatFeedUnitPricePerMeter(unit);
}

export function hasFeedUnitRealDiscount(unit: FeedUnit) {
  if (!unit.price || !unit.discountPrice) {
    return false;
  }

  const price = Number(unit.price);
  const discountPrice = Number(unit.discountPrice);

  return Number.isFinite(price) && Number.isFinite(discountPrice) && price > 0 && discountPrice > 0 && discountPrice < price;
}

export function getObjectLotPriceSummary(unit: FeedUnit) {
  const hasRealDiscount = hasFeedUnitRealDiscount(unit);

  return {
    label: hasRealDiscount ? 'Цена со скидкой' : 'Цена',
    primaryPrice: formatFeedUnitPrice(hasRealDiscount ? unit.discountPrice : unit.price, unit.currency),
    secondaryPrice: hasRealDiscount ? formatFeedUnitPrice(unit.price, unit.currency) : null,
    secondaryPricePerMeter: hasRealDiscount ? formatFeedUnitBasePricePerMeter(unit) : null,
  };
}

export function formatFeedUnitCompletion(unit: FeedUnit) {
  if (!unit.completionYear) {
    return 'Не указан';
  }

  if (!unit.completionQuarter) {
    return String(unit.completionYear);
  }

  return `${unit.completionQuarter}кв ${unit.completionYear}`;
}

export function formatFeedUnitShortValue(value: string | null) {
  return value?.trim() || emptyValueLabel;
}

export function formatFeedUnitBuildingValue(value: string | null) {
  return value?.trim() || 'Корпус не указан';
}

export function getObjectLotFactRows(unit: FeedUnit) {
  return [
    {
      label: 'Цена за м²',
      value: formatComputedFeedUnitPricePerMeter(unit),
    },
    {
      label: 'Площадь',
      value: formatArea(unit.area),
    },
    {
      label: 'Тип лота',
      value: getUnitRoomsOrType(unit),
    },
    {
      label: 'Этаж',
      value: unit.floor === null ? 'Не указан' : String(unit.floor),
    },
    {
      label: 'Корпус/секция',
      value: formatBuildingSection(unit),
    },
    {
      label: 'Срок сдачи',
      value: formatFeedUnitCompletion(unit),
    },
    {
      label: 'Адрес',
      value: unit.address ?? 'Не указан',
    },
    {
      label: 'Статус',
      value: feedUnitStatusLabels[unit.status],
    },
  ];
}

export function getFeedUnitTitle(unit: FeedUnit) {
  return unit.title?.trim() || 'Лот без названия';
}

export function buildObjectLotPath(objectSlug: string, unitId: string) {
  return `/objects/${encodeURIComponent(objectSlug)}/lots/${encodeURIComponent(unitId)}`;
}

export function formatBuildingSection(unit: FeedUnit) {
  const building = unit.building ? `Корпус ${unit.building}` : null;
  const section = unit.section ? `Секция ${unit.section}` : null;
  const parts = [building, section].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(' / ') : 'Не указаны';
}

function getTextParagraphs(value: string | null | undefined) {
  return (value ?? '')
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function compareFeedUnitsByField(leftUnit: FeedUnit, rightUnit: FeedUnit, sortBy: ObjectFeedUnitSortBy) {
  if (sortBy === 'status') {
    return compareNullableText(feedUnitStatusLabels[leftUnit.status], feedUnitStatusLabels[rightUnit.status]);
  }

  if (sortBy === 'title') {
    return compareNullableText(getFeedUnitTitle(leftUnit), getFeedUnitTitle(rightUnit));
  }

  if (sortBy === 'building') {
    return (
      compareNullableText(formatBuildingSection(leftUnit), formatBuildingSection(rightUnit)) ||
      compareNullableNumber(leftUnit.floor, rightUnit.floor)
    );
  }

  if (sortBy === 'rooms') {
    return compareNullableNumber(leftUnit.rooms, rightUnit.rooms) || compareNullableText(leftUnit.type, rightUnit.type);
  }

  if (sortBy === 'price') {
    return compareNullableNumber(getEffectiveFeedUnitPrice(leftUnit), getEffectiveFeedUnitPrice(rightUnit));
  }

  if (sortBy === 'discountPrice') {
    return compareNullableNumber(getEffectiveFeedUnitPrice(leftUnit), getEffectiveFeedUnitPrice(rightUnit));
  }

  if (sortBy === 'pricePerMeter') {
    return compareNullableNumber(getFeedUnitPricePerMeterValue(leftUnit), getFeedUnitPricePerMeterValue(rightUnit));
  }

  if (sortBy === 'area') {
    return compareNullableNumber(parseNullableNumber(leftUnit.area), parseNullableNumber(rightUnit.area));
  }

  return compareNullableNumber(leftUnit.floor, rightUnit.floor);
}

function compareNullableText(leftValue: string | null | undefined, rightValue: string | null | undefined) {
  if (!leftValue && !rightValue) {
    return 0;
  }

  if (!leftValue) {
    return 1;
  }

  if (!rightValue) {
    return -1;
  }

  return leftValue.localeCompare(rightValue, 'ru', { numeric: true, sensitivity: 'base' });
}

function compareNullableNumber(leftValue: number | null | undefined, rightValue: number | null | undefined) {
  if (leftValue === null || leftValue === undefined) {
    return rightValue === null || rightValue === undefined ? 0 : 1;
  }

  if (rightValue === null || rightValue === undefined) {
    return -1;
  }

  return leftValue - rightValue;
}

function parseInitialObjectFeedUnitRooms(value: string | null) {
  return formatFeedUnitRoomFilterValues(getFeedUnitRoomFilterValues(value ?? ''));
}

function parseNullableNumber(value: string | null) {
  if (!value) {
    return null;
  }

  const parsedValue = Number(value);

  return Number.isFinite(parsedValue) ? parsedValue : null;
}

function getEffectiveFeedUnitPrice(unit: FeedUnit) {
  return parseNullableNumber(unit.effectivePrice) ?? parseNullableNumber(unit.discountPrice) ?? parseNullableNumber(unit.price);
}

function getFeedUnitPricePerMeterValue(unit: FeedUnit) {
  const effectivePricePerMeter = parseNullableNumber(unit.effectivePricePerMeter);

  if (effectivePricePerMeter !== null) {
    return effectivePricePerMeter;
  }

  const price = getEffectiveFeedUnitPrice(unit);
  const area = parseNullableNumber(unit.area);

  if (price !== null && area !== null && area > 0) {
    return price / area;
  }

  return parseNullableNumber(unit.discountPricePerMeter) ?? parseNullableNumber(unit.pricePerMeter);
}

function getFeedUnitBasePricePerMeterValue(unit: FeedUnit) {
  const pricePerMeter = parseNullableNumber(unit.pricePerMeter);

  if (pricePerMeter !== null) {
    return pricePerMeter;
  }

  const price = parseNullableNumber(unit.price);
  const area = parseNullableNumber(unit.area);

  if (price !== null && area !== null && area > 0) {
    return price / area;
  }

  return null;
}

function formatFeedUnitBasePricePerMeter(unit: FeedUnit) {
  const pricePerMeter = getFeedUnitBasePricePerMeterValue(unit);

  return pricePerMeter === null ? null : formatFeedUnitPrice(String(pricePerMeter), unit.currency);
}

export function getUnitRoomsOrType(unit: FeedUnit) {
  if (unit.type === 'RESIDENTIAL') {
    if (unit.rooms === 0 || (unit.rooms === null && isSeparateRoomsStudio(unit))) {
      return 'Студия';
    }

    if (unit.rooms) {
      return `${unit.rooms}-комн.`;
    }

    return unit.residentialDetails?.layoutType ?? feedUnitTypeLabels.RESIDENTIAL;
  }

  return unit.commercialDetails?.commercialType ?? feedUnitTypeLabels.COMMERCIAL;
}

function isSeparateRoomsStudio(unit: FeedUnit) {
  return unit.residentialDetails?.layoutType?.trim().toLocaleLowerCase('ru-RU') === 'раздельные';
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) {
    return emptyValueLabel;
  }

  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: value < 100 ? 1 : 0,
  }).format(value);
}
