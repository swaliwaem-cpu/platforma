import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  LayoutGridIcon,
  ListIcon,
  MapIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SearchIcon,
} from 'lucide-react';
import type {
  CatalogLinksResponse,
  DevelopersResponse,
  LocationsResponse,
  MapObject,
  MapObjectsResponse,
  MapWalkingRoute,
  MapWalkingRoutesRequest,
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
  RealEstateObjectType,
} from '@platforma/shared';

import { notifyAppLocationChanged } from '../navigation/appLocation';
import { matchesSearchVariants } from '@platforma/shared/search-normalization';

import { apiRequest } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';
import { DropdownEmpty, DropdownListbox, DropdownOption, DropdownSearchInput } from '../components/Dropdown';
import {
  FilterPill,
  FilterPopoverFooter,
  formatCompactMoney,
  formatPillSelection,
  formatRangeValue,
} from '../components/FilterPill';
import { SelectDropdown } from '../components/SelectDropdown';
import { SecureImage } from '../files/SecureImage';
import { formatCurrencyInputValue, getCurrencyInputBackspaceValue } from '../lib/numberInput';
import { resolveMapMarkerLabel } from '../map/mapMarkerLabels';
import { formatMapDistance } from '../map/mapContract';
import {
  buildMetroLineLookup,
  resolveMetroLineMarker,
  type MetroLineLookup,
} from '../map/metroLineMarker';
import {
  PlatformMap,
  type MapBounds,
  type MapNearbyTransitResult,
  type MapPoint,
  type MapStatus,
  type MapViewport,
} from '../map/PlatformMap';
import aerotourIconUrl from '../../../../aerotour-icon.png';
import floorPlanIconUrl from '../../../../floor-plan.svg';

type CatalogPageProps = {
  navigate: (nextPathname: string) => void;
  pathname: string;
};

type BooleanFilter = '' | 'true' | 'false';
type CatalogObjectTypeFilter = RealEstateObjectType | 'ALL';
type CatalogStatusFilter = ObjectStatus | 'ALL';
type CatalogViewMode = 'cards' | 'list';
type CatalogSortField = 'createdAt' | 'priceFrom' | 'pricePerMeterFrom' | 'completionDate';
type CatalogPageSize = 25 | 50 | 75;
type MapWalkingRoutesState = {
  pointId: string | null;
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  routes: MapWalkingRoute[];
};
type SortDirection = 'asc' | 'desc';

