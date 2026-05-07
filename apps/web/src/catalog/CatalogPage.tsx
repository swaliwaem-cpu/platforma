import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import type {
  DevelopersResponse,
  LocationsResponse,
  MapObject,
  MapObjectsResponse,
  MetroStationsResponse,
  ObjectDeveloper,
  ObjectLocation,
  ObjectMetroStation,
  ObjectStatus,
  ObjectsResponse,
  RealEstateObjectSummary,
} from '@platforma/shared';

import { apiRequest, apiUrl } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';
import { YandexMap, type YandexMapPoint } from '../map/YandexMap';

type CatalogPageProps = {
  navigate: (nextPathname: string) => void;
  pathname: string;
};

type BooleanFilter = '' | 'true' | 'false';
type CatalogStatusFilter = ObjectStatus | 'ALL';

type CatalogFilters = {
  search: string;
  developerId: string;
  locationId: string;
  metroStationId: string;
  completionYear: string;
  completionQuarter: string;
  priceFromMin: string;
  priceFromMax: string;
  status: CatalogStatusFilter;
  hasPresentation: BooleanFilter;
  hasCoordinates: BooleanFilter;
  page: number;
};

type DirectoryState = {
  developers: ObjectDeveloper[];
  locations: ObjectLocation[];
  metroStations: ObjectMetroStation[];
};

const defaultFilters: CatalogFilters = {
  search: '',
  developerId: '',
  locationId: '',
  metroStationId: '',
  completionYear: '',
  completionQuarter: '',
  priceFromMin: '',
  priceFromMax: '',
  status: 'PUBLISHED',
  hasPresentation: '',
  hasCoordinates: '',
  page: 1,
};

const objectStatusLabels: Record<ObjectStatus, string> = {
  DRAFT: 'Черновик',
  PUBLISHED: 'Опубликован',
  ARCHIVED: 'Архивный',
};

const statusOptions: Array<{ value: CatalogStatusFilter; label: string }> = [
  { value: 'PUBLISHED', label: 'Опубликованные' },
  { value: 'DRAFT', label: 'Черновики' },
  { value: 'ARCHIVED', label: 'Архивные' },
  { value: 'ALL', label: 'Все статусы' },
];

const booleanOptions = [
  { value: '', label: 'Не важно' },
  { value: 'true', label: 'Да' },
  { value: 'false', label: 'Нет' },
] satisfies Array<{ value: BooleanFilter; label: string }>;

