import type { ObjectStatus } from '@platforma/shared';

export type BooleanFilter = '' | 'true' | 'false';
export type CatalogStatusFilter = ObjectStatus | 'ALL';
export type CatalogViewMode = 'cards' | 'list';
export type CatalogSortField = 'createdAt' | 'priceFrom' | 'pricePerMeterFrom' | 'completionDate';
export type CatalogPageSize = 25 | 50 | 75;
export type SortDirection = 'asc' | 'desc';

export type CatalogFilters = {
  search: string;
  developerId: string;
  krtName: string;
  locationId: string;
  areaId: string;
  metroStationId: string;
  completionYear: string;
  completionQuarter: string;
  lotPriceMin: string;
  lotPriceMax: string;
  lotPricePerMeterMin: string;
  lotPricePerMeterMax: string;
  lotRooms: string;
  lotFloorMin: string;
  lotFloorMax: string;
  status: CatalogStatusFilter;
  hasPresentation: BooleanFilter;
  hasCoordinates: BooleanFilter;
  sortBy: CatalogSortField;
  sortDirection: SortDirection;
  page: number;
  limit: CatalogPageSize;
};

export const defaultFilters: CatalogFilters = {
  search: '',
  developerId: '',
  krtName: '',
  locationId: '',
  areaId: '',
  metroStationId: '',
  completionYear: '',
  completionQuarter: '',
  lotPriceMin: '',
  lotPriceMax: '',
  lotPricePerMeterMin: '',
  lotPricePerMeterMax: '',
  lotRooms: '',
  lotFloorMin: '',
  lotFloorMax: '',
  status: 'PUBLISHED',
  hasPresentation: '',
  hasCoordinates: '',
  sortBy: 'createdAt',
  sortDirection: 'desc',
  page: 1,
  limit: 25,
};

export const catalogPageSizeOptions = [25, 50, 75] as const;

export const catalogRoomOptions = [
  { value: '0', label: 'Студия' },
  { value: '1', label: '1 спальня' },
  { value: '2', label: '2 спальни' },
  { value: '3', label: '3 спальни' },
  { value: '4', label: '4 спальни' },
  { value: '5', label: '5 спален' },
];

export function parseCatalogFilters(queryString: string): CatalogFilters {
  const params = new URLSearchParams(queryString);

  return {
    search: parseSearchParam(params.get('search')),
    developerId: parseCatalogFilterIdParam(params.get('developerId')),
    krtName: parseTextParam(params.get('krtName')),
    locationId: parseCatalogFilterIdParam(params.get('locationId')),
    areaId: parseCatalogFilterIdParam(params.get('areaId')),
    metroStationId: parseCatalogFilterIdParam(params.get('metroStationId')),
    completionYear: sanitizeIntegerText(params.get('completionYear') ?? '', 4),
    completionQuarter: defaultFilters.completionQuarter,
    lotPriceMin: sanitizeDecimalText(params.get('lotPriceMin') ?? ''),
    lotPriceMax: sanitizeDecimalText(params.get('lotPriceMax') ?? ''),
    lotPricePerMeterMin: sanitizeDecimalText(params.get('lotPricePerMeterMin') ?? ''),
    lotPricePerMeterMax: sanitizeDecimalText(params.get('lotPricePerMeterMax') ?? ''),
    lotRooms: parseCatalogRoomsParam(params.get('lotRooms')),
    lotFloorMin: sanitizeIntegerText(params.get('lotFloorMin') ?? '', 3),
    lotFloorMax: sanitizeIntegerText(params.get('lotFloorMax') ?? '', 3),
    status: defaultFilters.status,
    hasPresentation: defaultFilters.hasPresentation,
    hasCoordinates: defaultFilters.hasCoordinates,
    sortBy: parseCatalogSortBy(params.get('sortBy')),
    sortDirection: parseCatalogSortDirection(params.get('sortDirection')),
    page: parsePositiveInteger(params.get('page'), 1),
    limit: parseCatalogPageSize(params.get('limit')),
  };
}

