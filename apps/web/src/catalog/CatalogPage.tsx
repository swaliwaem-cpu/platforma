import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
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

import { apiRequest } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';
import { SecureImage } from '../files/SecureImage';
import { YandexMap, type YandexMapBounds, type YandexMapPoint } from '../map/YandexMap';

type CatalogPageProps = {
  navigate: (nextPathname: string) => void;
  pathname: string;
};

type BooleanFilter = '' | 'true' | 'false';
type CatalogStatusFilter = ObjectStatus | 'ALL';
type CatalogViewMode = 'cards' | 'list';
type CatalogSortField = 'createdAt' | 'priceFrom' | 'pricePerMeterFrom' | 'completionDate';
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
  priceFromMin: string;
  priceFromMax: string;
  status: CatalogStatusFilter;
  hasPresentation: BooleanFilter;
  hasCoordinates: BooleanFilter;
  sortBy: CatalogSortField;
  sortDirection: SortDirection;
  page: number;
};

type DirectoryState = {
  developers: ObjectDeveloper[];
  districtLocations: ObjectLocation[];
  areaLocations: ObjectLocation[];
  metroStations: ObjectMetroStation[];
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
  priceFromMin: '',
  priceFromMax: '',
  status: 'PUBLISHED',
  hasPresentation: '',
  hasCoordinates: '',
  sortBy: 'createdAt',
  sortDirection: 'desc',
  page: 1,
};