export function CatalogPage({ navigate, pathname }: CatalogPageProps) {
  const { accessToken } = useAuth();
  const [queryString, setQueryString] = useState(window.location.search);
  const filters = useMemo(() => parseCatalogFilters(queryString), [queryString]);
  const isMapView = pathname === '/catalog/map';
  const [objects, setObjects] = useState<RealEstateObjectSummary[]>([]);
  const [mapObjects, setMapObjects] = useState<MapObject[]>([]);
  const [directories, setDirectories] = useState<DirectoryState>({
    developers: [],
    locations: [],
    metroStations: [],
  });
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [mapTotal, setMapTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isMapLoading, setIsMapLoading] = useState(false);
  const [isDirectoriesLoading, setIsDirectoriesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [directoryError, setDirectoryError] = useState<string | null>(null);

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
      const [developers, locations, metroStations] = await Promise.all([
        apiRequest<DevelopersResponse>('/developers?limit=500', accessToken),
        apiRequest<LocationsResponse>('/locations?limit=500', accessToken),
        apiRequest<MetroStationsResponse>('/metro?limit=500', accessToken),
      ]);

      setDirectories({
        developers: developers.items,
        locations: locations.items,
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
    const nextSearch = buildCatalogQuery(nextFilters);

    window.history.pushState(null, '', `${pathname}${nextSearch}`);
    setQueryString(window.location.search);
  }

  function resetFilters() {
    window.history.pushState(null, '', pathname);
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
          <button
            className={isMapView ? 'secondary-button secondary-button--fit' : 'primary-button primary-button--fit'}
            type="button"
            onClick={() => navigate(`/catalog${queryString}`)}
          >
            Список
          </button>
          <button
            className={isMapView ? 'primary-button primary-button--fit' : 'secondary-button secondary-button--fit'}
            type="button"
            onClick={() => navigate(`/catalog/map${queryString}`)}
          >
            Карта
          </button>
        </div>
      </header>

      <CatalogFilters
        directories={directories}
        filters={filters}
        isDirectoriesLoading={isDirectoriesLoading}
        onChange={updateFilters}
        onReset={resetFilters}
      />

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
          onPageChange={(page) => updateFilters({ page }, { resetPage: false })}
          onOpenObject={(slug) => navigate(`/objects/${encodeURIComponent(slug)}`)}
        />
      )}
    </div>
  );
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
  return (
    <section className="catalog-filters" aria-label="Фильтры каталога">
      <label>
        Поиск
        <input
          placeholder="Название, адрес, застройщик"
          type="search"
          value={filters.search}
          onChange={(event) => onChange({ search: event.target.value })}
        />
      </label>

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
        Локация
        <select
          disabled={isDirectoriesLoading}
          value={filters.locationId}
          onChange={(event) => onChange({ locationId: event.target.value })}
        >
          <option value="">Все локации</option>
          {directories.locations.map((location) => (
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
        Квартал
        <select
          value={filters.completionQuarter}
          onChange={(event) => onChange({ completionQuarter: event.target.value })}
        >
          <option value="">Любой</option>
          <option value="1">1 кв.</option>
          <option value="2">2 кв.</option>
          <option value="3">3 кв.</option>
          <option value="4">4 кв.</option>
        </select>
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

      <label>
        Статус
        <select value={filters.status} onChange={(event) => onChange({ status: event.target.value as CatalogStatusFilter })}>
          {statusOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label>
        Презентация
        <select
          value={filters.hasPresentation}
          onChange={(event) => onChange({ hasPresentation: event.target.value as BooleanFilter })}
        >
          {booleanOptions.map((option) => (
            <option key={option.value || 'any'} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label>
        Координаты
        <select
          value={filters.hasCoordinates}
          onChange={(event) => onChange({ hasCoordinates: event.target.value as BooleanFilter })}
        >
          {booleanOptions.map((option) => (
            <option key={option.value || 'any'} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <div className="catalog-filter-actions">
        <button className="secondary-button secondary-button--fit" type="button" onClick={onReset}>
          Сбросить
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
  onPageChange,
  onOpenObject,
}: {
  accessToken: string;
  error: string | null;
  filters: CatalogFilters;
  isLoading: boolean;
  objects: RealEstateObjectSummary[];
  totalPages: number;
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
      <div className="catalog-grid">
        {objects.map((object) => (
          <CatalogCard key={object.id} object={object} accessToken={accessToken} onOpen={() => onOpenObject(object.slug)} />
        ))}
      </div>

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
  const balloonImageUrls = useMapObjectImageUrls(accessToken, objects);
  const points = useMemo(
    () => objects.map((object) => mapObjectToPoint(object, balloonImageUrls.get(object.id))),
    [balloonImageUrls, objects],
  );

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
          points={points}
          onOpenPoint={(point) => {
            const object = objects.find((candidate) => candidate.id === point.id);

            if (object) {
              onOpenObject(object.slug);
            }
          }}
        />
      </div>

      <aside className="catalog-map-list" aria-label="Объекты на карте">
        <div className="table-meta">
          <span>{isLoading ? 'Загрузка' : `На карте: ${objects.length}`}</span>
          <span>{total > objects.length ? `из ${total}` : 'Все точки'}</span>
        </div>
        <ul>
          {objects.map((object) => (
            <li key={object.id}>
              <button className="text-button" type="button" onClick={() => onOpenObject(object.slug)}>
                {object.title}
              </button>
              <span>{object.primaryLocation?.name ?? object.address ?? 'Локация не указана'}</span>
            </li>
          ))}
        </ul>
      </aside>
    </section>
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

  function handleOpen(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    onOpen();
  }

  return (
    <article className="catalog-card">
      <a className="catalog-card-media catalog-card-media-link" href={objectHref} onClick={handleOpen}>
        {coverImage ? (
          <SecureImage accessToken={accessToken} alt={coverImage.alt ?? object.title} fileId={coverImage.file.id} />
        ) : (
          <span>Нет обложки</span>
        )}
      </a>
      <div className="catalog-card-body">
        <div className="catalog-card-heading">
          <div>
            <h3>
              <a href={objectHref} onClick={handleOpen}>
                {object.title}
              </a>
            </h3>
            <p>{object.primaryLocation?.name ?? object.address ?? 'Локация не указана'}</p>
          </div>
          <span className={`status-pill object-status object-status--${object.status.toLowerCase()}`}>
            {objectStatusLabels[object.status]}
          </span>
        </div>
        <dl className="catalog-card-meta">
          <div>
            <dt>Цена</dt>
            <dd>{formatPrice(object.priceFrom)}</dd>
          </div>
          <div>
            <dt>Срок</dt>
            <dd>{formatCompletion(object.completionYear, object.completionQuarter)}</dd>
          </div>
          <div>
            <dt>Застройщик</dt>
            <dd>{object.developer?.name ?? 'Не указан'}</dd>
          </div>
          <div>
            <dt>Презентация</dt>
            <dd>{object.presentationFile ? 'Есть' : 'Нет'}</dd>
          </div>
        </dl>
        <a className="secondary-button secondary-button--fit catalog-card-link" href={objectHref} onClick={handleOpen}>
          Открыть объект
        </a>
      </div>
    </article>
  );
}

function SecureImage({ accessToken, alt, fileId }: { accessToken: string; alt: string; fileId: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let isCancelled = false;

    async function loadImage() {
      const response = await fetch(`${apiUrl}/files/${fileId}/content`, {
        credentials: 'include',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        return;
      }

      const blob = await response.blob();

      if (isCancelled) {
        return;
      }

      objectUrl = URL.createObjectURL(blob);
      setSrc(objectUrl);
    }

    void loadImage();

    return () => {
      isCancelled = true;

      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [accessToken, fileId]);

  if (!src) {
    return <span>Загрузка изображения</span>;
  }

  return <img alt={alt} src={src} />;
}

function useMapObjectImageUrls(accessToken: string, objects: MapObject[]) {
  const [imageUrls, setImageUrls] = useState<Map<string, string>>(() => new Map());

  useEffect(() => {
    let isCancelled = false;
    const objectUrls: string[] = [];
    const imageFiles = objects
      .map((object) => ({
        objectId: object.id,
        fileId: object.coverImage?.file.id ?? null,
      }))
      .filter((item): item is { objectId: string; fileId: string } => Boolean(item.fileId));

    setImageUrls(new Map());

    if (!accessToken || imageFiles.length === 0) {
      return () => undefined;
    }

    async function loadImages() {
      const nextImageUrls = new Map<string, string>();

      await Promise.all(
        imageFiles.map(async ({ fileId, objectId }) => {
          const objectUrl = await fetchFileObjectUrl(accessToken, fileId).catch(() => null);

          if (!objectUrl) {
            return;
          }

          if (isCancelled) {
            URL.revokeObjectURL(objectUrl);
            return;
          }

          objectUrls.push(objectUrl);
          nextImageUrls.set(objectId, objectUrl);
        }),
      );

      if (!isCancelled) {
        setImageUrls(nextImageUrls);
      }
    }

    void loadImages();

    return () => {
      isCancelled = true;

      for (const objectUrl of objectUrls) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [accessToken, objects]);

  return imageUrls;
}

async function fetchFileObjectUrl(accessToken: string, fileId: string) {
  const response = await fetch(`${apiUrl}/files/${fileId}/content`, {
    credentials: 'include',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error('Image request failed');
  }

  return URL.createObjectURL(await response.blob());
}

function parseCatalogFilters(queryString: string): CatalogFilters {
  const params = new URLSearchParams(queryString);
  const status = parseCatalogStatus(params.get('status'));

  return {
    search: parseTextParam(params.get('search')),
    developerId: parseTextParam(params.get('developerId')),
    locationId: parseTextParam(params.get('locationId')),
    metroStationId: parseTextParam(params.get('metroStationId')),
    completionYear: sanitizeIntegerText(params.get('completionYear') ?? '', 4),
    completionQuarter: parseQuarter(params.get('completionQuarter')),
    priceFromMin: sanitizeDecimalText(params.get('priceFromMin') ?? ''),
    priceFromMax: sanitizeDecimalText(params.get('priceFromMax') ?? ''),
    status,
    hasPresentation: parseBooleanFilter(params.get('hasPresentation')),
    hasCoordinates: parseBooleanFilter(params.get('hasCoordinates')),
    page: parsePositiveInteger(params.get('page'), 1),
  };
}

function buildCatalogQuery(filters: CatalogFilters) {
  const params = new URLSearchParams();

  setParam(params, 'search', filters.search);
  setParam(params, 'developerId', filters.developerId);
  setParam(params, 'locationId', filters.locationId);
  setParam(params, 'metroStationId', filters.metroStationId);
  setParam(params, 'completionYear', filters.completionYear);
  setParam(params, 'completionQuarter', filters.completionQuarter);
  setParam(params, 'priceFromMin', filters.priceFromMin);
  setParam(params, 'priceFromMax', filters.priceFromMax);

  if (filters.status !== defaultFilters.status) {
    params.set('status', filters.status);
  }

  setParam(params, 'hasPresentation', filters.hasPresentation);
  setParam(params, 'hasCoordinates', filters.hasCoordinates);

  if (filters.page > 1) {
    params.set('page', String(filters.page));
  }

  const query = params.toString();

  return query ? `?${query}` : '';
}

function buildObjectsParams(filters: CatalogFilters, includePage: boolean) {
  const params = new URLSearchParams({
    limit: includePage ? '12' : '1000',
    sortBy: 'createdAt',
    sortDirection: 'desc',
  });

  if (includePage) {
    params.set('page', String(filters.page));
  }

  setParam(params, 'search', filters.search);
  setParam(params, 'developerId', filters.developerId);
  setParam(params, 'locationId', filters.locationId);
  setParam(params, 'metroStationId', filters.metroStationId);
  setParam(params, 'completionYear', filters.completionYear);
  setParam(params, 'completionQuarter', filters.completionQuarter);
  setParam(params, 'priceFromMin', filters.priceFromMin);
  setParam(params, 'priceFromMax', filters.priceFromMax);
  setParam(params, 'hasPresentation', filters.hasPresentation);
  setParam(params, 'hasCoordinates', filters.hasCoordinates);

  if (filters.status !== 'ALL') {
    params.set('status', filters.status);
  }

  return params;
}

function mapObjectToPoint(object: MapObject, imageUrl: string | undefined): YandexMapPoint {
  return {
    id: object.id,
    title: object.title,
    hint: object.title,
    coordinates: [object.latitude, object.longitude],
    balloonHtml: buildMapBalloon(object, imageUrl),
  };
}

function buildMapBalloon(object: MapObject, imageUrl: string | undefined) {
  const pointId = escapeHtml(object.id);
  const title = escapeHtml(object.title);
  const location = escapeHtml(object.primaryLocation?.name ?? object.address ?? 'Локация не указана');
  const developer = escapeHtml(object.developer?.name ?? 'Застройщик не указан');
  const price = escapeHtml(formatPrice(object.priceFrom));
  const completion = escapeHtml(formatCompletion(object.completionYear, object.completionQuarter));
  const href = escapeHtml(`/objects/${encodeURIComponent(object.slug)}`);
  const image = imageUrl ? `<img class="map-balloon-image" src="${escapeHtml(imageUrl)}" alt="${title}" />` : '';

  return [
    '<div class="map-balloon">',
    image,
    `<strong>${title}</strong>`,
    `<span>${location}</span>`,
    `<span>${developer}</span>`,
    `<span>${price}, ${completion}</span>`,
    `<a href="${href}" data-map-point-id="${pointId}">Открыть объект</a>`,
    '</div>',
  ].join('');
}

function setParam(params: URLSearchParams, key: string, value: string) {
  const normalizedValue = value.trim();

  if (normalizedValue) {
    params.set(key, normalizedValue);
  }
}

function parseTextParam(value: string | null) {
  return value?.trim() ?? '';
}

function parseCatalogStatus(value: string | null): CatalogStatusFilter {
  const normalizedValue = value?.trim().toUpperCase();

  if (normalizedValue === 'ALL') {
    return 'ALL';
  }

  if (normalizedValue === 'DRAFT' || normalizedValue === 'PUBLISHED' || normalizedValue === 'ARCHIVED') {
    return normalizedValue;
  }

  return defaultFilters.status;
}

function parseBooleanFilter(value: string | null): BooleanFilter {
  const normalizedValue = value?.trim().toLowerCase();

  if (normalizedValue === 'true' || normalizedValue === 'false') {
    return normalizedValue;
  }

  return '';
}

function parseQuarter(value: string | null) {
  return value === '1' || value === '2' || value === '3' || value === '4' ? value : '';
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