export function parseCatalogViewMode(queryString: string): CatalogViewMode {
  const params = new URLSearchParams(queryString);

  return params.get('view') === 'list' ? 'list' : 'cards';
}

export function buildCatalogQuery(filters: CatalogFilters, viewMode: CatalogViewMode = 'cards') {
  const params = new URLSearchParams();

  setSearchParam(params, 'search', filters.search);
  setParam(params, 'developerId', filters.developerId);
  setParam(params, 'krtName', filters.krtName);
  setParam(params, 'locationId', filters.locationId);
  setParam(params, 'areaId', filters.areaId);
  setParam(params, 'metroStationId', filters.metroStationId);
  setParam(params, 'completionYear', filters.completionYear);
  setParam(params, 'lotPriceMin', filters.lotPriceMin);
  setParam(params, 'lotPriceMax', filters.lotPriceMax);
  setParam(params, 'lotPricePerMeterMin', filters.lotPricePerMeterMin);
  setParam(params, 'lotPricePerMeterMax', filters.lotPricePerMeterMax);
  setParam(params, 'lotRooms', filters.lotRooms);
  setParam(params, 'lotFloorMin', filters.lotFloorMin);
  setParam(params, 'lotFloorMax', filters.lotFloorMax);
  setCatalogSortParams(params, filters);

  if (filters.page > 1) {
    params.set('page', String(filters.page));
  }

  if (filters.limit !== defaultFilters.limit) {
    params.set('limit', String(filters.limit));
  }

  if (viewMode === 'list') {
    params.set('view', viewMode);
  }

  const query = params.toString();

  return query ? `?${query}` : '';
}

export function buildCatalogObjectHref(slug: string, filters: CatalogFilters) {
  return `/objects/${encodeURIComponent(slug)}${buildCatalogLotFilterQuery(filters)}`;
}

export function buildCatalogLotFilterQuery(filters: CatalogFilters) {
  const params = new URLSearchParams();

  setParam(params, 'lotPriceMin', filters.lotPriceMin);
  setParam(params, 'lotPriceMax', filters.lotPriceMax);
  setParam(params, 'lotPricePerMeterMin', filters.lotPricePerMeterMin);
  setParam(params, 'lotPricePerMeterMax', filters.lotPricePerMeterMax);
  setParam(params, 'lotRooms', filters.lotRooms);
  setParam(params, 'lotFloorMin', filters.lotFloorMin);
  setParam(params, 'lotFloorMax', filters.lotFloorMax);

  const query = params.toString();

  return query ? `?${query}` : '';
}

export function hasActiveCatalogLotFilters(filters: CatalogFilters) {
  return [
    filters.lotPriceMin,
    filters.lotPriceMax,
    filters.lotPricePerMeterMin,
    filters.lotPricePerMeterMax,
    filters.lotRooms,
    filters.lotFloorMin,
    filters.lotFloorMax,
  ].some((value) => value.trim().length > 0);
}

export function countActiveAdvancedFilters(filters: CatalogFilters) {
  return [
    filters.developerId,
    filters.krtName,
    filters.locationId,
    filters.areaId,
    filters.metroStationId,
    filters.completionYear,
    filters.lotPriceMin,
    filters.lotPriceMax,
    filters.lotPricePerMeterMin,
    filters.lotPricePerMeterMax,
    filters.lotRooms,
    filters.lotFloorMin,
    filters.lotFloorMax,
  ].filter((value) => value.trim().length > 0).length;
}