const catalogSortOptions: Array<{
  label: string;
  sortBy: CatalogSortField;
  sortDirection: SortDirection;
}> = [
  { label: 'По цене вниз', sortBy: 'priceFrom', sortDirection: 'desc' },
  { label: 'По цене вверх', sortBy: 'priceFrom', sortDirection: 'asc' },
  { label: 'Цена м² вниз', sortBy: 'pricePerMeterFrom', sortDirection: 'desc' },
  { label: 'Цена м² вверх', sortBy: 'pricePerMeterFrom', sortDirection: 'asc' },
  { label: 'Сдача раньше', sortBy: 'completionDate', sortDirection: 'asc' },
  { label: 'Сдача позже', sortBy: 'completionDate', sortDirection: 'desc' },
  { label: 'Сначала новые на портале', sortBy: 'createdAt', sortDirection: 'desc' },
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
  const [mapTotal, setMapTotal] = useState(0);
  const [catalogLinks, setCatalogLinks] = useState<PublicCatalogQuickLink[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isMapLoading, setIsMapLoading] = useState(false);
  const [isDirectoriesLoading, setIsDirectoriesLoading] = useState(false);
  const [isCatalogLinksLoading, setIsCatalogLinksLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [catalogLinksError, setCatalogLinksError] = useState<string | null>(null);

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

    setIsLoading(true);
    setError(null);

    try {
      const params = buildObjectsParams(filters, true);
      const data = await apiRequest<ObjectsResponse>(`/objects?${params.toString()}`, accessToken);

      setObjects(data.items);
      setTotal(data.total);
      setTotalPages(data.totalPages);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить каталог');
    } finally {
      setIsLoading(false);
    }
  }

  async function loadMapObjects() {
    if (!accessToken) {
      return;
    }

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

      setMapObjects(data.items);
      setMapTotal(data.total);
    } catch (caughtError) {
      setMapError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить объекты для карты');
    } finally {
      setIsMapLoading(false);
    }
  }

  function updateFilters(patch: Partial<CatalogFilters>, options: { resetPage: boolean } = { resetPage: true }) {
    const nextFilters = {
      ...filters,
      ...patch,
      page: options.resetPage ? 1 : (patch.page ?? filters.page),
    };
    const nextSearch = buildCatalogQuery(nextFilters, viewMode);

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
          onOpenObject={(slug) => navigate(`/objects/${encodeURIComponent(slug)}`)}
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
          onOpenObject={(slug) => navigate(`/objects/${encodeURIComponent(slug)}`)}
        />
      ) : (
        <CatalogListView
          accessToken={accessToken ?? ''}
          error={error}
          filters={filters}
          isLoading={isLoading}
          objects={objects}
          totalPages={totalPages}
          viewMode={viewMode}
          onPageChange={(page) => updateFilters({ page }, { resetPage: false })}
          onOpenObject={(slug) => navigate(`/objects/${encodeURIComponent(slug)}`)}
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
  onOpenObject,
}: {
  error: string | null;
  isLoading: boolean;
  links: PublicCatalogQuickLink[];
  onOpenDeveloper: (developerId: string) => void;
  onOpenKrt: (krtName: string) => void;
  onOpenObject: (slug: string) => void;
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
                      onOpenObject={onOpenObject}
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
  onOpenObject,
}: {
  link: PublicCatalogQuickLink;
  onOpenDeveloper: (developerId: string) => void;
  onOpenKrt: (krtName: string) => void;
  onOpenObject: (slug: string) => void;
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
        onClick={(event) => {
          event.preventDefault();
          onOpenObject(objectSlug);
        }}
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
  const filterButtonLabel = isExpanded ? 'Скрыть фильтры' : '+ фильтры';

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

      {isExpanded ? (
        <div className="catalog-filter-fields">
          <label>
            Застройщик
            <select
              disabled={isDirectoriesLoading}
              value={filters.developerId}
              onChange={(event) => onChange({ developerId: event.target.value })}
            >
              <option value="">Все застройщики</option>
              {directories.developers.map((developer) => (
                <option key={developer.id} value={developer.id}>
                  {developer.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            Район
            <select
              disabled={isDirectoriesLoading}
              value={filters.locationId}
              onChange={(event) => onChange({ locationId: event.target.value })}
            >
              <option value="">Все районы</option>
              {directories.districtLocations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            Окружение
            <select
              disabled={isDirectoriesLoading}
              value={filters.areaId}
              onChange={(event) => onChange({ areaId: event.target.value })}
            >
              <option value="">Все окружения</option>
              {directories.areaLocations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            Метро
            <select
              disabled={isDirectoriesLoading}
              value={filters.metroStationId}
              onChange={(event) => onChange({ metroStationId: event.target.value })}
            >
              <option value="">Все станции</option>
              {directories.metroStations.map((station) => (
                <option key={station.id} value={station.id}>
                  {station.lineName ? `${station.name}, ${station.lineName}` : station.name}
                </option>
              ))}
            </select>
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

          <label>
            Цена от
            <input
              inputMode="decimal"
              placeholder="0"
              type="text"
              value={filters.priceFromMin}
              onChange={(event) => onChange({ priceFromMin: sanitizeDecimalText(event.target.value) })}
            />
          </label>

          <label>
            Цена до
            <input
              inputMode="decimal"
              placeholder="50000000"
              type="text"
              value={filters.priceFromMax}
              onChange={(event) => onChange({ priceFromMax: sanitizeDecimalText(event.target.value) })}
            />
          </label>

          <div className="catalog-filter-actions">
            <button className="secondary-button secondary-button--fit" type="button" onClick={onReset}>
              Сбросить
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function CatalogSortBar({
  filters,
  onChange,
}: {
  filters: CatalogFilters;
  onChange: (patch: Partial<CatalogFilters>, options?: { resetPage: boolean }) => void;
}) {
  const activeSortLabel = getCatalogSortLabel(filters);
  const isDefaultSort =
    filters.sortBy === defaultFilters.sortBy && filters.sortDirection === defaultFilters.sortDirection;

  return (
    <section className="catalog-sort-bar" aria-label="Сортировка каталога">
      <div className="catalog-sort-heading">
        <span>Сортировка</span>
        <strong>{activeSortLabel}</strong>
      </div>
      <div className="catalog-sort-actions">
        {catalogSortOptions.map((option) => {
          const isActive = filters.sortBy === option.sortBy && filters.sortDirection === option.sortDirection;

          return (
            <button
              key={`${option.sortBy}-${option.sortDirection}`}
              aria-pressed={isActive}
              className={isActive ? 'catalog-sort-option catalog-sort-option--active' : 'catalog-sort-option'}
              type="button"
              onClick={() => onChange({ sortBy: option.sortBy, sortDirection: option.sortDirection })}
            >
              {option.label}
            </button>
          );
        })}
        <button
          className="catalog-sort-reset"
          disabled={isDefaultSort}
          type="button"
          onClick={() =>
            onChange({
              sortBy: defaultFilters.sortBy,
              sortDirection: defaultFilters.sortDirection,
            })
          }
        >
          Порядок по умолчанию
        </button>
      </div>
    </section>
  );
}

function CatalogListView({
  accessToken,
  error,
  filters,
  isLoading,
  objects,
  totalPages,
  viewMode,
  onPageChange,
  onOpenObject,
}: {
  accessToken: string;
  error: string | null;
  filters: CatalogFilters;
  isLoading: boolean;
  objects: RealEstateObjectSummary[];
  totalPages: number;
  viewMode: CatalogViewMode;
  onPageChange: (page: number) => void;
  onOpenObject: (slug: string) => void;
}) {
  if (error) {
    return <p className="form-error">{error}</p>;
  }

  if (isLoading) {
    return (
      <div className="content-panel">
        <p className="eyebrow">Каталог</p>
        <h2>Загрузка</h2>
        <p className="muted-text">Получаем объекты по выбранным фильтрам.</p>
      </div>
    );
  }

  if (objects.length === 0) {
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
              onOpen={() => onOpenObject(object.slug)}
            />
          ))}
        </div>
      ) : (
        <div className="catalog-grid" aria-label="Объекты карточками">
          {objects.map((object) => (
            <CatalogCard key={object.id} object={object} accessToken={accessToken} onOpen={() => onOpenObject(object.slug)} />
          ))}
        </div>
      )}

      {totalPages > 1 ? (
        <div className="pagination catalog-pagination">
          <button
            className="secondary-button secondary-button--fit"
            disabled={filters.page <= 1}
            type="button"
            onClick={() => onPageChange(Math.max(1, filters.page - 1))}
          >
            Назад
          </button>
          <span>
            Страница {filters.page} из {totalPages}
          </span>
          <button
            className="secondary-button secondary-button--fit"
            disabled={filters.page >= totalPages}
            type="button"
            onClick={() => onPageChange(filters.page + 1)}
          >
            Вперёд
          </button>
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
  onOpenObject,
}: {
  accessToken: string;
  error: string | null;
  filters: CatalogFilters;
  isLoading: boolean;
  objects: MapObject[];
  total: number;
  onOpenObject: (slug: string) => void;
}) {
  const [visibleBounds, setVisibleBounds] = useState<YandexMapBounds | null>(null);
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [isListVisible, setIsListVisible] = useState(true);
  const points = useMemo(() => objects.map((object) => mapObjectToPoint(object)), [objects]);
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

  return (
    <section className="catalog-map-layout" aria-label="Карта объектов">
      <div className="catalog-map-panel">
        {isLoading ? <div className="map-loading">Загрузка объектов</div> : null}
        <YandexMap
          onBoundsChange={handleBoundsChange}
          points={points}
          selectedPointId={selectedObjectId}
          onSelectPoint={handleSelectPoint}
        />

        {selectedObject ? (
          <MapObjectCard
            accessToken={accessToken}
            object={selectedObject}
            onClose={() => setSelectedObjectId(null)}
            onOpen={() => onOpenObject(selectedObject.slug)}
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
                    <strong>{formatMapListPricePerMeter(object.pricePerMeterFrom)}</strong>
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
      </div>
    </section>
  );
}

function MapObjectCard({
  accessToken,
  object,
  onClose,
  onOpen,
}: {
  accessToken: string;
  object: MapObject;
  onClose: () => void;
  onOpen: () => void;
}) {
  const metroLabel = formatMetroStations(object.metroStations ?? []);
  const districtLabel = getObjectDistrictLabel(object);

  return (
    <article className="map-object-card" aria-label={`Объект ${object.title}`}>
      <button aria-label="Закрыть карточку" className="map-object-card-close" type="button" onClick={onClose}>
        ×
      </button>
      {object.coverImage ? (
        <SecureImage
          accessToken={accessToken}
          alt={object.coverImage.alt ?? object.title}
          className="map-object-card-image"
          errorFallback="Обложка недоступна"
          fileId={object.coverImage.file.id}
          loadingFallback="Загрузка обложки"
          placeholderClassName="map-object-card-image map-object-card-image--empty"
          variant="card"
        />
      ) : (
        <div className="map-object-card-image map-object-card-image--empty">Нет обложки</div>
      )}
      <div className="map-object-card-body">
        <h3>{object.title}</h3>
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
        </dl>
        <p>
          Цена от: <strong>{formatPrice(object.priceFrom)}</strong> | Цена за метр от:{' '}
          <strong>{formatMapCardPricePerMeter(object.pricePerMeterFrom)}</strong>
        </p>
        <button className="catalog-card-link map-object-card-link" type="button" onClick={onOpen}>
          Подробнее
        </button>
      </div>
    </article>
  );
}

function CatalogListItem({
  accessToken,
  object,
  onOpen,
}: {
  accessToken: string;
  object: RealEstateObjectSummary;
  onOpen: () => void;
}) {
  const coverImage = object.coverImage;
  const objectHref = `/objects/${encodeURIComponent(object.slug)}`;
  const developerLabel = object.developer?.name ?? 'Не указан';
  const districtLabel = getObjectDistrictLabel(object);
  const metroLabel = formatListMetroStations(object.metroStations);

  function handleOpen(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    onOpen();
  }

  return (
    <article className="catalog-list-item">
      <a
        aria-label={`Открыть объект ${object.title}`}
        className="catalog-list-item-media"
        href={objectHref}
        onClick={handleOpen}
      >
        {coverImage ? (
          <CatalogCoverImage accessToken={accessToken} alt={coverImage.alt ?? object.title} fileId={coverImage.file.id} />
        ) : (
          <CatalogMediaState title="Нет обложки" text="Показываем данные объекта" tone="empty" />
        )}
      </a>

      <div className="catalog-list-item-body">
        <h3>
          <a href={objectHref} onClick={handleOpen}>
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
        </dl>
        <p className="catalog-list-item-price">
          Цена от: {formatRequestedPrice(object.priceFrom)} | Цена за метр от:{' '}
          {formatRequestedPrice(object.pricePerMeterFrom)}
        </p>
      </div>

      <div className="catalog-list-item-action">
        <a className="catalog-list-item-link" href={objectHref} onClick={handleOpen}>
          Подробнее
        </a>
      </div>
    </article>
  );
}

function CatalogCard({
  accessToken,
  object,
  onOpen,
}: {
  accessToken: string;
  object: RealEstateObjectSummary;
  onOpen: () => void;
}) {
  const coverImage = object.coverImage;
  const objectHref = `/objects/${encodeURIComponent(object.slug)}`;
  const hasPresentation = Boolean(object.presentationFile);
  const hasVisibleBadges = object.status !== 'PUBLISHED' || hasPresentation;
  const districtLabel = getObjectDistrictLabel(object);

  function handleOpen(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    onOpen();
  }

  return (
    <article className="catalog-card">
      <a
        aria-label={`Открыть объект ${object.title}`}
        className="catalog-card-media catalog-card-media-link"
        href={objectHref}
        onClick={handleOpen}
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
            {hasPresentation ? <span className="catalog-card-pdf-badge catalog-card-pdf-badge--active">PDF</span> : null}
          </span>
        ) : null}
      </a>
      <div className="catalog-card-body">
        <div className="catalog-card-price-row">
          <p className="catalog-card-price">{formatPrice(object.priceFrom)}</p>
          <span>{formatPricePerMeter(object.pricePerMeterFrom)}</span>
        </div>
        <div className="catalog-card-heading">
          <h3>
            <a href={objectHref} onClick={handleOpen}>
              {object.title}
            </a>
          </h3>
        </div>
        <div className="catalog-card-location" aria-label="Район и метро">
          <span>{districtLabel}</span>
          <CatalogCardMetroLabel stations={object.metroStations} />
        </div>
        <dl className="catalog-card-facts">
          <div>
            <dt>Срок</dt>
            <dd>{formatCompletion(object.completionYear, object.completionQuarter)}</dd>
          </div>
          <div>
            <dt>Застройщик</dt>
            <dd>{object.developer?.name ?? 'Не указан'}</dd>
          </div>
        </dl>
        <div className="catalog-card-actions">
          <a className="catalog-card-link" href={objectHref} onClick={handleOpen}>
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

  return (
    <span className="catalog-card-metro" aria-label={formatMetroStations(stations) ?? undefined}>
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
    search: parseTextParam(params.get('search')),
    developerId: parseTextParam(params.get('developerId')),
    krtName: parseTextParam(params.get('krtName')),
    locationId: parseTextParam(params.get('locationId')),
    areaId: parseTextParam(params.get('areaId')),
    metroStationId: parseTextParam(params.get('metroStationId')),
    completionYear: sanitizeIntegerText(params.get('completionYear') ?? '', 4),
    completionQuarter: defaultFilters.completionQuarter,
    priceFromMin: sanitizeDecimalText(params.get('priceFromMin') ?? ''),
    priceFromMax: sanitizeDecimalText(params.get('priceFromMax') ?? ''),
    status: defaultFilters.status,
    hasPresentation: defaultFilters.hasPresentation,
    hasCoordinates: defaultFilters.hasCoordinates,
    sortBy: parseCatalogSortBy(params.get('sortBy')),
    sortDirection: parseCatalogSortDirection(params.get('sortDirection')),
    page: parsePositiveInteger(params.get('page'), 1),
  };
}

function parseCatalogViewMode(queryString: string): CatalogViewMode {
  const params = new URLSearchParams(queryString);

  return params.get('view') === 'list' ? 'list' : 'cards';
}

function buildCatalogQuery(filters: CatalogFilters, viewMode: CatalogViewMode = 'cards') {
  const params = new URLSearchParams();

  setParam(params, 'search', filters.search);
  setParam(params, 'developerId', filters.developerId);
  setParam(params, 'krtName', filters.krtName);
  setParam(params, 'locationId', filters.locationId);
  setParam(params, 'areaId', filters.areaId);
  setParam(params, 'metroStationId', filters.metroStationId);
  setParam(params, 'completionYear', filters.completionYear);
  setParam(params, 'priceFromMin', filters.priceFromMin);
  setParam(params, 'priceFromMax', filters.priceFromMax);
  setCatalogSortParams(params, filters);

  if (filters.page > 1) {
    params.set('page', String(filters.page));
  }

  if (viewMode === 'list') {
    params.set('view', viewMode);
  }

  const query = params.toString();

  return query ? `?${query}` : '';
}

function countActiveAdvancedFilters(filters: CatalogFilters) {
  return [
    filters.developerId,
    filters.krtName,
    filters.locationId,
    filters.areaId,
    filters.metroStationId,
    filters.completionYear,
    filters.priceFromMin,
    filters.priceFromMax,
  ].filter((value) => value.trim().length > 0).length;
}

function buildObjectsParams(filters: CatalogFilters, includePage: boolean) {
  const params = new URLSearchParams({
    limit: includePage ? '12' : '1000',
    sortBy: filters.sortBy,
    sortDirection: filters.sortDirection,
  });

  if (includePage) {
    params.set('page', String(filters.page));
  }

  setParam(params, 'search', filters.search);
  setParam(params, 'developerId', filters.developerId);
  setParam(params, 'krtName', filters.krtName);
  setParam(params, 'locationId', filters.locationId);
  setParam(params, 'areaId', filters.areaId);
  setParam(params, 'metroStationId', filters.metroStationId);
  setParam(params, 'completionYear', filters.completionYear);
  setParam(params, 'priceFromMin', filters.priceFromMin);
  setParam(params, 'priceFromMax', filters.priceFromMax);

  if (filters.status !== 'ALL') {
    params.set('status', filters.status);
  }

  return params;
}

function mapObjectToPoint(object: MapObject): YandexMapPoint {
  return {
    id: object.id,
    title: object.title,
    hint: object.title,
    coordinates: [object.latitude, object.longitude],
    balloonHtml: buildMapBalloon(object),
    markerLabel: formatMapMarkerPrice(object.pricePerMeterFrom),
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

function buildMapBalloon(object: MapObject) {
  const pointId = escapeHtml(object.id);
  const title = escapeHtml(object.title);
  const district = escapeHtml(getObjectDistrictLabel(object));
  const developer = escapeHtml(object.developer?.name ?? 'Застройщик не указан');
  const price = escapeHtml(formatPrice(object.priceFrom));
  const completion = escapeHtml(formatCompletion(object.completionYear, object.completionQuarter));
  const href = escapeHtml(`/objects/${encodeURIComponent(object.slug)}`);

  return [
    '<div class="map-balloon">',
    `<strong>${title}</strong>`,
    `<span>${district}</span>`,
    `<span>${developer}</span>`,
    `<span>${price}, ${completion}</span>`,
    `<a href="${href}" data-map-point-id="${pointId}">Открыть объект</a>`,
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

function getCatalogSortLabel(filters: CatalogFilters) {
  const selectedOption = catalogSortOptions.find(
    (option) => option.sortBy === filters.sortBy && option.sortDirection === filters.sortDirection,
  );

  return selectedOption?.label ?? 'Сначала новые на портале';
}

function parseTextParam(value: string | null) {
  return value?.trim() ?? '';
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

function formatCatalogCount(isLoading: boolean, total: number) {
  return isLoading ? 'Загрузка' : `Всего: ${total}`;
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

function formatPricePerMeter(value: string | null) {
  if (!value) {
    return 'за м² не указана';
  }

  return `${formatPrice(value)}/м²`;
}

function formatMapMarkerPrice(value: string | null) {
  if (!value) {
    return 'по запросу/м²';
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return `от ${value}/м²`;
  }

  if (parsed >= 1000000) {
    return `от ${formatCompactRussianNumber(parsed / 1000000)}млн/м²`;
  }

  return `от ${formatCompactRussianNumber(parsed / 1000)}т/м²`;
}

function formatMapListPricePerMeter(value: string | null) {
  return value ? `Цена за м²: ${formatPrice(value)}` : 'Цена за м²: по запросу';
}

function formatMapCardPricePerMeter(value: string | null) {
  return value ? formatPrice(value) : 'по запросу';
}

function formatRequestedPrice(value: string | null) {
  return value ? formatPrice(value) : 'по запросу';
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