type CatalogFilters = {
  search: string;
  developerId: string;
  krtName: string;
  locationId: string;
  areaId: string;
  metroStationId: string;
  objectType: CatalogObjectTypeFilter;
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
  objectType: 'ALL',
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
const catalogObjectTypeOptions: Array<{ value: CatalogObjectTypeFilter; label: string }> = [
  { value: 'ALL', label: 'Все' },
  { value: 'RESIDENTIAL', label: 'Жилая' },
  { value: 'COMMERCIAL', label: 'Коммерция' },
];
const catalogFilterSearchResultLimit = 24;
const catalogMapInitialViewport: MapViewport = {
  center: [55.751244, 37.618423],
  zoom: 11,
};

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
  const { accessToken, hasPermission } = useAuth();
  const [queryString, setQueryString] = useState(window.location.search);
  const routeObjectType = getCatalogRouteObjectType(pathname);
  const filters = useMemo(() => parseCatalogFilters(queryString, routeObjectType), [queryString, routeObjectType]);
  const viewMode = useMemo(() => parseCatalogViewMode(queryString), [queryString]);
  const isCatalogRoute = isCatalogListPath(pathname);
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

  function pushCatalogLocation(nextPathname: string, nextSearch: string) {
    if (nextPathname !== pathname) {
      navigate(`${nextPathname}${nextSearch}`);
    } else {
      window.history.pushState(null, '', `${nextPathname}${nextSearch}`);
      setQueryString(window.location.search);
      notifyAppLocationChanged();
    }
  }

  function updateFilters(patch: Partial<CatalogFilters>, options: { resetPage: boolean } = { resetPage: true }) {
    const nextFilters = {
      ...filters,
      ...patch,
      page: options.resetPage ? 1 : (patch.page ?? filters.page),
    };
    const nextPathname = getNextCatalogPathname(pathname, nextFilters.objectType);
    const shouldResetSearchResults = 'search' in patch && patch.search !== filters.search;
    const nextSearch = buildCatalogQuery(nextFilters, viewMode, {
      omitObjectType: shouldOmitCatalogObjectTypeParam(nextPathname),
    });

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

    pushCatalogLocation(nextPathname, nextSearch);
  }

  function resetFilters() {
    const nextFilters = {
      ...defaultFilters,
      objectType: routeObjectType ?? filters.objectType,
    };
    const nextPathname = getNextCatalogPathname(pathname, nextFilters.objectType);
    const nextSearch = buildCatalogQuery(nextFilters, viewMode, {
      omitObjectType: shouldOmitCatalogObjectTypeParam(nextPathname),
    });

    pushCatalogLocation(nextPathname, nextSearch);
  }

  function openCatalogViewMode(nextViewMode: CatalogViewMode) {
    if (isMapView) {
      navigate(
        `${getCatalogListPathname(filters.objectType)}${buildCatalogQuery(filters, nextViewMode, {
          omitObjectType: filters.objectType !== 'ALL',
        })}`,
      );
      return;
    }

    if (nextViewMode === viewMode) {
      return;
    }

    const nextSearch = buildCatalogQuery(filters, nextViewMode, {
      omitObjectType: shouldOmitCatalogObjectTypeParam(pathname),
    });

    pushCatalogLocation(pathname, nextSearch);
  }

  function openCatalogDeveloperLink(developerId: string) {
    const nextFilters = {
      ...defaultFilters,
      objectType: filters.objectType,
      developerId,
    };
    const nextPathname = getCatalogListPathname(nextFilters.objectType);
    const nextSearch = buildCatalogQuery(nextFilters, viewMode, {
      omitObjectType: shouldOmitCatalogObjectTypeParam(nextPathname),
    });

    pushCatalogLocation(nextPathname, nextSearch);
  }

  function openCatalogKrtLink(krtName: string) {
    const nextFilters = {
      ...defaultFilters,
      objectType: filters.objectType,
      krtName,
    };
    const nextPathname = getCatalogListPathname(nextFilters.objectType);
    const nextSearch = buildCatalogQuery(nextFilters, viewMode, {
      omitObjectType: shouldOmitCatalogObjectTypeParam(nextPathname),
    });

    pushCatalogLocation(nextPathname, nextSearch);
  }

  return (
    <div className="catalog-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Каталог</p>
          <h2>{getCatalogPageTitle(filters.objectType, isMapView)}</h2>
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

      <CatalogFilters
        directories={directories}
        filters={filters}
        isDirectoriesLoading={isDirectoriesLoading}
        onChange={updateFilters}
        onReset={resetFilters}
      />

      <CatalogResultsBar
        filters={filters}
        isLoading={isMapView ? isMapLoading : isLoading}
        isMapView={isMapView}
        total={isMapView ? mapTotal : total}
        viewMode={viewMode}
        onOpenMap={() => navigate(`/catalog/map${buildCatalogQuery(filters, viewMode)}`)}
        onSortChange={updateFilters}
        onViewModeChange={openCatalogViewMode}
      />

      {directoryError ? <p className="form-error">{directoryError}</p> : null}

      {isMapView ? (
        <CatalogMapView
          accessToken={accessToken ?? ''}
          canRefreshWalkingRoutes={hasPermission('admin:access')}
          error={mapError}
          filters={filters}
          isLoading={isMapLoading}
          metroStations={directories.metroStations}
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
  const panelRef = useRef<HTMLElement | null>(null);
  const isStuck = useCatalogStickyPanel(panelRef);
  const selectedObjectType = catalogObjectTypeOptions.find((option) => option.value === filters.objectType);
  const selectedRoomValues = getRoomFilterValues(filters.lotRooms);
  const priceValue = formatCatalogPriceFilterValue(filters);
  const floorValue = formatRangeValue(filters.lotFloorMin, filters.lotFloorMax, (value) => value);
  const completionYearOptions = getCatalogCompletionYearOptions(filters.completionYear);

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
    <section
      ref={panelRef}
      className={isStuck ? 'catalog-filters is-stuck' : 'catalog-filters'}
      aria-label="Фильтры каталога"
    >
      <div className="catalog-filter-search-row">
        <label className="catalog-filter-search">
          <span className="sr-only">Поиск</span>
          <span className="catalog-filter-search-field">
            <SearchIcon aria-hidden="true" />
            <input
              placeholder="Название, адрес, застройщик"
              type="search"
              value={filters.search}
              onChange={(event) => onChange({ search: event.target.value })}
            />
          </span>
        </label>

        <div className="catalog-filter-header-actions">
          <button
            aria-label="Сбросить фильтры"
            className="catalog-filter-reset"
            disabled={!filters.search && countActiveAdvancedFilters(filters) === 0}
            type="button"
            onClick={onReset}
          >
            <RotateCcwIcon aria-hidden="true" className="catalog-filter-reset-icon" />
            <span>Сбросить</span>
          </button>
        </div>
      </div>

      <div className="catalog-filter-bar" role="group" aria-label="Параметры подбора">
        <FilterPill
          ariaLabel="Фильтр каталога по разделу"
          isSet={filters.objectType !== 'ALL'}
          label="Все разделы"
          value={selectedObjectType?.label ?? ''}
        >
          {(close) => (
            <DropdownListbox aria-label="Фильтр каталога по разделу">
              {catalogObjectTypeOptions.map((option) => (
                <DropdownOption
                  key={option.value}
                  label={option.value === 'ALL' ? 'Все разделы' : option.label}
                  selected={option.value === filters.objectType}
                  onSelect={() => {
                    onChange({ objectType: option.value });
                    close('select');
                  }}
                />
              ))}
            </DropdownListbox>
          )}
        </FilterPill>

        <span aria-hidden="true" className="catalog-filter-divider" />

        <CatalogFilterSearchSelect
          ariaLabel="Фильтр каталога по застройщику"
          disabled={isDirectoriesLoading}
          emptyLabel="Застройщики не найдены"
          getOptionLabel={(developer) => developer.name}
          getSearchValues={(developer) => [developer.name, developer.slug]}
          label="Застройщик"
          options={directories.developers}
          placeholder="Все застройщики"
          searchPlaceholder="Поиск застройщика"
          selectedIds={getCatalogFilterIdValues(filters.developerId)}
          onSelectedIdsChange={(developerIds) =>
            onChange({ developerId: formatCatalogFilterIdValues(developerIds) })
          }
        />

        <CatalogFilterSearchSelect
          ariaLabel="Фильтр каталога по району"
          disabled={isDirectoriesLoading}
          emptyLabel="Районы не найдены"
          getOptionLabel={(location) => location.name}
          getSearchValues={(location) => [location.name, location.slug]}
          label="Район"
          options={directories.districtLocations}
          placeholder="Все районы"
          searchPlaceholder="Поиск района"
          selectedIds={getCatalogFilterIdValues(filters.locationId)}
          onSelectedIdsChange={(locationIds) =>
            onChange({ locationId: formatCatalogFilterIdValues(locationIds) })
          }
        />

        <CatalogFilterSearchSelect
          ariaLabel="Фильтр каталога по окружению"
          disabled={isDirectoriesLoading}
          emptyLabel="Окружение не найдено"
          getOptionLabel={(location) => location.name}
          getSearchValues={(location) => [location.name, location.slug]}
          label="Окружение"
          options={directories.areaLocations}
          placeholder="Все окружения"
          searchPlaceholder="Поиск окружения"
          selectedIds={getCatalogFilterIdValues(filters.areaId)}
          onSelectedIdsChange={(areaIds) => onChange({ areaId: formatCatalogFilterIdValues(areaIds) })}
        />

        <CatalogFilterSearchSelect
          ariaLabel="Фильтр каталога по метро"
          disabled={isDirectoriesLoading}
          emptyLabel="Метро не найдено"
          getOptionLabel={(station) => (station.lineName ? `${station.name}, ${station.lineName}` : station.name)}
          getPillLabel={(station) => station.name}
          getSearchValues={(station) => [station.name, station.slug, station.lineName]}
          label="Метро"
          options={directories.metroStations}
          placeholder="Все станции"
          searchPlaceholder="Поиск метро"
          selectedIds={getCatalogFilterIdValues(filters.metroStationId)}
          onSelectedIdsChange={(metroStationIds) =>
            onChange({ metroStationId: formatCatalogFilterIdValues(metroStationIds) })
          }
        />

        <FilterPill
          ariaLabel="Фильтр каталога по сроку сдачи"
          isSet={Boolean(filters.completionYear)}
          label="Срок сдачи"
          value={filters.completionYear}
        >
          {(close) => (
            <DropdownListbox aria-label="Фильтр каталога по сроку сдачи">
              <DropdownOption
                label="Любой срок"
                selected={!filters.completionYear}
                onSelect={() => {
                  onChange({ completionYear: '' });
                  close('select');
                }}
              />
              {completionYearOptions.map((year) => (
                <DropdownOption
                  key={year}
                  label={year}
                  selected={year === filters.completionYear}
                  onSelect={() => {
                    onChange({ completionYear: year });
                    close('select');
                  }}
                />
              ))}
            </DropdownListbox>
          )}
        </FilterPill>

        <span aria-hidden="true" className="catalog-filter-divider" />

        <FilterPill
          ariaLabel="Фильтр каталога по цене"
          isSet={Boolean(priceValue)}
          label="Цена"
          menuClassName="catalog-filter-popover"
          value={priceValue}
        >
          {(close) => (
            <>
              <div className="catalog-filter-range" aria-label="Диапазон цены лота" role="group">
                <span className="catalog-filter-range-title">Цена лота</span>
                <div className="catalog-filter-range-field">
                  <label>
                    от
                    <input
                      inputMode="decimal"
                      placeholder="0 ₽"
                      type="text"
                      value={formatCurrencyInputValue(filters.lotPriceMin)}
                      onChange={(event) => onChange({ lotPriceMin: sanitizeDecimalText(event.target.value) })}
                      onKeyDown={(event) => handleCurrencyInputBackspace(event, 'lotPriceMin')}
                    />
                  </label>
                  <i aria-hidden="true" />
                  <label>
                    до
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
              </div>

              <div className="catalog-filter-range" aria-label="Диапазон цены за метр лота" role="group">
                <span className="catalog-filter-range-title">Цена за м²</span>
                <div className="catalog-filter-range-field">
                  <label>
                    от
                    <input
                      inputMode="decimal"
                      placeholder="0 ₽"
                      type="text"
                      value={formatCurrencyInputValue(filters.lotPricePerMeterMin)}
                      onChange={(event) => onChange({ lotPricePerMeterMin: sanitizeDecimalText(event.target.value) })}
                      onKeyDown={(event) => handleCurrencyInputBackspace(event, 'lotPricePerMeterMin')}
                    />
                  </label>
                  <i aria-hidden="true" />
                  <label>
                    до
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

              <FilterPopoverFooter
                onClear={() => onChange({ lotPriceMin: '', lotPriceMax: '', lotPricePerMeterMin: '', lotPricePerMeterMax: '' })}
                onDone={() => close('select')}
              />
            </>
          )}
        </FilterPill>

        <FilterPill
          ariaLabel="Фильтр каталога по комнатам"
          isSet={selectedRoomValues.length > 0}
          label="Комнаты"
          value={formatPillSelection(
            catalogRoomOptions.filter((option) => selectedRoomValues.includes(option.value)).map((option) => option.label),
          )}
        >
          {() => (
            <DropdownListbox aria-label="Фильтр каталога по комнатам" aria-multiselectable={true}>
              <DropdownOption
                label="Любые лоты"
                selected={selectedRoomValues.length === 0}
                onSelect={() => onChange({ lotRooms: '' })}
              />
              {catalogRoomOptions.map((option) => (
                <DropdownOption
                  key={option.value}
                  label={option.label}
                  selected={selectedRoomValues.includes(option.value)}
                  onSelect={() =>
                    onChange({
                      lotRooms: formatRoomFilterValues(
                        selectedRoomValues.includes(option.value)
                          ? selectedRoomValues.filter((value) => value !== option.value)
                          : [...selectedRoomValues, option.value],
                      ),
                    })
                  }
                />
              ))}
            </DropdownListbox>
          )}
        </FilterPill>

        <FilterPill
          ariaLabel="Фильтр каталога по этажу"
          isSet={Boolean(floorValue)}
          label="Этаж"
          menuClassName="catalog-filter-popover"
          value={floorValue}
        >
          {(close) => (
            <>
              <div className="catalog-filter-range" aria-label="Диапазон этажа лота" role="group">
                <span className="catalog-filter-range-title">Этаж</span>
                <div className="catalog-filter-range-field">
                  <label>
                    от
                    <input
                      inputMode="numeric"
                      placeholder="1"
                      type="text"
                      value={filters.lotFloorMin}
                      onChange={(event) => onChange({ lotFloorMin: sanitizeIntegerText(event.target.value, 3) })}
                    />
                  </label>
                  <i aria-hidden="true" />
                  <label>
                    до
                    <input
                      inputMode="numeric"
                      placeholder="25"
                      type="text"
                      value={filters.lotFloorMax}
                      onChange={(event) => onChange({ lotFloorMax: sanitizeIntegerText(event.target.value, 3) })}
                    />
                  </label>
                </div>
              </div>

              <FilterPopoverFooter
                onClear={() => onChange({ lotFloorMin: '', lotFloorMax: '' })}
                onDone={() => close('select')}
              />
            </>
          )}
        </FilterPill>
      </div>
    </section>
  );
}

/** Marks the filter panel while it is pinned to the top of the viewport. */
function useCatalogStickyPanel(panelRef: RefObject<HTMLElement | null>) {
  const [isStuck, setIsStuck] = useState(false);

  useEffect(() => {
    const panel = panelRef.current;

    if (!panel) {
      return;
    }

    let frameId = 0;

    const update = () => {
      frameId = 0;
      const stickyTop = Number.parseFloat(getComputedStyle(panel).top);

      setIsStuck(Number.isFinite(stickyTop) && window.scrollY > 0 && panel.getBoundingClientRect().top <= stickyTop + 0.5);
    };
    const scheduleUpdate = () => {
      if (!frameId) {
        frameId = window.requestAnimationFrame(update);
      }
    };

    update();
    window.addEventListener('scroll', scheduleUpdate, { passive: true });
    window.addEventListener('resize', scheduleUpdate);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('scroll', scheduleUpdate);
      window.removeEventListener('resize', scheduleUpdate);
    };
  }, [panelRef]);

  return isStuck;
}

function formatCatalogPriceFilterValue(filters: CatalogFilters) {
  const lotPrice = formatRangeValue(filters.lotPriceMin, filters.lotPriceMax, formatCompactMoney);
  const pricePerMeter = formatRangeValue(
    filters.lotPricePerMeterMin,
    filters.lotPricePerMeterMax,
    formatCompactMoney,
  );

  if (lotPrice && pricePerMeter) {
    return `${lotPrice} +1`;
  }

  return lotPrice || (pricePerMeter ? `за м² ${pricePerMeter}` : '');
}

function getCatalogCompletionYearOptions(selectedYear: string) {
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 9 }, (_, index) => String(currentYear - 1 + index));

  if (selectedYear && !years.includes(selectedYear)) {
    years.push(selectedYear);
    years.sort();
  }

  return years;
}

