import type { ObjectLocation, RealEstateObjectDetail } from '@platforma/shared';

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

const emptyValueLabel = 'Не указано';
const emptyContentSectionLabel = 'Не заполнено';

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
      value: formatPrice(object.priceFrom),
    },
    {
      label: 'Застройщик',
      value: object.developer?.name ?? emptyValueLabel,
    },
    {
      label: 'За метр от',
      value: formatPrice(object.pricePerMeterFrom),
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
      label: 'КРТ',
      value: object.krtName ?? emptyValueLabel,
    },
    {
      label: 'Высота потолков',
      value: object.ceilingHeight ?? emptyValueLabel,
    },
    {
      label: 'Срок сдачи',
      value: formatCompletion(object.completionYear, object.completionQuarter),
    },
    {
      label: 'Количество квартир',
      value: object.apartmentsCountText ?? emptyValueLabel,
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

export function formatCompletion(year: number | null, quarter: number | null) {
  if (!year) {
    return emptyValueLabel;
  }

  return quarter ? `${quarter} кв. ${year}` : String(year);
}

function getTextParagraphs(value: string | null | undefined) {
  return (value ?? '')
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}
