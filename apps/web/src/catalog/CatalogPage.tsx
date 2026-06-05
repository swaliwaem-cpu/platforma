import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from 'lucide-react';
import type {
  CatalogLinksResponse,
  DevelopersResponse,
  LocationsResponse,
  MapObject,
  MapObjectsResponse,
  MetroStationsResponse,
  ObjectDeveloper,
  ObjectLocation,
  ObjectLocationLink,
  ObjectMetroStation,
  ObjectMetroStationLink,
  ObjectStatus,
  ObjectsResponse,
  PublicCatalogQuickLink,
  RealEstateObjectSummary,
} from '@platforma/shared';
import { matchesSearchVariants } from '@platforma/shared/search-normalization';

import { apiRequest } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';
import { MultiSelectDropdown } from '../components/MultiSelectDropdown';
import { SecureImage } from '../files/SecureImage';
import { formatCurrencyInputValue, getCurrencyInputBackspaceValue } from '../lib/numberInput';
import { resolveMapMarkerLabel } from '../map/mapMarkerLabels';
import { YandexMap, type YandexMapBounds, type YandexMapPoint } from '../map/YandexMap';
import floorPlanIconUrl from '../../../../floor-plan.svg';

type CatalogPageProps = {
  navigate: (nextPathname: string) => void;
  pathname: string;
};

type BooleanFilter = '' | 'true' | 'false';
type CatalogStatusFilter = ObjectStatus | 'ALL';
type CatalogViewMode = 'cards' | 'list';
type CatalogSortField = 'createdAt' | 'priceFrom' | 'pricePerMeterFrom' | 'completionDate';
type CatalogPageSize = 25 | 50 | 75;
type SortDirection = 'asc' | 'desc';