type CatalogFilterSearchSelectOption = {
  id: string;
};

function CatalogFilterSearchSelect<T extends CatalogFilterSearchSelectOption>({
  ariaLabel,
  disabled = false,
  emptyLabel,
  getOptionLabel,
  getPillLabel = getOptionLabel,
  getSearchValues,
  label,
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
  getPillLabel?: (option: T) => string;
  getSearchValues: (option: T) => Array<string | null | undefined>;
  label: string;
  options: T[];
  placeholder: string;
  searchPlaceholder: string;
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const listboxId = useId();
  const selectedValueSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedOptions = useMemo(
    () => options.filter((option) => selectedValueSet.has(option.id)),
    [options, selectedValueSet],
  );
  const hasSelectedOptions = selectedOptions.length > 0;
  const filteredOptions = useMemo(() => {
    const matchedOptions = options.filter((option) => matchesSearchVariants(query, getSearchValues(option)));

    return matchedOptions.slice(0, catalogFilterSearchResultLimit);
  }, [getSearchValues, options, query]);

  function clearSelection() {
    onSelectedIdsChange([]);
    setQuery('');
  }

  function toggleOption(optionId: string) {
    const nextIds = selectedValueSet.has(optionId)
      ? selectedIds.filter((id) => id !== optionId)
      : [...selectedIds, optionId];

    onSelectedIdsChange(nextIds);
  }

  return (
    <FilterPill
      ariaLabel={ariaLabel}
      disabled={disabled}
      isSet={hasSelectedOptions}
      label={label}
      value={formatPillSelection(selectedOptions.map((option) => getPillLabel(option)))}
    >
      {() => (
        <>
          <DropdownSearchInput
            aria-controls={listboxId}
            aria-label={`${ariaLabel}: поиск`}
            placeholder={searchPlaceholder}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && filteredOptions[0]) {
                event.preventDefault();
                toggleOption(filteredOptions[0].id);
              }
            }}
          />
          <DropdownListbox id={listboxId} aria-label={ariaLabel} aria-multiselectable={true}>
            <DropdownOption label={placeholder} selected={!hasSelectedOptions} onSelect={clearSelection} />

            {filteredOptions.length > 0 ? (
              filteredOptions.map((option) => (
                <DropdownOption
                  key={option.id}
                  label={getOptionLabel(option)}
                  selected={selectedValueSet.has(option.id)}
                  onSelect={() => toggleOption(option.id)}
                />
              ))
            ) : (
              <DropdownEmpty>{emptyLabel}</DropdownEmpty>
            )}
          </DropdownListbox>
        </>
      )}
    </FilterPill>
  );
}