export function buildObjectsParams(filters: CatalogFilters, includePage: boolean) {
  const params = new URLSearchParams({
    limit: includePage ? String(filters.limit) : '1000',
    sortBy: filters.sortBy,
    sortDirection: filters.sortDirection,
  });

  if (includePage) {
    params.set('page', String(filters.page));
  }

  setSearchParam(params, 'search', filters.search);
  setParam(params, 'developerId', filters.developerId);
  setParam(params, 'krtName', filters.krtName);
  setParam(params, 'locationId', filters.locationId);
  setParam(params, 'areaId', filters.areaId);
  setParam(params, 'metroStationId', filters.metroStationId);
  setParam(params, 'completionYear', filters.completionYear);
  setParam(params, 'lotPriceMin', filters.lotPriceMin);
  setParam(params, 'lotPriceMax', filters.lotPriceMax);
  setParam(params, 'lotPricePerMeterMin', filters.lotPricePerMeterMin);
  setParam(params, 'lotPricePerMeterMax', filters.lotPricePerMeterMax);
  setParam(params, 'lotRooms', filters.lotRooms);
  setParam(params, 'lotFloorMin', filters.lotFloorMin);
  setParam(params, 'lotFloorMax', filters.lotFloorMax);

  if (filters.status !== 'ALL') {
    params.set('status', filters.status);
  }

  return params;
}

export function getDefaultCatalogSortDirection(sortBy: CatalogSortField): SortDirection {
  return sortBy === 'completionDate' ? 'asc' : 'desc';
}

export function toggleCatalogSortDirection(direction: SortDirection): SortDirection {
  return direction === 'asc' ? 'desc' : 'asc';
}

export function getCatalogFilterIdValues(value: string) {
  return Array.from(
    new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

export function formatCatalogFilterIdValues(values: string[]) {
  return getCatalogFilterIdValues(values.join(',')).join(',');
}

export function getRoomFilterValues(value: string) {
  const valueSet = new Set(
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

  return catalogRoomOptions.filter((option) => valueSet.has(option.value)).map((option) => option.value);
}

export function formatRoomFilterValues(values: string[]) {
  const valueSet = new Set(values);

  return catalogRoomOptions
    .filter((option) => valueSet.has(option.value))
    .map((option) => option.value)
    .join(',');
}

export function parsePositiveInteger(value: string | null, fallback: number) {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
}

export function sanitizeIntegerText(value: string, maxLength: number) {
  return value.replace(/\D/g, '').slice(0, maxLength);
}

export function sanitizeDecimalText(value: string) {
  return value.replace(/[^\d,.]/g, '').replace(',', '.').slice(0, 15);
}

function setParam(params: URLSearchParams, key: string, value: string) {
  const normalizedValue = value.trim();

  if (normalizedValue) {
    params.set(key, normalizedValue);
  }
}

function setSearchParam(params: URLSearchParams, key: string, value: string) {
  if (value.trim()) {
    params.set(key, value);
  }
}

function setCatalogSortParams(params: URLSearchParams, filters: CatalogFilters) {
  const isDefaultSort =
    filters.sortBy === defaultFilters.sortBy && filters.sortDirection === defaultFilters.sortDirection;

  if (!isDefaultSort) {
    params.set('sortBy', filters.sortBy);
    params.set('sortDirection', filters.sortDirection);
  }
}

function parseCatalogSortBy(value: string | null): CatalogSortField {
  if (value === 'priceFrom' || value === 'pricePerMeterFrom' || value === 'completionDate' || value === 'createdAt') {
    return value;
  }

  return defaultFilters.sortBy;
}

function parseCatalogSortDirection(value: string | null): SortDirection {
  return value === 'asc' || value === 'desc' ? value : defaultFilters.sortDirection;
}

export function parseCatalogPageSize(value: string | null): CatalogPageSize {
  const parsed = Number(value);

  return catalogPageSizeOptions.includes(parsed as CatalogPageSize)
    ? (parsed as CatalogPageSize)
    : defaultFilters.limit;
}

function parseTextParam(value: string | null) {
  return value?.trim() ?? '';
}

function parseSearchParam(value: string | null) {
  return value ?? '';
}

function parseCatalogRoomsParam(value: string | null) {
  return formatRoomFilterValues(getRoomFilterValues(value ?? ''));
}

function parseCatalogFilterIdParam(value: string | null) {
  return formatCatalogFilterIdValues(getCatalogFilterIdValues(value ?? ''));
}