type CatalogFilters = {
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

type DirectoryState = {
  developers: ObjectDeveloper[];
  districtLocations: ObjectLocation[];
  areaLocations: ObjectLocation[];
  metroStations: ObjectMetroStation[];
};

type CatalogFeedFallbackObject = {
  priceFrom: string | null;
  pricePerMeterFrom: string | null;
  apartmentAreaRange: string | null;
  feedPriceFrom: string | null;
  feedPricePerMeterFrom: string | null;
  feedAreaRange: string | null;
};

const defaultFilters: CatalogFilters = {
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

const catalogPageSizeOptions = [25, 50, 75] as const;
const catalogFilterSearchResultLimit = 24;

const catalogRoomOptions = [
  { value: '0', label: 'Студия' },
  { value: '1', label: '1 спальня' },
  { value: '2', label: '2 спальни' },
  { value: '3', label: '3 спальни' },
  { value: '4', label: '4 спальни' },
  { value: '5', label: '5 спален' },
];

const objectStatusLabels: Record<ObjectStatus, string> = {
  DRAFT: 'Черновик',
  PUBLISHED: 'Опубликован',
  ARCHIVED: 'Архивный',
};

export function CatalogPage({ navigate, pathname }: CatalogPageProps) {
  const { accessToken } = useAuth();
  const [queryString, setQueryString] = useState(window.location.search);
  const filters = useMemo(() => parseCatalogFilters(queryString), [queryString]);
  const viewMode = useMemo(() => parseCatalogViewMode(queryString), [queryString]);
  const isCatalogRoute = pathname === '/catalog';
  const isMapView = pathname === '/catalog/map';
  const canShowCatalogQuickLinks = isCatalogRoute || isMapView;
  const [objects, setObjects] = useState<RealEstateObjectSummary[]>([]);
  const [mapObjects, setMapObjects] = useState<MapObject[]>([]);
  const [directories, setDirectories] = useState<DirectoryState>({
    developers: [],
    districtLocations: [],
    areaLocations: [],
    metroStations: [],
  });
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loadedThroughPage, setLoadedThroughPage] = useState(filters.page);
  const [mapTotal, setMapTotal] = useState(0);
  const [catalogLinks, setCatalogLinks] = useState<PublicCatalogQuickLink[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isMapLoading, setIsMapLoading] = useState(false);
  const [isDirectoriesLoading, setIsDirectoriesLoading] = useState(false);
  const [isCatalogLinksLoading, setIsCatalogLinksLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [catalogLinksError, setCatalogLinksError] = useState<string | null>(null);
  const objectsRequestIdRef = useRef(0);
  const mapObjectsRequestIdRef = useRef(0);

  useEffect(() => {
    const handlePopState = () => setQueryString(window.location.search);

    window.addEventListener('popstate', handlePopState);

    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    setQueryString(window.location.search);
  }, [pathname]);

  useEffect(() => {
    if (!accessToken) {
      return;
    }

    void loadDirectories();
  }, [accessToken]);

  useEffect(() => {
    let isCancelled = false;

    if (!accessToken || !canShowCatalogQuickLinks) {
      setCatalogLinks([]);
      setCatalogLinksError(null);
      setIsCatalogLinksLoading(false);
      return;
    }

    const catalogLinksAccessToken = accessToken;

    async function loadCatalogLinks() {
      setIsCatalogLinksLoading(true);
      setCatalogLinksError(null);

      try {
        const data = await apiRequest<CatalogLinksResponse>('/catalog-links', catalogLinksAccessToken);

        if (!isCancelled) {
          setCatalogLinks(data.items);
        }
      } catch (caughtError) {
        if (!isCancelled) {
          setCatalogLinksError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить ссылки каталога');
        }
      } finally {
        if (!isCancelled) {
          setIsCatalogLinksLoading(false);
        }
      }
    }

    void loadCatalogLinks();

    return () => {
      isCancelled = true;
    };
  }, [accessToken, canShowCatalogQuickLinks]);

  useEffect(() => {
    if (!accessToken || isMapView) {
      return;
    }

    void loadObjects();
  }, [accessToken, filters, isMapView]);

  useEffect(() => {
    if (!accessToken || !isMapView) {
      return;
    }

    void loadMapObjects();
  }, [accessToken, filters, isMapView]);

  async function loadDirectories() {
    if (!accessToken) {
      return;
    }

    setIsDirectoriesLoading(true);
    setDirectoryError(null);

    try {
      const [developers, districtLocations, areaLocations, metroStations] = await Promise.all([
        apiRequest<DevelopersResponse>('/developers?limit=500', accessToken),
        apiRequest<LocationsResponse>('/locations?type=DISTRICT&limit=500', accessToken),
        apiRequest<LocationsResponse>('/locations?type=AREA&limit=500', accessToken),
        apiRequest<MetroStationsResponse>('/metro?limit=500', accessToken),
      ]);

      setDirectories({
        developers: developers.items,
        districtLocations: districtLocations.items,
        areaLocations: areaLocations.items,
        metroStations: metroStations.items,
      });
    } catch (caughtError) {
      setDirectoryError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить справочники');
    } finally {
      setIsDirectoriesLoading(false);
    }
  }

  async function loadObjects() {
    if (!accessToken) {
      return;
    }

    const requestId = objectsRequestIdRef.current + 1;
    objectsRequestIdRef.current = requestId;

    setIsLoading(true);
    setError(null);
    setLoadMoreError(null);

    try {
      const params = buildObjectsParams(filters, true);
      const data = await apiRequest<ObjectsResponse>(`/objects?${params.toString()}`, accessToken);

      if (objectsRequestIdRef.current !== requestId) {
        return;
      }

      setObjects(data.items);
      setTotal(data.total);
      setTotalPages(data.totalPages);
      setLoadedThroughPage(filters.page);
    } catch (caughtError) {
      if (objectsRequestIdRef.current === requestId) {
        setError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить каталог');
      }
    } finally {
      if (objectsRequestIdRef.current === requestId) {
        setIsLoading(false);
      }
    }
  }

  async function loadMoreObjects() {
    if (!accessToken || isLoading || isLoadingMore || loadedThroughPage >= totalPages) {
      return;
    }

    const nextPage = loadedThroughPage + 1;
    const nextFilters = {
      ...filters,
      page: nextPage,
    };
    const requestId = objectsRequestIdRef.current + 1;
    objectsRequestIdRef.current = requestId;

    setIsLoadingMore(true);
    setLoadMoreError(null);

    try {
      const params = buildObjectsParams(nextFilters, true);
      const data = await apiRequest<ObjectsResponse>(`/objects?${params.toString()}`, accessToken);

      if (objectsRequestIdRef.current !== requestId) {
        return;
      }

      setObjects((currentObjects) => appendUniqueCatalogObjects(currentObjects, data.items));
      setTotal(data.total);
      setTotalPages(data.totalPages);
      setLoadedThroughPage(nextPage);
    } catch (caughtError) {
      if (objectsRequestIdRef.current === requestId) {
        setLoadMoreError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить следующую страницу');
      }
    } finally {
      if (objectsRequestIdRef.current === requestId) {
        setIsLoadingMore(false);
      }
    }
  }

  async function loadMapObjects() {
    if (!accessToken) {
      return;
    }

    const requestId = mapObjectsRequestIdRef.current + 1;
    mapObjectsRequestIdRef.current = requestId;

    if (filters.hasCoordinates === 'false') {
      setMapObjects([]);
      setMapTotal(0);
      setMapError(null);
      setIsMapLoading(false);
      return;
    }

    setIsMapLoading(true);
    setMapError(null);

    try {
      const params = buildObjectsParams(filters, false);
      const data = await apiRequest<MapObjectsResponse>(`/map/objects?${params.toString()}`, accessToken);

      if (mapObjectsRequestIdRef.current !== requestId) {
        return;
      }

      setMapObjects(data.items);
      setMapTotal(data.total);
    } catch (caughtError) {
      if (mapObjectsRequestIdRef.current === requestId) {
        setMapError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить объекты для карты');
      }
    } finally {
      if (mapObjectsRequestIdRef.current === requestId) {
        setIsMapLoading(false);
      }
    }
  }

  function updateFilters(patch: Partial<CatalogFilters>, options: { resetPage: boolean } = { resetPage: true }) {
    const nextFilters = {
      ...filters,
      ...patch,
      page: options.resetPage ? 1 : (patch.page ?? filters.page),
    };
    const shouldResetSearchResults = 'search' in patch && patch.search !== filters.search;
    const nextSearch = buildCatalogQuery(nextFilters, viewMode);

    if (shouldResetSearchResults) {
      objectsRequestIdRef.current += 1;
      setObjects([]);
      setTotal(0);
      setTotalPages(1);
      setLoadedThroughPage(nextFilters.page);
      setError(null);
      setLoadMoreError(null);
      setIsLoadingMore(false);
      setIsLoading(true);
    }

    if (shouldResetSearchResults && isMapView) {
      mapObjectsRequestIdRef.current += 1;
      setMapObjects([]);
      setMapTotal(0);
      setMapError(null);
      setIsMapLoading(nextFilters.hasCoordinates !== 'false');
    }

    window.history.pushState(null, '', `${pathname}${nextSearch}`);
    setQueryString(window.location.search);
  }

  function resetFilters() {
    window.history.pushState(null, '', `${pathname}${buildCatalogQuery(defaultFilters, viewMode)}`);
    setQueryString(window.location.search);
  }

  function toggleCatalogViewMode() {
    const nextViewMode: CatalogViewMode = viewMode === 'list' ? 'cards' : 'list';
    const nextSearch = buildCatalogQuery(filters, nextViewMode);

    window.history.pushState(null, '', `${pathname}${nextSearch}`);
    setQueryString(window.location.search);
  }

  function openCatalogDeveloperLink(developerId: string) {
    const nextFilters = {
      ...defaultFilters,
      developerId,
    };
    const nextSearch = buildCatalogQuery(nextFilters, viewMode);

    window.history.pushState(null, '', `/catalog${nextSearch}`);
    setQueryString(window.location.search);
  }

  function openCatalogKrtLink(krtName: string) {
    const nextFilters = {
      ...defaultFilters,
      krtName,
    };
    const nextSearch = buildCatalogQuery(nextFilters, viewMode);

    window.history.pushState(null, '', `/catalog${nextSearch}`);
    setQueryString(window.location.search);
  }

  return (
    <div className="catalog-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Каталог</p>
          <h2>{isMapView ? 'Объекты на карте' : 'Объекты недвижимости'}</h2>
        </div>
        <div className="header-actions">
          <span className="catalog-count">
            {isMapView ? formatCatalogCount(isMapLoading, mapTotal) : formatCatalogCount(isLoading, total)}
          </span>
        </div>
      </header>

      {canShowCatalogQuickLinks ? (
        <CatalogQuickLinks
          error={catalogLinksError}
          isLoading={isCatalogLinksLoading}
          links={catalogLinks}
          onOpenDeveloper={openCatalogDeveloperLink}
          onOpenKrt={openCatalogKrtLink}
        />
      ) : null}

      <CatalogViewActions
        isMapView={isMapView}
        viewMode={viewMode}
        onOpenCatalog={() => navigate(`/catalog${queryString}`)}
        onOpenMap={() => navigate(`/catalog/map${queryString}`)}
        onToggleViewMode={toggleCatalogViewMode}
      />

      <CatalogFilters
        directories={directories}
        filters={filters}
        isDirectoriesLoading={isDirectoriesLoading}
        onChange={updateFilters}
        onReset={resetFilters}
      />

      {!isMapView ? <CatalogSortBar filters={filters} onChange={updateFilters} /> : null}

      {directoryError ? <p className="form-error">{directoryError}</p> : null}

      {isMapView ? (
        <CatalogMapView
          accessToken={accessToken ?? ''}
          error={mapError}
          filters={filters}
          isLoading={isMapLoading}
          objects={mapObjects}
          total={mapTotal}
        />
      ) : (
        <CatalogListView
          accessToken={accessToken ?? ''}
          error={error}
          filters={filters}
          isLoading={isLoading}
          isLoadingMore={isLoadingMore}
          loadedThroughPage={loadedThroughPage}
          loadMoreError={loadMoreError}
          objects={objects}
          total={total}
          totalPages={totalPages}
          viewMode={viewMode}
          onLimitChange={(limit) => updateFilters({ limit })}
          onLoadMore={loadMoreObjects}
          onPageChange={(page) => updateFilters({ page }, { resetPage: false })}
        />
      )}
    </div>
  );
}

function CatalogViewActions({
  isMapView,
  viewMode,
  onOpenCatalog,
  onOpenMap,
  onToggleViewMode,
}: {
  isMapView: boolean;
  viewMode: CatalogViewMode;
  onOpenCatalog: () => void;
  onOpenMap: () => void;
  onToggleViewMode: () => void;
}) {
  return (
    <div className="catalog-view-actions" aria-label="Переключение вида каталога">
      {isMapView ? (
        <>
          <button className="catalog-view-toggle" type="button" onClick={onOpenCatalog}>
            Список
          </button>
          <button aria-current="page" className="catalog-map-button" type="button" onClick={onOpenMap}>
            Карта
          </button>
        </>
      ) : (
        <>
          <button
            aria-pressed={viewMode === 'list'}
            className={`catalog-view-toggle${viewMode === 'list' ? ' catalog-view-toggle--list' : ''}`}
            type="button"
            onClick={onToggleViewMode}
          >
            Карточками / Списком
          </button>
          <button className="catalog-map-button" type="button" onClick={onOpenMap}>
            Показать на карте
          </button>
        </>
      )}
    </div>
  );
}

const catalogQuickLinkGroups: Array<{ type: PublicCatalogQuickLink['type']; title: string }> = [
  { type: 'DEVELOPER', title: 'Крупные застройщики' },
  { type: 'KRT', title: 'Основные локации КРТ' },
  { type: 'SALES_START', title: 'Старты продаж' },
];

function CatalogQuickLinks({
  error,
  isLoading,
  links,
  onOpenDeveloper,
  onOpenKrt,
}: {
  error: string | null;
  isLoading: boolean;
  links: PublicCatalogQuickLink[];
  onOpenDeveloper: (developerId: string) => void;
  onOpenKrt: (krtName: string) => void;
}) {
  if (error) {
    return <p className="form-error">{error}</p>;
  }

  if (!isLoading && links.length === 0) {
    return null;
  }

  return (
    <section className="catalog-quick-links" aria-label="Быстрые ссылки каталога">
      {catalogQuickLinkGroups.map((group) => {
        const groupLinks = links.filter((link) => link.type === group.type);

        return (
          <article className="catalog-quick-links-column" key={group.type}>
            <h3>{group.title}</h3>
            {isLoading && groupLinks.length === 0 ? (
              <p className="muted-text">Загрузка</p>
            ) : groupLinks.length > 0 ? (
              <ul>
                {groupLinks.map((link) => (
                  <li key={link.id}>
                    <CatalogQuickLinkItem
                      link={link}
                      onOpenDeveloper={onOpenDeveloper}
                      onOpenKrt={onOpenKrt}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted-text">Нет ссылок</p>
            )}
          </article>
        );
      })}
    </section>
  );
}

function CatalogQuickLinkItem({
  link,
  onOpenDeveloper,
  onOpenKrt,
}: {
  link: PublicCatalogQuickLink;
  onOpenDeveloper: (developerId: string) => void;
  onOpenKrt: (krtName: string) => void;
}) {
  const developerId = link.developerId;
  const krtName = link.krtName;
  const objectSlug = link.objectSlug;

  if (link.type === 'DEVELOPER' && developerId) {
    return (
      <button className="text-button" type="button" onClick={() => onOpenDeveloper(developerId)}>
        {link.label}
      </button>
    );
  }

  if (link.type === 'KRT' && krtName) {
    return (
      <button className="text-button" type="button" onClick={() => onOpenKrt(krtName)}>
        {link.label}
      </button>
    );
  }

  if (link.type === 'SALES_START' && objectSlug) {
    const objectHref = `/objects/${encodeURIComponent(objectSlug)}`;

    return (
      <a
        className="text-button"
        href={objectHref}
        rel="noopener noreferrer"
        target="_blank"
      >
        {link.label}
      </a>
    );
  }

  return null;
}

function CatalogFilters({
  directories,
  filters,
  isDirectoriesLoading,
  onChange,
  onReset,
}: {
  directories: DirectoryState;
  filters: CatalogFilters;
  isDirectoriesLoading: boolean;
  onChange: (patch: Partial<CatalogFilters>, options?: { resetPage: boolean }) => void;
  onReset: () => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const activeAdvancedFilterCount = countActiveAdvancedFilters(filters);
  const filterButtonLabel = isExpanded ? 'Скрыть фильтры' : '+ Фильтры';

  function handleCurrencyInputBackspace(event: KeyboardEvent<HTMLInputElement>, patchKey: keyof CatalogFilters) {
    if (event.key !== 'Backspace' || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }

    const nextValue = getCurrencyInputBackspaceValue(
      event.currentTarget.value,
      event.currentTarget.selectionStart,
      event.currentTarget.selectionEnd,
    );

    if (nextValue === null) {
      return;
    }

    event.preventDefault();
    onChange({ [patchKey]: sanitizeDecimalText(nextValue) });
  }

  return (
    <section className={`catalog-filters${isExpanded ? ' catalog-filters--expanded' : ''}`} aria-label="Фильтры каталога">
      <div className="catalog-filter-search-row">
        <label className="catalog-filter-search">
          Поиск
          <input
            placeholder="Название, адрес, застройщик"
            type="search"
            value={filters.search}
            onChange={(event) => onChange({ search: event.target.value })}
          />
        </label>

        <div className="catalog-filter-header-actions">
          <button className="catalog-filter-reset" type="button" onClick={onReset}>
            Сбросить
          </button>
          <button
            aria-expanded={isExpanded}
            className="catalog-filter-toggle"
            type="button"
            onClick={() => setIsExpanded((currentValue) => !currentValue)}
          >
            {filterButtonLabel}
            {activeAdvancedFilterCount > 0 ? <span>{activeAdvancedFilterCount}</span> : null}
          </button>
        </div>
      </div>

      {isExpanded ? (
        <div className="catalog-filter-fields">
          <label>
            Застройщик
            <CatalogFilterSearchSelect
              ariaLabel="Фильтр каталога по застройщику"
              disabled={isDirectoriesLoading}
              emptyLabel="Застройщики не найдены"
              getOptionLabel={(developer) => developer.name}
              getSearchValues={(developer) => [developer.name, developer.slug]}
              options={directories.developers}
              placeholder="Все застройщики"
              searchPlaceholder="Поиск застройщика"
              selectedIds={getCatalogFilterIdValues(filters.developerId)}
              onSelectedIdsChange={(developerIds) =>
                onChange({ developerId: formatCatalogFilterIdValues(developerIds) })
              }
            />
          </label>

          <label>
            Район
            <CatalogFilterSearchSelect
              ariaLabel="Фильтр каталога по району"
              disabled={isDirectoriesLoading}
              emptyLabel="Районы не найдены"
              getOptionLabel={(location) => location.name}
              getSearchValues={(location) => [location.name, location.slug]}
              options={directories.districtLocations}
              placeholder="Все районы"
              searchPlaceholder="Поиск района"
              selectedIds={getCatalogFilterIdValues(filters.locationId)}
              onSelectedIdsChange={(locationIds) =>
                onChange({ locationId: formatCatalogFilterIdValues(locationIds) })
              }
            />
          </label>

          <label>
            Окружение
            <CatalogFilterSearchSelect
              ariaLabel="Фильтр каталога по окружению"
              disabled={isDirectoriesLoading}
              emptyLabel="Окружение не найдено"
              getOptionLabel={(location) => location.name}
              getSearchValues={(location) => [location.name, location.slug]}
              options={directories.areaLocations}
              placeholder="Все окружения"
              searchPlaceholder="Поиск окружения"
              selectedIds={getCatalogFilterIdValues(filters.areaId)}
              onSelectedIdsChange={(areaIds) => onChange({ areaId: formatCatalogFilterIdValues(areaIds) })}
            />
          </label>

          <label>
            Метро
            <CatalogFilterSearchSelect
              ariaLabel="Фильтр каталога по метро"
              disabled={isDirectoriesLoading}
              emptyLabel="Метро не найдено"
              getOptionLabel={(station) => (station.lineName ? `${station.name}, ${station.lineName}` : station.name)}
              getSearchValues={(station) => [station.name, station.slug, station.lineName]}
              options={directories.metroStations}
              placeholder="Все станции"
              searchPlaceholder="Поиск метро"
              selectedIds={getCatalogFilterIdValues(filters.metroStationId)}
              onSelectedIdsChange={(metroStationIds) =>
                onChange({ metroStationId: formatCatalogFilterIdValues(metroStationIds) })
              }
            />
          </label>

          <label>
            Срок, год
            <input
              inputMode="numeric"
              placeholder="2026"
              type="text"
              value={filters.completionYear}
              onChange={(event) => onChange({ completionYear: sanitizeIntegerText(event.target.value, 4) })}
            />
          </label>

          <div className="catalog-filter-range" aria-label="Диапазон цены лота">
            <label>
              Цена от
              <input
                inputMode="decimal"
                placeholder="0 ₽"
                type="text"
                value={formatCurrencyInputValue(filters.lotPriceMin)}
                onChange={(event) => onChange({ lotPriceMin: sanitizeDecimalText(event.target.value) })}
                onKeyDown={(event) => handleCurrencyInputBackspace(event, 'lotPriceMin')}
              />
            </label>

            <label>
              Цена до
              <input
                inputMode="decimal"
                placeholder="50 000 000 ₽"
                type="text"
                value={formatCurrencyInputValue(filters.lotPriceMax)}
                onChange={(event) => onChange({ lotPriceMax: sanitizeDecimalText(event.target.value) })}
                onKeyDown={(event) => handleCurrencyInputBackspace(event, 'lotPriceMax')}
              />
            </label>
          </div>

          <label>
            Сколько комнат
            <MultiSelectDropdown
              ariaLabel="Фильтр каталога по комнатам"
              options={catalogRoomOptions}
              placeholder="Любые лоты"
              values={getRoomFilterValues(filters.lotRooms)}
              onChange={(values) => onChange({ lotRooms: formatRoomFilterValues(values) })}
            />
          </label>

          <div className="catalog-filter-range" aria-label="Диапазон этажа лота">
            <label>
              Этаж от
              <input
                inputMode="numeric"
                placeholder="1"
                type="text"
                value={filters.lotFloorMin}
                onChange={(event) => onChange({ lotFloorMin: sanitizeIntegerText(event.target.value, 3) })}
              />
            </label>

            <label>
              Этаж до
              <input
                inputMode="numeric"
                placeholder="25"
                type="text"
                value={filters.lotFloorMax}
                onChange={(event) => onChange({ lotFloorMax: sanitizeIntegerText(event.target.value, 3) })}
              />
            </label>
          </div>

          <div className="catalog-filter-range" aria-label="Диапазон цены за метр лота">
            <label>
              Цена за метр от
              <input
                inputMode="decimal"
                placeholder="0 ₽"
                type="text"
                value={formatCurrencyInputValue(filters.lotPricePerMeterMin)}
                onChange={(event) => onChange({ lotPricePerMeterMin: sanitizeDecimalText(event.target.value) })}
                onKeyDown={(event) => handleCurrencyInputBackspace(event, 'lotPricePerMeterMin')}
              />
            </label>

            <label>
              Цена за метр до
              <input
                inputMode="decimal"
                placeholder="500 000 ₽"
                type="text"
                value={formatCurrencyInputValue(filters.lotPricePerMeterMax)}
                onChange={(event) => onChange({ lotPricePerMeterMax: sanitizeDecimalText(event.target.value) })}
                onKeyDown={(event) => handleCurrencyInputBackspace(event, 'lotPricePerMeterMax')}
              />
            </label>
          </div>
        </div>
      ) : null}
    </section>
  );
}

type CatalogFilterSearchSelectOption = {
  id: string;
};

function CatalogFilterSearchSelect<T extends CatalogFilterSearchSelectOption>({
  ariaLabel,
  disabled = false,
  emptyLabel,
  getOptionLabel,
  getSearchValues,
  options,
  placeholder,
  searchPlaceholder,
  selectedIds,
  onSelectedIdsChange,
}: {
  ariaLabel: string;
  disabled?: boolean;
  emptyLabel: string;
  getOptionLabel: (option: T) => string;
  getSearchValues: (option: T) => Array<string | null | undefined>;
  options: T[];
  placeholder: string;
  searchPlaceholder: string;
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const listboxId = useId();
  const selectedValueSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedOptions = useMemo(
    () => options.filter((option) => selectedValueSet.has(option.id)),
    [options, selectedValueSet],
  );
  const hasSelectedOptions = selectedOptions.length > 0;
  const selectedLabel = selectedOptions.map((option) => getOptionLabel(option)).join(', ');
  const filteredOptions = useMemo(() => {
    const matchedOptions = options.filter((option) => matchesSearchVariants(query, getSearchValues(option)));

    return matchedOptions.slice(0, catalogFilterSearchResultLimit);
  }, [getSearchValues, options, query]);

  function openDropdown() {
    if (disabled) {
      return;
    }

    setIsOpen(true);
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  }

  function toggleDropdown() {
    if (disabled) {
      return;
    }

    if (isOpen) {
      setIsOpen(false);
      setQuery('');
      return;
    }

    openDropdown();
  }

  function clearSelection() {
    onSelectedIdsChange([]);
    setQuery('');
    setIsOpen(true);
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  }

  function toggleOption(optionId: string) {
    const nextIds = selectedValueSet.has(optionId)
      ? selectedIds.filter((id) => id !== optionId)
      : [...selectedIds, optionId];

    onSelectedIdsChange(nextIds);
    setIsOpen(true);
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    setIsOpen(false);
    setQuery('');
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      setIsOpen(false);
      setQuery('');
      return;
    }

    if (event.key === 'Enter' && isOpen && document.activeElement === searchInputRef.current && filteredOptions[0]) {
      event.preventDefault();
      toggleOption(filteredOptions[0].id);
    }
  }

  return (
    <div className="multi-select-dropdown" onBlur={handleBlur} onKeyDown={handleKeyDown}>
      <button
        aria-controls={isOpen ? listboxId : undefined}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className={isOpen ? 'multi-select-dropdown-button is-open' : 'multi-select-dropdown-button'}
        disabled={disabled}
        type="button"
        onClick={toggleDropdown}
      >
        <span className={hasSelectedOptions ? 'multi-select-dropdown-value' : 'multi-select-dropdown-value is-empty'}>
          {hasSelectedOptions ? selectedLabel : placeholder}
        </span>
        <ChevronDownIcon aria-hidden="true" className="multi-select-dropdown-chevron" />
      </button>

      {isOpen ? (
        <div className="multi-select-dropdown-menu">
          <input
            ref={searchInputRef}
            aria-label={`${ariaLabel}: поиск`}
            placeholder={searchPlaceholder}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onFocus={openDropdown}
          />
          <div id={listboxId} role="listbox" aria-multiselectable={true}>
            <button
              className={
                hasSelectedOptions
                  ? 'multi-select-dropdown-option'
                  : 'multi-select-dropdown-option multi-select-dropdown-option--selected'
              }
              type="button"
              role="option"
              aria-selected={!hasSelectedOptions}
              onClick={clearSelection}
            >
              <span>{placeholder}</span>
              {!hasSelectedOptions ? <CheckIcon aria-hidden="true" className="multi-select-dropdown-check" /> : null}
            </button>

            {filteredOptions.length > 0 ? (
              filteredOptions.map((option) => {
                const isSelected = selectedValueSet.has(option.id);

                return (
                  <button
                    key={option.id}
                    className={
                      isSelected
                        ? 'multi-select-dropdown-option multi-select-dropdown-option--selected'
                        : 'multi-select-dropdown-option'
                    }
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => toggleOption(option.id)}
                  >
                    <span>{getOptionLabel(option)}</span>
                    {isSelected ? <CheckIcon aria-hidden="true" className="multi-select-dropdown-check" /> : null}
                  </button>
                );
              })
            ) : (
              <p className="searchable-multi-select-empty">{emptyLabel}</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CatalogSortBar({
  filters,
  onChange,
}: {
  filters: CatalogFilters;
  onChange: (patch: Partial<CatalogFilters>, options?: { resetPage: boolean }) => void;
}) {
  function onSortChange(sortBy: CatalogSortField) {
    const sortDirection =
      filters.sortBy === sortBy
        ? toggleCatalogSortDirection(filters.sortDirection)
        : getDefaultCatalogSortDirection(sortBy);

    onChange({ sortBy, sortDirection });
  }

  return (
    <section className="catalog-sort-bar" aria-label="Сортировка каталога">
      <div className="catalog-sort-row">
        <span className="catalog-sort-spacer" aria-hidden="true" />
        <CatalogSortButton
          active={filters.sortBy === 'priceFrom'}
          direction={filters.sortDirection}
          onClick={() => onSortChange('priceFrom')}
        >
          Цена
        </CatalogSortButton>
        <CatalogSortButton
          active={filters.sortBy === 'pricePerMeterFrom'}
          direction={filters.sortDirection}
          onClick={() => onSortChange('pricePerMeterFrom')}
        >
          Цена м²
        </CatalogSortButton>
        <CatalogSortButton
          active={filters.sortBy === 'completionDate'}
          direction={filters.sortDirection}
          onClick={() => onSortChange('completionDate')}
        >
          Срок
        </CatalogSortButton>
        <CatalogSortButton
          active={filters.sortBy === 'createdAt'}
          direction={filters.sortDirection}
          onClick={() => onSortChange('createdAt')}
        >
          Добавлен
        </CatalogSortButton>
      </div>
    </section>
  );
}

function CatalogSortButton({
  active,
  children,
  direction,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  direction: SortDirection;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={active ? 'catalog-sort-button catalog-sort-button--active' : 'catalog-sort-button'}
      type="button"
      onClick={onClick}
    >
      {children}
      {active ? (
        direction === 'asc' ? (
          <ArrowUpIcon aria-hidden="true" />
        ) : (
          <ArrowDownIcon aria-hidden="true" />
        )
      ) : (
        <ArrowUpDownIcon aria-hidden="true" />
      )}
    </button>
  );
}

function CatalogListView({
  accessToken,
  error,
  filters,
  isLoading,
  isLoadingMore,
  loadedThroughPage,
  loadMoreError,
  objects,
  total,
  totalPages,
  viewMode,
  onLimitChange,
  onLoadMore,
  onPageChange,
}: {
  accessToken: string;
  error: string | null;
  filters: CatalogFilters;
  isLoading: boolean;
  isLoadingMore: boolean;
  loadedThroughPage: number;
  loadMoreError: string | null;
  objects: RealEstateObjectSummary[];
  total: number;
  totalPages: number;
  viewMode: CatalogViewMode;
  onLimitChange: (limit: CatalogPageSize) => void;
  onLoadMore: () => void;
  onPageChange: (page: number) => void;
}) {
  const hasNextPage = loadedThroughPage < totalPages;
  const pageOptions = Array.from({ length: totalPages }, (_, index) => index + 1);
  const showInitialCatalogLoading = isLoading && objects.length === 0;

  if (error) {
    return <p className="form-error">{error}</p>;
  }

  if (showInitialCatalogLoading) {
    return (
      <div className="content-panel">
        <p className="eyebrow">Каталог</p>
        <h2>Загрузка</h2>
        <p className="muted-text">Получаем объекты по выбранным фильтрам.</p>
      </div>
    );
  }

  if (!isLoading && objects.length === 0) {
    return (
      <div className="content-panel">
        <p className="eyebrow">Каталог</p>
        <h2>Нет объектов</h2>
        <p className="muted-text">По выбранным фильтрам объекты не найдены.</p>
      </div>
    );
  }

  return (
    <>
      {viewMode === 'list' ? (
        <div className="catalog-list" aria-label="Объекты списком">
          {objects.map((object) => (
            <CatalogListItem
              key={object.id}
              object={object}
              accessToken={accessToken}
              filters={filters}
            />
          ))}
        </div>
      ) : (
        <div className="catalog-grid" aria-label="Объекты карточками">
          {objects.map((object) => (
            <CatalogCard key={object.id} object={object} accessToken={accessToken} filters={filters} />
          ))}
        </div>
      )}

      {total > 0 ? (
        <div className="pagination catalog-pagination">
          {hasNextPage ? (
            <button className="catalog-pagination-more" disabled={isLoadingMore} type="button" onClick={onLoadMore}>
              {isLoadingMore ? 'Загрузка' : 'Показать еще'}
            </button>
          ) : null}

          <div className="catalog-pagination-nav" aria-label="Навигация по страницам каталога">
            <button
              aria-label="Предыдущая страница"
              className="catalog-pagination-arrow"
              disabled={filters.page <= 1}
              type="button"
              onClick={() => onPageChange(Math.max(1, filters.page - 1))}
            >
              <ChevronLeftIcon aria-hidden="true" />
            </button>

            <label className="catalog-pagination-field">
              Страница
              <select
                aria-label="Выбор страницы каталога"
                className="catalog-pagination-select"
                value={filters.page}
                onChange={(event) => onPageChange(parsePositiveInteger(event.target.value, 1))}
              >
                {pageOptions.map((page) => (
                  <option key={page} value={page}>
                    {page}
                  </option>
                ))}
              </select>
            </label>

            <span className="catalog-pagination-total">из {totalPages}</span>

            <button
              aria-label="Следующая страница"
              className="catalog-pagination-arrow"
              disabled={filters.page >= totalPages}
              type="button"
              onClick={() => onPageChange(Math.min(totalPages, filters.page + 1))}
            >
              <ChevronRightIcon aria-hidden="true" />
            </button>
          </div>

          <label className="catalog-pagination-field catalog-pagination-field--limit">
            На странице
            <select
              aria-label="Количество объектов на странице"
              className="catalog-pagination-select"
              value={filters.limit}
              onChange={(event) => onLimitChange(parseCatalogPageSize(event.target.value))}
            >
              {catalogPageSizeOptions.map((limit) => (
                <option key={limit} value={limit}>
                  {limit}
                </option>
              ))}
            </select>
          </label>

          <span className="catalog-pagination-count">Показано: {objects.length} из {total}</span>

          {loadMoreError ? <p className="form-error catalog-pagination-error">{loadMoreError}</p> : null}
        </div>
      ) : null}
    </>
  );
}

function CatalogMapView({
  accessToken,
  error,
  filters,
  isLoading,
  objects,
  total,
}: {
  accessToken: string;
  error: string | null;
  filters: CatalogFilters;
  isLoading: boolean;
  objects: MapObject[];
  total: number;
}) {
  const [visibleBounds, setVisibleBounds] = useState<YandexMapBounds | null>(null);
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [isListVisible, setIsListVisible] = useState(true);
  const points = useMemo(() => objects.map((object) => mapObjectToPoint(object, filters)), [filters, objects]);
  const visibleObjects = useMemo(
    () => (visibleBounds ? objects.filter((object) => isMapObjectInBounds(object, visibleBounds)) : objects),
    [objects, visibleBounds],
  );
  const selectedObject = useMemo(
    () => objects.find((object) => object.id === selectedObjectId) ?? null,
    [objects, selectedObjectId],
  );
  const handleBoundsChange = useCallback((bounds: YandexMapBounds) => {
    setVisibleBounds(bounds);
  }, []);
  const handleSelectPoint = useCallback((point: YandexMapPoint) => {
    setSelectedObjectId(point.id);
  }, []);

  useEffect(() => {
    setVisibleBounds(null);
  }, [objects]);

  useEffect(() => {
    if (selectedObjectId && !objects.some((object) => object.id === selectedObjectId)) {
      setSelectedObjectId(null);
    }
  }, [objects, selectedObjectId]);

  if (error) {
    return <p className="form-error">{error}</p>;
  }

  if (filters.hasCoordinates === 'false') {
    return (
      <div className="content-panel">
        <p className="eyebrow">Карта</p>
        <h2>Фильтр скрывает координаты</h2>
        <p className="muted-text">Для карты нужны объекты с заполненной широтой и долготой.</p>
      </div>
    );
  }

  const shouldRenderOverlayInsideMap = points.length > 0;
  const mapOverlay = (
    <>
      {isLoading ? <div className="map-loading">Загрузка объектов</div> : null}

      {selectedObject ? (
        <MapObjectCard
          accessToken={accessToken}
          filters={filters}
          object={selectedObject}
          onClose={() => setSelectedObjectId(null)}
        />
      ) : null}

      {isListVisible ? (
        <aside className="catalog-map-list" aria-label="Объекты на карте">
          <div className="catalog-map-list-header">
            <button className="text-button" type="button" onClick={() => setIsListVisible(false)}>
              Скрыть/показать
            </button>
            <div className="table-meta">
              <span>{isLoading ? 'Загрузка' : `В области: ${visibleObjects.length}`}</span>
              <span>{objects.length > 0 ? `На карте: ${objects.length}` : total > 0 ? `из ${total}` : 'На карте: 0'}</span>
            </div>
          </div>
          {visibleObjects.length > 0 ? (
            <ul>
              {visibleObjects.map((object) => (
                <li key={object.id} className={object.id === selectedObjectId ? 'catalog-map-list-item--selected' : undefined}>
                  <button className="text-button" type="button" onClick={() => setSelectedObjectId(object.id)}>
                    {object.title}
                  </button>
                  <span>{getObjectDistrictLabel(object)}</span>
                  <strong>{formatMapListPricePerMeter(getCatalogPricePerMeterFrom(object))}</strong>
                </li>
              ))}
            </ul>
          ) : (
            <p className="catalog-map-empty">В текущей области карты объектов нет.</p>
          )}
        </aside>
      ) : (
        <button className="catalog-map-list-toggle" type="button" onClick={() => setIsListVisible(true)}>
          Показать список
        </button>
      )}
    </>
  );

  return (
    <section className="catalog-map-layout" aria-label="Карта объектов">
      <div className="catalog-map-panel">
        <YandexMap
          onBoundsChange={handleBoundsChange}
          points={points}
          selectedPointId={selectedObjectId}
          onSelectPoint={handleSelectPoint}
        >
          {shouldRenderOverlayInsideMap ? mapOverlay : null}
        </YandexMap>

        {shouldRenderOverlayInsideMap ? null : mapOverlay}
      </div>
    </section>
  );
}

function MapObjectCard({
  accessToken,
  filters,
  object,
  onClose,
}: {
  accessToken: string;
  filters: CatalogFilters;
  object: MapObject;
  onClose: () => void;
}) {
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const metroLabel = formatMetroStations(object.metroStations ?? []);
  const districtLabel = getObjectDistrictLabel(object);
  const areaLabel = getCatalogAreaRange(object) ?? 'Не указано';
  const objectHref = buildCatalogObjectHref(object.slug, filters);
  const galleryImages = object.images.length > 0 ? object.images : object.coverImage ? [object.coverImage] : [];
  const activeImage = galleryImages[activeImageIndex] ?? galleryImages[0] ?? null;
  const hasGalleryNavigation = galleryImages.length > 1;
  const activeImageOrdinal = galleryImages[activeImageIndex] ? activeImageIndex + 1 : 1;

  useEffect(() => {
    setActiveImageIndex(0);
  }, [object.id]);

  const showPreviousImage = () => {
    setActiveImageIndex((currentIndex) =>
      galleryImages.length > 0 ? (currentIndex - 1 + galleryImages.length) % galleryImages.length : 0,
    );
  };

  const showNextImage = () => {
    setActiveImageIndex((currentIndex) =>
      galleryImages.length > 0 ? (currentIndex + 1) % galleryImages.length : 0,
    );
  };

  return (
    <article className="map-object-card" aria-label={`Объект ${object.title}`}>
      <button aria-label="Закрыть карточку" className="map-object-card-close" type="button" onClick={onClose}>
        ×
      </button>
      <div className="map-object-card-gallery" aria-label={`Галерея ${object.title}`}>
        {activeImage ? (
          <SecureImage
            key={activeImage.id}
            accessToken={accessToken}
            alt={activeImage.alt ?? activeImage.title ?? object.title}
            className="map-object-card-image"
            errorFallback="Превью недоступно"
            fileId={activeImage.file.id}
            placeholderClassName="map-object-card-image map-object-card-image--empty"
            variant="card"
          />
        ) : (
          <div className="map-object-card-image map-object-card-image--empty">Нет фото</div>
        )}
        {hasGalleryNavigation ? (
          <>
            <button
              aria-label="Предыдущее фото"
              className="map-object-card-gallery-button map-object-card-gallery-button--previous"
              type="button"
              onClick={showPreviousImage}
            >
              <ChevronLeftIcon aria-hidden="true" size={20} />
            </button>
            <button
              aria-label="Следующее фото"
              className="map-object-card-gallery-button map-object-card-gallery-button--next"
              type="button"
              onClick={showNextImage}
            >
              <ChevronRightIcon aria-hidden="true" size={20} />
            </button>
            <span className="map-object-card-gallery-count">
              {activeImageOrdinal}/{galleryImages.length}
            </span>
          </>
        ) : null}
      </div>
      <div className="map-object-card-body">
        <h3>
          <a className="map-object-card-title-link" href={objectHref} rel="noopener noreferrer" target="_blank">
            {object.title}
          </a>
        </h3>
        <dl>
          <div>
            <dt>Застройщик</dt>
            <dd>{object.developer?.name ?? 'Не указан'}</dd>
          </div>
          <div>
            <dt>Район</dt>
            <dd>{districtLabel}</dd>
          </div>
          {metroLabel ? (
            <div>
              <dt>Метро</dt>
              <dd>{metroLabel.replace(/^Метро /, '')}</dd>
            </div>
          ) : null}
          <div>
            <dt>Завершение строительства</dt>
            <dd>{formatCompletion(object.completionYear, object.completionQuarter)}</dd>
          </div>
          <div>
            <dt>Площадь</dt>
            <dd>{areaLabel}</dd>
          </div>
        </dl>
        <p>
          Цена: <strong>{formatPriceFrom(getCatalogPriceFrom(object))}</strong> | Цена за м²:{' '}
          <strong>{formatMapCardPricePerMeter(getCatalogPricePerMeterFrom(object))}</strong>
        </p>
        <a className="catalog-card-link map-object-card-link" href={objectHref} rel="noopener noreferrer" target="_blank">
          Подробнее
        </a>
      </div>
    </article>
  );
}

function CatalogListItem({
  accessToken,
  filters,
  object,
}: {
  accessToken: string;
  filters: CatalogFilters;
  object: RealEstateObjectSummary;
}) {
  const coverImage = object.coverImage;
  const objectHref = buildCatalogObjectHref(object.slug, filters);
  const matchedLotsLabel = getCatalogMatchedLotsLabel(object, filters);
  const developerLabel = object.developer?.name ?? 'Не указан';
  const districtLabel = getObjectDistrictLabel(object);
  const metroLabel = formatListMetroStations(object.metroStations);
  const areaLabel = getCatalogAreaRange(object) ?? 'Не указано';

  return (
    <article className="catalog-list-item">
      <a
        aria-label={`Открыть объект ${object.title}`}
        className="catalog-list-item-media"
        href={objectHref}
        rel="noopener noreferrer"
        target="_blank"
      >
        {coverImage ? (
          <CatalogCoverImage accessToken={accessToken} alt={coverImage.alt ?? object.title} fileId={coverImage.file.id} />
        ) : (
          <CatalogMediaState title="Нет обложки" text="Показываем данные объекта" tone="empty" />
        )}
      </a>

      <div className="catalog-list-item-body">
        <h3>
          <a href={objectHref} rel="noopener noreferrer" target="_blank">
            {object.title}
          </a>
        </h3>
        <dl className="catalog-list-item-details">
          <div>
            <dt>Застройщик</dt>
            <dd>{developerLabel}</dd>
          </div>
          <div>
            <dt>Район</dt>
            <dd>{districtLabel}</dd>
          </div>
          <div>
            <dt>Метро</dt>
            <dd>{metroLabel ?? 'Не указано'}</dd>
          </div>
          <div>
            <dt>Завершение строительства</dt>
            <dd>{formatListCompletion(object.completionYear, object.completionQuarter)}</dd>
          </div>
          <div>
            <dt>Площадь</dt>
            <dd>{areaLabel}</dd>
          </div>
        </dl>
        <p className="catalog-list-item-price">
          Цена: {formatRequestedPriceFrom(getCatalogPriceFrom(object))} | Цена за м²:{' '}
          {formatRequestedPricePerMeterFrom(getCatalogPricePerMeterFrom(object))}
        </p>
        {matchedLotsLabel ? <span className="catalog-matched-lots-badge">{matchedLotsLabel}</span> : null}
      </div>

      <div className="catalog-list-item-action">
        <a className="catalog-list-item-link" href={objectHref} rel="noopener noreferrer" target="_blank">
          Подробнее
        </a>
      </div>
    </article>
  );
}

function CatalogCard({
  accessToken,
  filters,
  object,
}: {
  accessToken: string;
  filters: CatalogFilters;
  object: RealEstateObjectSummary;
}) {
  const coverImage = object.coverImage;
  const objectHref = buildCatalogObjectHref(object.slug, filters);
  const matchedLotsCount = getCatalogMatchedLotsCount(object, filters);
  const hasPresentation = Boolean(object.presentationFile);
  const hasImportedLotsBadge = hasImportedLots(object);
  const hasVisibleBadges = object.status !== 'PUBLISHED' || hasPresentation || hasImportedLotsBadge;
  const districtLabel = getObjectDistrictLabel(object);
  const areaLabel = getCatalogAreaRange(object) ?? 'Не указано';

  return (
    <article className="catalog-card">
      <a
        aria-label={`Открыть объект ${object.title}`}
        className="catalog-card-media catalog-card-media-link"
        href={objectHref}
        rel="noopener noreferrer"
        target="_blank"
      >
        {coverImage ? (
          <CatalogCoverImage accessToken={accessToken} alt={coverImage.alt ?? object.title} fileId={coverImage.file.id} />
        ) : (
          <CatalogMediaState title="Нет обложки" text="Показываем данные объекта" tone="empty" />
        )}
        <span aria-hidden="true" className="catalog-card-media-shade" />
        {hasVisibleBadges ? (
          <span className="catalog-card-badges">
            {object.status === 'PUBLISHED' ? null : (
              <span className={`status-pill catalog-card-status object-status object-status--${object.status.toLowerCase()}`}>
                {objectStatusLabels[object.status]}
              </span>
            )}
            {hasPresentation || hasImportedLotsBadge ? (
              <span className="catalog-card-document-badges">
                {hasImportedLotsBadge ? (
                  <span
                    className="catalog-card-floor-plan-badge"
                    aria-label="Есть импортированные лоты"
                    title="Есть импортированные лоты"
                  >
                    <img
                      alt=""
                      aria-hidden="true"
                      className="catalog-card-floor-plan-icon"
                      src={floorPlanIconUrl}
                    />
                  </span>
                ) : null}
                {hasPresentation ? <span className="catalog-card-pdf-badge catalog-card-pdf-badge--active">PDF</span> : null}
              </span>
            ) : null}
          </span>
        ) : null}
      </a>
      <div className="catalog-card-body">
        <div className="catalog-card-heading">
          <h3>
            <a href={objectHref} rel="noopener noreferrer" target="_blank" title={object.title}>
              {object.title}
            </a>
          </h3>
        </div>
        <div className="catalog-card-price-row">
          <p className="catalog-card-price">{formatPriceFrom(getCatalogPriceFrom(object))}</p>
          <span>{formatPricePerMeterFrom(getCatalogPricePerMeterFrom(object))}</span>
        </div>
        <div className="catalog-card-location" aria-label="Район и метро">
          <span title={districtLabel}>{districtLabel}</span>
          <CatalogCardMetroLabel stations={object.metroStations} />
        </div>
        <dl className="catalog-card-facts">
          <div>
            <dt>Срок</dt>
            <dd>{formatCompletion(object.completionYear, object.completionQuarter)}</dd>
          </div>
          <div>
            <dt>Площадь</dt>
            <dd>{areaLabel}</dd>
          </div>
          <div>
            <dt>Застройщик</dt>
            <dd>{object.developer?.name ?? 'Не указан'}</dd>
          </div>
          {matchedLotsCount !== null ? (
            <div className="catalog-card-matched-lots-badge">
              <dt>Найдено лотов</dt>
              <dd>{formatNumber(matchedLotsCount)}</dd>
            </div>
          ) : null}
        </dl>
        <div className="catalog-card-actions">
          <a className="catalog-card-link" href={objectHref} rel="noopener noreferrer" target="_blank">
            Подробнее
          </a>
        </div>
      </div>
    </article>
  );
}

function CatalogCardMetroLabel({ stations }: { stations: ObjectMetroStationLink[] }) {
  if (stations.length === 0) {
    return null;
  }

  const visibleStations = stations.slice(0, 2);
  const hiddenCount = stations.length - visibleStations.length;
  const metroLabel = formatMetroStations(stations) ?? undefined;

  return (
    <span className="catalog-card-metro" aria-label={metroLabel} title={metroLabel}>
      <span className="catalog-card-metro-prefix">Метро</span>
      {visibleStations.map((station, index) => {
        const lineColor = normalizeLineColor(station.lineColor);

        return (
          <span className="catalog-card-metro-station" key={station.id}>
            <span
              aria-hidden="true"
              className="catalog-card-metro-dot"
              style={lineColor ? { background: lineColor } : undefined}
            />
            <span className="catalog-card-metro-name">
              {station.name}
              {index < visibleStations.length - 1 ? ',' : ''}
            </span>
          </span>
        );
      })}
      {hiddenCount > 0 ? <span className="catalog-card-metro-more">+{hiddenCount}</span> : null}
    </span>
  );
}

function CatalogMediaState({
  title,
  text,
  tone,
  visibilityRef,
}: {
  title: string;
  text: string;
  tone: 'empty' | 'error' | 'loading';
  visibilityRef?: (node: HTMLElement | null) => void;
}) {
  return (
    <span ref={visibilityRef} className={`catalog-card-media-state catalog-card-media-state--${tone}`}>
      <span aria-hidden="true" className="catalog-card-media-mark" />
      <span>{title}</span>
      <small>{text}</small>
    </span>
  );
}

function CatalogCoverImage({ accessToken, alt, fileId }: { accessToken: string; alt: string; fileId: string }) {
  return (
    <SecureImage
      accessToken={accessToken}
      alt={alt}
      fileId={fileId}
      lazy
      renderError={({ visibilityRef }) => (
        <CatalogMediaState
          visibilityRef={visibilityRef}
          title="Обложка недоступна"
          text="Данные объекта сохранены"
          tone="error"
        />
      )}
      renderFallback={({ visibilityRef }) => (
        <CatalogMediaState visibilityRef={visibilityRef} title="Загрузка" text="Подтягиваем обложку" tone="loading" />
      )}
      variant="card"
    />
  );
}

function parseCatalogFilters(queryString: string): CatalogFilters {
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

function parseCatalogViewMode(queryString: string): CatalogViewMode {
  const params = new URLSearchParams(queryString);

  return params.get('view') === 'list' ? 'list' : 'cards';
}

function buildCatalogQuery(filters: CatalogFilters, viewMode: CatalogViewMode = 'cards') {
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

function buildCatalogObjectHref(slug: string, filters: CatalogFilters) {
  return `/objects/${encodeURIComponent(slug)}${buildCatalogLotFilterQuery(filters)}`;
}

function buildCatalogLotFilterQuery(filters: CatalogFilters) {
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

function hasActiveCatalogLotFilters(filters: CatalogFilters) {
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

function getCatalogMatchedLotsLabel(object: RealEstateObjectSummary, filters: CatalogFilters) {
  const matchedLotsCount = getCatalogMatchedLotsCount(object, filters);

  if (matchedLotsCount === null) {
    return null;
  }

  return `Найдено лотов: ${formatNumber(matchedLotsCount)}`;
}

function getCatalogMatchedLotsCount(object: RealEstateObjectSummary, filters: CatalogFilters) {
  if (
    !hasActiveCatalogLotFilters(filters) ||
    typeof object.matchedFeedUnitsCount !== 'number' ||
    !Number.isFinite(object.matchedFeedUnitsCount)
  ) {
    return null;
  }

  return object.matchedFeedUnitsCount;
}

function hasImportedLots(object: RealEstateObjectSummary) {
  return typeof object.feedUnitsCount !== 'number' || !Number.isFinite(object.feedUnitsCount)
    ? false
    : object.feedUnitsCount > 0;
}

function countActiveAdvancedFilters(filters: CatalogFilters) {
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

function buildObjectsParams(filters: CatalogFilters, includePage: boolean) {
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

function getCatalogPriceFrom(object: CatalogFeedFallbackObject) {
  return object.feedPriceFrom ?? object.priceFrom;
}

function getCatalogPricePerMeterFrom(object: CatalogFeedFallbackObject) {
  return object.feedPricePerMeterFrom ?? object.pricePerMeterFrom;
}

function getCatalogAreaRange(object: CatalogFeedFallbackObject) {
  return object.feedAreaRange ?? object.apartmentAreaRange;
}

function mapObjectToPoint(object: MapObject, filters: CatalogFilters): YandexMapPoint {
  return {
    id: object.id,
    title: object.title,
    hint: object.title,
    coordinates: [object.latitude, object.longitude],
    balloonHtml: buildMapBalloon(object, filters),
    markerLabel: resolveMapMarkerLabel(object),
  };
}

function isMapObjectInBounds(object: MapObject, bounds: YandexMapBounds) {
  const [[firstLatitude, firstLongitude], [secondLatitude, secondLongitude]] = bounds;
  const minLatitude = Math.min(firstLatitude, secondLatitude);
  const maxLatitude = Math.max(firstLatitude, secondLatitude);
  const minLongitude = Math.min(firstLongitude, secondLongitude);
  const maxLongitude = Math.max(firstLongitude, secondLongitude);

  return (
    object.latitude >= minLatitude &&
    object.latitude <= maxLatitude &&
    object.longitude >= minLongitude &&
    object.longitude <= maxLongitude
  );
}

function buildMapBalloon(object: MapObject, filters: CatalogFilters) {
  const title = escapeHtml(object.title);
  const district = escapeHtml(getObjectDistrictLabel(object));
  const developer = escapeHtml(object.developer?.name ?? 'Застройщик не указан');
  const price = escapeHtml(formatPriceFrom(getCatalogPriceFrom(object)));
  const completion = escapeHtml(formatCompletion(object.completionYear, object.completionQuarter));
  const href = escapeHtml(buildCatalogObjectHref(object.slug, filters));

  return [
    '<div class="map-balloon">',
    `<strong>${title}</strong>`,
    `<span>${district}</span>`,
    `<span>${developer}</span>`,
    `<span>${price}, ${completion}</span>`,
    `<a href="${href}" rel="noopener noreferrer" target="_blank">Открыть объект</a>`,
    '</div>',
  ].join('');
}

type CatalogObjectWithLocations = {
  address: string | null;
  primaryLocation: ObjectLocation | null;
  locations: ObjectLocationLink[];
};

function getObjectDistrictLabel(object: CatalogObjectWithLocations) {
  return getObjectDistrictLocation(object)?.name ?? object.address ?? 'Район не указан';
}

function getObjectDistrictLocation(object: CatalogObjectWithLocations) {
  if (object.primaryLocation?.type === 'DISTRICT') {
    return object.primaryLocation;
  }

  return object.locations.find((location) => location.type === 'DISTRICT') ?? null;
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

function parseCatalogPageSize(value: string | null): CatalogPageSize {
  const parsed = Number(value);

  return catalogPageSizeOptions.includes(parsed as CatalogPageSize)
    ? (parsed as CatalogPageSize)
    : defaultFilters.limit;
}

function getDefaultCatalogSortDirection(sortBy: CatalogSortField): SortDirection {
  return sortBy === 'completionDate' ? 'asc' : 'desc';
}

function toggleCatalogSortDirection(direction: SortDirection): SortDirection {
  return direction === 'asc' ? 'desc' : 'asc';
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

function getCatalogFilterIdValues(value: string) {
  return Array.from(
    new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function formatCatalogFilterIdValues(values: string[]) {
  return getCatalogFilterIdValues(values.join(',')).join(',');
}

function getRoomFilterValues(value: string) {
  const valueSet = new Set(
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

  return catalogRoomOptions.filter((option) => valueSet.has(option.value)).map((option) => option.value);
}

function formatRoomFilterValues(values: string[]) {
  const valueSet = new Set(values);

  return catalogRoomOptions
    .filter((option) => valueSet.has(option.value))
    .map((option) => option.value)
    .join(',');
}

function parsePositiveInteger(value: string | null, fallback: number) {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
}

function sanitizeIntegerText(value: string, maxLength: number) {
  return value.replace(/\D/g, '').slice(0, maxLength);
}

function sanitizeDecimalText(value: string) {
  return value.replace(/[^\d,.]/g, '').replace(',', '.').slice(0, 15);
}

function appendUniqueCatalogObjects(
  currentObjects: RealEstateObjectSummary[],
  nextObjects: RealEstateObjectSummary[],
) {
  const knownObjectIds = new Set(currentObjects.map((object) => object.id));
  const uniqueNextObjects = nextObjects.filter((object) => {
    if (knownObjectIds.has(object.id)) {
      return false;
    }

    knownObjectIds.add(object.id);

    return true;
  });

  return [...currentObjects, ...uniqueNextObjects];
}

function formatCatalogCount(isLoading: boolean, total: number) {
  return isLoading ? 'Загрузка' : `Всего: ${total}`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('ru-RU').format(value);
}

function formatPrice(value: string | null) {
  if (!value) {
    return 'Не указана';
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

function formatPriceFrom(value: string | null) {
  return value ? `от ${formatPrice(value)}` : 'Не указана';
}

function formatPricePerMeterFrom(value: string | null) {
  return value ? `от ${formatPrice(value)}/м²` : 'за м² не указана';
}

function formatMapListPricePerMeter(value: string | null) {
  return value ? `Цена за м²: ${formatPricePerMeterFrom(value)}` : 'Цена за м²: по запросу';
}

function formatMapCardPricePerMeter(value: string | null) {
  return value ? formatPricePerMeterFrom(value) : 'по запросу';
}

function formatRequestedPriceFrom(value: string | null) {
  return value ? formatPriceFrom(value) : 'по запросу';
}

function formatRequestedPricePerMeterFrom(value: string | null) {
  return value ? formatPricePerMeterFrom(value) : 'по запросу';
}

function formatCompactRussianNumber(value: number) {
  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: value < 10 ? 1 : 0,
  }).format(value);
}

function normalizeLineColor(value: string | null) {
  if (!value) {
    return null;
  }

  const trimmedValue = value.trim();

  return /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/iu.test(trimmedValue) ? trimmedValue : null;
}

function formatMetroStations(stations: ObjectMetroStationLink[]) {
  if (stations.length === 0) {
    return null;
  }

  const visibleStations = stations.slice(0, 2).map((station) => station.name);
  const hiddenCount = stations.length - visibleStations.length;

  return `Метро ${visibleStations.join(', ')}${hiddenCount > 0 ? ` +${hiddenCount}` : ''}`;
}

function formatListMetroStations(stations: ObjectMetroStationLink[]) {
  return formatMetroStations(stations)?.replace(/^Метро /, '') ?? null;
}

function formatCompletion(year: number | null, quarter: number | null) {
  if (!year) {
    return 'Не указан';
  }

  return quarter ? `${quarter} кв. ${year}` : String(year);
}

function formatListCompletion(year: number | null, quarter: number | null) {
  if (!year) {
    return 'Не указан';
  }

  return quarter ? `${quarter} кв. ${year} г.` : `${year} г.`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const replacements: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };

    return replacements[character] ?? character;
  });
}