type CatalogSortOption = { sortBy: CatalogSortField; sortDirection: SortDirection; label: string };

const defaultCatalogSortOption: CatalogSortOption = { sortBy: 'createdAt', sortDirection: 'desc', label: 'Сначала новые' };

const catalogSortOptions: ReadonlyArray<CatalogSortOption> = [
  defaultCatalogSortOption,
  { sortBy: 'createdAt', sortDirection: 'asc', label: 'Сначала старые' },
  { sortBy: 'priceFrom', sortDirection: 'asc', label: 'Сначала дешевле' },
  { sortBy: 'priceFrom', sortDirection: 'desc', label: 'Сначала дороже' },
  { sortBy: 'pricePerMeterFrom', sortDirection: 'asc', label: 'Дешевле за м²' },
  { sortBy: 'pricePerMeterFrom', sortDirection: 'desc', label: 'Дороже за м²' },
  { sortBy: 'completionDate', sortDirection: 'asc', label: 'Сначала ранняя сдача' },
  { sortBy: 'completionDate', sortDirection: 'desc', label: 'Сначала поздняя сдача' },
];

const catalogViewModeOptions: ReadonlyArray<{ value: CatalogViewMode; label: string; icon: typeof LayoutGridIcon }> = [
  { value: 'cards', label: 'Карточки', icon: LayoutGridIcon },
  { value: 'list', label: 'Список', icon: ListIcon },
];

function CatalogResultsBar({
  filters,
  isLoading,
  isMapView,
  total,
  viewMode,
  onOpenMap,
  onSortChange,
  onViewModeChange,
}: {
  filters: CatalogFilters;
  isLoading: boolean;
  isMapView: boolean;
  total: number;
  viewMode: CatalogViewMode;
  onOpenMap: () => void;
  onSortChange: (patch: Partial<CatalogFilters>, options?: { resetPage: boolean }) => void;
  onViewModeChange: (viewMode: CatalogViewMode) => void;
}) {
  return (
    <div className="catalog-results-bar">
      <p className="catalog-results-count" aria-live="polite">
        {isLoading ? (
          'Загрузка'
        ) : (
          <>
            <b>{formatNumber(total)}</b> {formatCatalogObjectsWord(total)} в подборке
          </>
        )}
      </p>

      <div className="catalog-view-segmented" role="group" aria-label="Вид каталога">
        {catalogViewModeOptions.map((option) => {
          const isActive = !isMapView && viewMode === option.value;
          const Icon = option.icon;

          return (
            <button
              key={option.value}
              aria-pressed={isActive}
              className={isActive ? 'catalog-view-segment is-active' : 'catalog-view-segment'}
              type="button"
              onClick={() => onViewModeChange(option.value)}
            >
              <Icon aria-hidden="true" />
              {option.label}
            </button>
          );
        })}
      </div>

      <button
        aria-current={isMapView ? 'page' : undefined}
        className={isMapView ? 'catalog-results-map-button is-active' : 'catalog-results-map-button'}
        type="button"
        onClick={onOpenMap}
      >
        <MapIcon aria-hidden="true" />
        На карте
      </button>

      {!isMapView ? <CatalogSortSelect filters={filters} onChange={onSortChange} /> : null}
    </div>
  );
}

function CatalogSortSelect({
  filters,
  onChange,
}: {
  filters: CatalogFilters;
  onChange: (patch: Partial<CatalogFilters>, options?: { resetPage: boolean }) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const shouldFocusSelectedOptionRef = useRef(false);
  const listboxId = useId();
  const selectedOption =
    catalogSortOptions.find(
      (option) => option.sortBy === filters.sortBy && option.sortDirection === filters.sortDirection,
    ) ?? defaultCatalogSortOption;

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    if (shouldFocusSelectedOptionRef.current) {
      shouldFocusSelectedOptionRef.current = false;
      containerRef.current?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')?.focus();
    }

    const handleDocumentPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && containerRef.current?.contains(event.target)) {
        return;
      }

      setIsOpen(false);
    };

    document.addEventListener('pointerdown', handleDocumentPointerDown);

    return () => document.removeEventListener('pointerdown', handleDocumentPointerDown);
  }, [isOpen]);

  function selectOption(option: CatalogSortOption) {
    setIsOpen(false);
    triggerRef.current?.focus();

    if (option !== selectedOption) {
      onChange({ sortBy: option.sortBy, sortDirection: option.sortDirection });
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && isOpen) {
      event.preventDefault();
      setIsOpen(false);
      triggerRef.current?.focus();
      return;
    }

    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }

    event.preventDefault();

    if (!isOpen) {
      shouldFocusSelectedOptionRef.current = true;
      setIsOpen(true);
      return;
    }

    const options = Array.from(containerRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
    const currentIndex = options.findIndex((option) => option === document.activeElement);
    const nextIndex =
      currentIndex < 0
        ? event.key === 'ArrowDown'
          ? 0
          : options.length - 1
        : (currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;

    options[nextIndex]?.focus();
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }

    setIsOpen(false);
  }

  return (
    <div
      ref={containerRef}
      className={isOpen ? 'catalog-sort is-open' : 'catalog-sort'}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      <button
        ref={triggerRef}
        aria-controls={isOpen ? listboxId : undefined}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={`Сортировка: ${selectedOption.label}`}
        className="catalog-sort-trigger"
        type="button"
        onClick={() => setIsOpen((currentValue) => !currentValue)}
      >
        <span>{selectedOption.label}</span>
        <ChevronRightIcon aria-hidden="true" />
      </button>

      {isOpen ? (
        <div id={listboxId} className="catalog-sort-menu" role="listbox" aria-label="Сортировка">
          {catalogSortOptions.map((option) => {
            const isSelected = option === selectedOption;

            return (
              <button
                key={`${option.sortBy}-${option.sortDirection}`}
                aria-selected={isSelected}
                className={isSelected ? 'catalog-sort-option is-active' : 'catalog-sort-option'}
                role="option"
                type="button"
                onClick={() => selectOption(option)}
              >
                <span>{option.label}</span>
                {isSelected ? <CheckIcon aria-hidden="true" className="multi-select-dropdown-check" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
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
              <SelectDropdown
                ariaLabel="Выбор страницы каталога"
                className="catalog-pagination-select"
                options={pageOptions.map((page) => ({ value: String(page), label: String(page) }))}
                value={String(filters.page)}
                onChange={(page) => onPageChange(parsePositiveInteger(page, 1))}
              />
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
            <SelectDropdown
              ariaLabel="Количество объектов на странице"
              className="catalog-pagination-select"
              options={catalogPageSizeOptions.map((limit) => ({ value: String(limit), label: String(limit) }))}
              value={String(filters.limit)}
              onChange={(limit) => onLimitChange(parseCatalogPageSize(limit))}
            />
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
  canRefreshWalkingRoutes,
  error,
  filters,
  isLoading,
  metroStations,
  objects,
  total,
}: {
  accessToken: string;
  canRefreshWalkingRoutes: boolean;
  error: string | null;
  filters: CatalogFilters;
  isLoading: boolean;
  metroStations: ObjectMetroStation[];
  objects: MapObject[];
  total: number;
}) {
  const [visibleBounds, setVisibleBounds] = useState<MapBounds | null>(null);
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [isListVisible, setIsListVisible] = useState(true);
  const [mapStatus, setMapStatus] = useState<MapStatus>('loading');
  const [nearbyTransit, setNearbyTransit] = useState<MapNearbyTransitResult>({
    pointId: null,
    status: 'idle',
    stations: [],
  });
  const [walkingRoutes, setWalkingRoutes] = useState<MapWalkingRoutesState>({
    pointId: null,
    status: 'idle',
    routes: [],
  });
  const [walkingRoutesRetryKey, setWalkingRoutesRetryKey] = useState(0);
  const walkingRoutesRequestRef = useRef(0);
  const forceWalkingRoutesRefreshRef = useRef(false);
  const points = useMemo(() => objects.map((object) => mapObjectToPoint(object, filters)), [filters, objects]);
  const metroLineLookup = useMemo(() => buildMetroLineLookup(metroStations), [metroStations]);
  const visibleObjects = useMemo(
    () => (visibleBounds ? objects.filter((object) => isMapObjectInBounds(object, visibleBounds)) : objects),
    [objects, visibleBounds],
  );
  const selectedObject = useMemo(
    () => objects.find((object) => object.id === selectedObjectId) ?? null,
    [objects, selectedObjectId],
  );
  const handleBoundsChange = useCallback((bounds: MapBounds) => {
    setVisibleBounds((current) => (
      current && areMapBoundsEqual(current, bounds) ? current : bounds
    ));
  }, []);
  const handleSelectObject = useCallback((objectId: string) => {
    setSelectedObjectId(objectId);
    setNearbyTransit({
      pointId: objectId,
      status: mapStatus === 'error' || mapStatus === 'disabled' ? 'unavailable' : 'loading',
      stations: [],
    });
  }, [mapStatus]);
  const handleSelectPoint = useCallback((point: MapPoint) => handleSelectObject(point.id), [handleSelectObject]);
  const handleCloseObject = useCallback(() => {
    setSelectedObjectId(null);
    setNearbyTransit({ pointId: null, status: 'idle', stations: [] });
  }, []);
  const handleRetryWalkingRoutes = useCallback(() => {
    setWalkingRoutesRetryKey((current) => current + 1);
  }, []);
  const handleRefreshWalkingRoutes = useCallback(() => {
    forceWalkingRoutesRefreshRef.current = true;
    setWalkingRoutesRetryKey((current) => current + 1);
  }, []);
  const handleMapStatusChange = useCallback((status: MapStatus) => {
    setMapStatus(status);

    if (status === 'error' || status === 'disabled') {
      setNearbyTransit((current) =>
        current.pointId ? { pointId: current.pointId, status: 'unavailable', stations: [] } : current,
      );
    }
  }, []);

  useEffect(() => {
    setVisibleBounds(null);
  }, [objects]);

  useEffect(() => {
    if (selectedObjectId && !objects.some((object) => object.id === selectedObjectId)) {
      setSelectedObjectId(null);
    }
  }, [objects, selectedObjectId]);

  useEffect(() => {
    const requestId = walkingRoutesRequestRef.current + 1;
    walkingRoutesRequestRef.current = requestId;
    const stations =
      selectedObject && nearbyTransit.pointId === selectedObject.id && nearbyTransit.status === 'ready'
        ? nearbyTransit.stations.slice(0, 3)
        : [];

    if (!selectedObject || stations.length === 0) {
      setWalkingRoutes({ pointId: selectedObject?.id ?? null, status: 'idle', routes: [] });
      return;
    }

    const controller = new AbortController();
    const shouldForceRefresh = forceWalkingRoutesRefreshRef.current;
    forceWalkingRoutesRefreshRef.current = false;
    const request: MapWalkingRoutesRequest = {
      origin: [selectedObject.latitude, selectedObject.longitude],
      destinations: stations.map((station) => station.coordinates),
    };

    setWalkingRoutes({ pointId: selectedObject.id, status: 'loading', routes: [] });

    void apiRequest<unknown>(
      shouldForceRefresh ? '/map/walking-routes/refresh' : '/map/walking-routes',
      accessToken,
      {
        body: JSON.stringify(request),
        method: 'POST',
        signal: controller.signal,
      },
    )
      .then((response) => {
        if (walkingRoutesRequestRef.current !== requestId) {
          return;
        }

        setWalkingRoutes({
          pointId: selectedObject.id,
          status: 'ready',
          routes: parseMapWalkingRoutesResponse(response, stations.length),
        });
      })
      .catch(() => {
        if (!controller.signal.aborted && walkingRoutesRequestRef.current === requestId) {
          setWalkingRoutes({ pointId: selectedObject.id, status: 'unavailable', routes: [] });
        }
      });

    return () => controller.abort();
  }, [accessToken, nearbyTransit, selectedObject, walkingRoutesRetryKey]);

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
          canRefreshWalkingRoutes={canRefreshWalkingRoutes}
          filters={filters}
          metroLineLookup={metroLineLookup}
          nearbyTransit={nearbyTransit.pointId === selectedObject.id ? nearbyTransit : null}
          object={selectedObject}
          onClose={handleCloseObject}
          onRefreshWalkingRoutes={handleRefreshWalkingRoutes}
          onRetryWalkingRoutes={handleRetryWalkingRoutes}
          walkingRoutes={walkingRoutes.pointId === selectedObject.id ? walkingRoutes : null}
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
                  <button className="text-button" type="button" onClick={() => handleSelectObject(object.id)}>
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
        <PlatformMap
          controlsPosition="top-left"
          initialViewport={catalogMapInitialViewport}
          onBoundsChange={handleBoundsChange}
          onNearbyTransitChange={setNearbyTransit}
          onStatusChange={handleMapStatusChange}
          points={points}
          selectedPointId={selectedObjectId}
          onSelectPoint={handleSelectPoint}
        >
          {shouldRenderOverlayInsideMap ? mapOverlay : null}
        </PlatformMap>

        {shouldRenderOverlayInsideMap ? null : mapOverlay}
      </div>
    </section>
  );
}

function MapObjectCard({
  accessToken,
  canRefreshWalkingRoutes,
  filters,
  metroLineLookup,
  nearbyTransit,
  object,
  onClose,
  onRefreshWalkingRoutes,
  onRetryWalkingRoutes,
  walkingRoutes,
}: {
  accessToken: string;
  canRefreshWalkingRoutes: boolean;
  filters: CatalogFilters;
  metroLineLookup: MetroLineLookup;
  nearbyTransit: MapNearbyTransitResult | null;
  object: MapObject;
  onClose: () => void;
  onRefreshWalkingRoutes: () => void;
  onRetryWalkingRoutes: () => void;
  walkingRoutes: MapWalkingRoutesState | null;
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
  const isWalkingRoutesLoading = walkingRoutes?.status === 'loading';
  const walkingRoutesByDestination = new Map(
    walkingRoutes?.routes.map((route) => [route.destinationIndex, route]) ?? [],
  );

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
        <section className="map-nearby-metro" aria-labelledby="map-nearby-metro-title">
          <div className="map-nearby-metro-heading">
            <h4 id="map-nearby-metro-title">Ближайшее метро пешком</h4>
            {canRefreshWalkingRoutes && nearbyTransit?.status === 'ready' ? (
              <button
                aria-busy={isWalkingRoutesLoading}
                aria-label="Обновить маршруты метро"
                className="map-nearby-metro-refresh"
                disabled={isWalkingRoutesLoading}
                type="button"
                onClick={onRefreshWalkingRoutes}
              >
                <RefreshCwIcon
                  aria-hidden="true"
                  className={isWalkingRoutesLoading ? 'map-nearby-metro-refresh-icon--loading' : undefined}
                />
              </button>
            ) : null}
          </div>
          {!nearbyTransit || nearbyTransit.status === 'loading' ? (
            <p className="map-nearby-metro-status" role="status">
              Ищем станции рядом…
            </p>
          ) : null}
          {nearbyTransit?.status === 'ready' && (!walkingRoutes || walkingRoutes.status === 'loading') ? (
            <p className="map-nearby-metro-status" role="status">
              Строим пешие маршруты…
            </p>
          ) : null}
          {nearbyTransit?.status === 'ready' && walkingRoutes?.status === 'ready' ? (
            <>
              <ol className="map-nearby-metro-list">
                {nearbyTransit.stations.slice(0, 3).map((station, destinationIndex) => {
                  const route = walkingRoutesByDestination.get(destinationIndex);
                  const lineMarker = resolveMetroLineMarker(station.name, metroLineLookup);

                  return (
                    <li key={`${station.name}-${station.coordinates.join('-')}`}>
                      <span
                        aria-hidden={lineMarker.label ? undefined : true}
                        aria-label={lineMarker.label ? `Линии метро: ${lineMarker.label}` : undefined}
                        className="map-nearby-metro-icon"
                        role={lineMarker.label ? 'img' : undefined}
                        style={lineMarker.background ? { background: lineMarker.background } : undefined}
                        title={lineMarker.label ?? undefined}
                      />
                      <span>{station.name}</span>
                      <strong>
                        {route && route.distanceMeters !== null && route.durationSeconds !== null
                          ? `${formatMapDistance(route.distanceMeters)} · ${formatWalkingDuration(route.durationSeconds)}`
                          : 'Маршрут не найден'}
                      </strong>
                    </li>
                  );
                })}
              </ol>
            </>
          ) : null}
          {nearbyTransit?.status === 'ready' && walkingRoutes?.status === 'unavailable' ? (
            <>
              <p className="map-nearby-metro-status">Пешие маршруты временно недоступны.</p>
              <button
                aria-label="Повторить построение маршрутов"
                className="text-button map-nearby-metro-retry"
                type="button"
                onClick={onRetryWalkingRoutes}
              >
                Повторить
              </button>
            </>
          ) : null}
          {nearbyTransit?.status === 'unavailable' ? (
            <p className="map-nearby-metro-status">Не удалось определить станции по данным текущей подложки.</p>
          ) : null}
        </section>
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

function parseMapWalkingRoutesResponse(response: unknown, destinationsCount: number): MapWalkingRoute[] {
  if (!response || typeof response !== 'object' || !Array.isArray((response as { routes?: unknown }).routes)) {
    throw new Error('Walking routes response is invalid');
  }

  const routes = (response as { routes: unknown[] }).routes;
  const destinationIndexes = new Set<number>();

  if (routes.length !== destinationsCount) {
    throw new Error('Walking routes response is invalid');
  }

  const parsedRoutes = routes.map((route) => {
    if (!route || typeof route !== 'object') {
      throw new Error('Walking routes response is invalid');
    }

    const candidate = route as Record<string, unknown>;

    if (
      !Number.isInteger(candidate.destinationIndex) ||
      (candidate.destinationIndex as number) < 0 ||
      (candidate.destinationIndex as number) >= destinationsCount ||
      destinationIndexes.has(candidate.destinationIndex as number) ||
      !isNullableRouteMetric(candidate.distanceMeters) ||
      !isNullableRouteMetric(candidate.durationSeconds)
    ) {
      throw new Error('Walking routes response is invalid');
    }

    const parsedRoute: MapWalkingRoute = {
      destinationIndex: candidate.destinationIndex as number,
      distanceMeters: candidate.distanceMeters as number | null,
      durationSeconds: candidate.durationSeconds as number | null,
    };
    destinationIndexes.add(parsedRoute.destinationIndex);

    return parsedRoute;
  });

  return parsedRoutes;
}

function isNullableRouteMetric(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function formatWalkingDuration(durationSeconds: number) {
  return `${Math.max(1, Math.ceil(durationSeconds / 60)).toLocaleString('ru-RU')} мин`;
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
  const districtLabel = getObjectDistrictLabel(object);
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
        {matchedLotsLabel ? <span className="catalog-matched-lots-badge">{matchedLotsLabel}</span> : null}
      </a>

      <div className="catalog-list-item-body">
        <span className="catalog-card-meta">
          {districtLabel}
          <CatalogCardMetroLabel stations={object.metroStations} />
        </span>
        <h3>
          <a href={objectHref} rel="noopener noreferrer" target="_blank" title={object.title}>
            {object.title}
          </a>
        </h3>
        <p className="catalog-list-item-price">{formatRequestedPriceFrom(getCatalogPriceFrom(object))}</p>
        <span className="catalog-card-price-per-meter">
          {formatRequestedPricePerMeterFrom(getCatalogPricePerMeterFrom(object))}
        </span>
        <div className="catalog-card-facts catalog-list-item-facts">
          <span>Срок · {formatCatalogCardFact(formatCompletion(object.completionYear, object.completionQuarter))}</span>
          <span>Площадь · {formatCatalogCardFact(areaLabel)}</span>
          <span>Застройщик · {object.developer?.name ?? '—'}</span>
        </div>
      </div>

      <div className="catalog-list-item-action">
        <a className="catalog-list-item-link" href={objectHref} rel="noopener noreferrer" target="_blank">
          Открыть объект
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
  const hasAerotourBadge = hasExternalObjectUrl(object.aerotourUrl);
  const hasVisibleBadges = object.status !== 'PUBLISHED' || hasPresentation || hasImportedLotsBadge || hasAerotourBadge;
  const districtLabel = getObjectDistrictLabel(object);
  const areaLabel = getCatalogAreaRange(object) ?? 'Не указано';
  const developerName = object.developer?.name ?? null;

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
        {hasVisibleBadges || developerName ? (
          <span className="catalog-card-badges">
            <span className="catalog-card-labels">
              {object.status === 'PUBLISHED' ? null : (
                <span className={`status-pill catalog-card-status object-status object-status--${object.status.toLowerCase()}`}>
                  {objectStatusLabels[object.status]}
                </span>
              )}
              {developerName ? (
                <span className="catalog-card-media-label" title={`Застройщик: ${developerName}`}>
                  {developerName}
                </span>
              ) : null}
            </span>
            {hasPresentation || hasImportedLotsBadge || hasAerotourBadge ? (
              <span className="catalog-card-document-badges">
                {hasImportedLotsBadge ? (
                  <span
                    className="catalog-card-floor-plan-badge"
                    aria-label="Есть импортированные лоты"
                    title="Есть импортированные лоты"
                  >
                    <span
                      aria-hidden="true"
                      className="catalog-card-floor-plan-icon"
                      style={getCatalogCardIconMaskStyle(floorPlanIconUrl)}
                    />
                  </span>
                ) : null}
                {hasAerotourBadge ? (
                  <span className="catalog-card-aerotour-badge" aria-label="Есть аэротур" title="Есть аэротур">
                    <span
                      aria-hidden="true"
                      className="catalog-card-aerotour-icon"
                      style={getCatalogCardIconMaskStyle(aerotourIconUrl)}
                    />
                  </span>
                ) : null}
                {hasPresentation ? (
                  <span className="catalog-card-pdf-badge" aria-label="Есть PDF-презентация" role="img" title="Есть PDF-презентация">
                    <CatalogDocumentIcon />
                  </span>
                ) : null}
              </span>
            ) : null}
          </span>
        ) : null}
        {matchedLotsCount !== null ? (
          <span className="catalog-card-media-label catalog-card-matched-lots-badge">
            {formatNumber(matchedLotsCount)} {formatCatalogLotsWord(matchedLotsCount)} по фильтру
          </span>
        ) : null}
      </a>
      <div className="catalog-card-body">
        <span className="catalog-card-meta">
          {districtLabel}
          <CatalogCardMetroLabel stations={object.metroStations} />
        </span>
        <h3>
          <a href={objectHref} rel="noopener noreferrer" target="_blank" title={object.title}>
            {object.title}
          </a>
        </h3>
        <p className="catalog-card-price">{formatPriceFrom(getCatalogPriceFrom(object))}</p>
        <span className="catalog-card-price-per-meter">{formatPricePerMeterFrom(getCatalogPricePerMeterFrom(object))}</span>
        <div className="catalog-card-facts">
          <span>Срок · {formatCatalogCardFact(formatCompletion(object.completionYear, object.completionQuarter))}</span>
          <span>Площадь · {formatCatalogCardFact(areaLabel)}</span>
        </div>
        <a className="catalog-card-link" href={objectHref} rel="noopener noreferrer" target="_blank">
          Открыть объект
        </a>
      </div>
    </article>
  );
}

/** Paints a monochrome asset in the badge text color, so every photo indicator shares one glyph color. */
function getCatalogCardIconMaskStyle(iconUrl: string): CSSProperties {
  const maskImage = `url("${iconUrl}")`;

  return { maskImage, WebkitMaskImage: maskImage };
}

/** Document glyph from the Fluffy White property card (24px grid, 1.8 stroke). */
function CatalogDocumentIcon() {
  return (
    <svg
      aria-hidden="true"
      className="catalog-card-pdf-icon"
      fill="none"
      height="18"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      width="18"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16h16V8Z" />
      <path d="M14 2v6h6M8 13h8M8 17h6" />
    </svg>
  );
}

/** Metro part of the card meta line: «· м. Тверская, Чеховская». */
function CatalogCardMetroLabel({ stations }: { stations: ObjectMetroStationLink[] }) {
  if (stations.length === 0) {
    return null;
  }

  const metroLabel = formatMetroStations(stations) ?? undefined;

  return (
    <span className="catalog-card-metro" title={metroLabel}>
      {` · м. ${stations.map((station) => station.name).join(', ')}`}
    </span>
  );
}

/** Card facts use typographic ranges and a dash for missing values: «71,1–366 м²», «—». */
function formatCatalogCardFact(value: string) {
  if (value.startsWith('Не указ')) {
    return '—';
  }

  return value.replace(/(\d)\.(\d)/g, '$1,$2').replace(/(\d)\s*-\s*(\d)/g, '$1–$2');
}

function formatCatalogLotsWord(count: number) {
  const lastTwoDigits = count % 100;
  const lastDigit = count % 10;

  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) {
    return 'лотов';
  }

  if (lastDigit === 1) {
    return 'лот';
  }

  return lastDigit >= 2 && lastDigit <= 4 ? 'лота' : 'лотов';
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

function parseCatalogFilters(queryString: string, routeObjectType: RealEstateObjectType | null = null): CatalogFilters {
  const params = new URLSearchParams(queryString);

  return {
    search: parseSearchParam(params.get('search')),
    developerId: parseCatalogFilterIdParam(params.get('developerId')),
    krtName: parseTextParam(params.get('krtName')),
    locationId: parseCatalogFilterIdParam(params.get('locationId')),
    areaId: parseCatalogFilterIdParam(params.get('areaId')),
    metroStationId: parseCatalogFilterIdParam(params.get('metroStationId')),
    objectType: routeObjectType ?? parseCatalogObjectType(params.get('type')),
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

function buildCatalogQuery(
  filters: CatalogFilters,
  viewMode: CatalogViewMode = 'cards',
  options: { omitObjectType?: boolean } = {},
) {
  const params = new URLSearchParams();

  setSearchParam(params, 'search', filters.search);
  setParam(params, 'developerId', filters.developerId);
  setParam(params, 'krtName', filters.krtName);
  setParam(params, 'locationId', filters.locationId);
  setParam(params, 'areaId', filters.areaId);
  setParam(params, 'metroStationId', filters.metroStationId);
  if (!options.omitObjectType) {
    setCatalogObjectTypeParam(params, filters.objectType);
  }
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

function getCatalogRouteObjectType(pathname: string): RealEstateObjectType | null {
  if (pathname === '/catalog/life') {
    return 'RESIDENTIAL';
  }

  if (pathname === '/catalog/comm') {
    return 'COMMERCIAL';
  }

  return null;
}

function isCatalogListPath(pathname: string) {
  return pathname === '/catalog' || pathname === '/catalog/life' || pathname === '/catalog/comm';
}

function getCatalogListPathname(objectType: CatalogObjectTypeFilter) {
  if (objectType === 'RESIDENTIAL') {
    return '/catalog/life';
  }

  if (objectType === 'COMMERCIAL') {
    return '/catalog/comm';
  }

  return '/catalog';
}

function getNextCatalogPathname(currentPathname: string, objectType: CatalogObjectTypeFilter) {
  if (currentPathname === '/catalog/map') {
    return currentPathname;
  }

  return getCatalogListPathname(objectType);
}

function shouldOmitCatalogObjectTypeParam(pathname: string) {
  return pathname === '/catalog/life' || pathname === '/catalog/comm';
}

function getCatalogPageTitle(objectType: CatalogObjectTypeFilter, isMapView: boolean) {
  if (objectType === 'RESIDENTIAL') {
    return isMapView ? 'Жилая недвижимость на карте' : 'Жилая недвижимость';
  }

  if (objectType === 'COMMERCIAL') {
    return isMapView ? 'Коммерческая недвижимость на карте' : 'Коммерческая недвижимость';
  }

  return isMapView ? 'Все объекты на карте' : 'Все объекты недвижимости';
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
    filters.objectType === 'ALL' ? '' : filters.objectType,
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
  setCatalogObjectTypeParam(params, filters.objectType);
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

function mapObjectToPoint(object: MapObject, filters: CatalogFilters): MapPoint {
  return {
    id: object.id,
    title: object.title,
    hint: object.title,
    coordinates: [object.latitude, object.longitude],
    popupHtml: buildMapPopup(object, filters),
    markerLabel: resolveMapMarkerLabel(object),
  };
}

function isMapObjectInBounds(object: MapObject, bounds: MapBounds) {
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

function areMapBoundsEqual(first: MapBounds, second: MapBounds) {
  return Math.abs(first[0][0] - second[0][0]) < 0.0000001
    && Math.abs(first[0][1] - second[0][1]) < 0.0000001
    && Math.abs(first[1][0] - second[1][0]) < 0.0000001
    && Math.abs(first[1][1] - second[1][1]) < 0.0000001;
}

function buildMapPopup(object: MapObject, filters: CatalogFilters) {
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

function setCatalogObjectTypeParam(params: URLSearchParams, value: CatalogObjectTypeFilter) {
  if (value !== defaultFilters.objectType) {
    params.set('type', value);
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

function parseCatalogObjectType(value: string | null) {
  return value === 'RESIDENTIAL' || value === 'COMMERCIAL' ? value : defaultFilters.objectType;
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

function formatCatalogObjectsWord(count: number) {
  const lastTwoDigits = count % 100;
  const lastDigit = count % 10;

  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) {
    return 'объектов';
  }

  if (lastDigit === 1) {
    return 'объект';
  }

  return lastDigit >= 2 && lastDigit <= 4 ? 'объекта' : 'объектов';
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

function hasExternalObjectUrl(value: string | null) {
  const trimmedValue = value?.trim();

  if (!trimmedValue) {
    return false;
  }

  try {
    const url = new URL(trimmedValue);

    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function formatMetroStations(stations: ObjectMetroStationLink[]) {
  if (stations.length === 0) {
    return null;
  }

  const visibleStations = stations.slice(0, 2).map((station) => station.name);
  const hiddenCount = stations.length - visibleStations.length;

  return `Метро ${visibleStations.join(', ')}${hiddenCount > 0 ? ` +${hiddenCount}` : ''}`;
}

function formatCompletion(year: number | null, quarter: number | null) {
  if (!year) {
    return 'Не указан';
  }

  return quarter ? `${quarter} кв. ${year}` : String(year);
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
