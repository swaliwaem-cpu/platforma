import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type TouchEvent as ReactTouchEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Building2Icon,
  DownloadIcon,
  MapIcon,
  Maximize2Icon,
  PencilIcon,
  RotateCcwIcon,
  SearchIcon,
  XIcon,
} from 'lucide-react';
import type {
  FeedUnit,
  FeedUnitGroupSummary,
  FeedUnitGroupsResponse,
  FeedUnitRoomGroupSummary,
  FeedUnitResponse,
  FeedUnitStatus,
  FeedUnitType,
  ObjectFileType,
  ObjectImageSection,
  ObjectLinkedFile,
  ObjectMetroStationLink,
  ObjectResponse,
  RealEstateObjectDetail,
} from '@platforma/shared';

import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import { apiRequest } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';
import { DropdownListbox, DropdownOption } from '../components/Dropdown';
import { FilterPill, FilterPopoverFooter, formatCompactMoney, formatPillSelection, formatRangeValue } from '../components/FilterPill';
import { getLinkedFileTitle } from '../files/fileDisplay';
import { SecureImage, buildMediaFileContentUrl, useSecureImageObjectUrl } from '../files/SecureImage';
import { formatCurrencyInputValue, getCurrencyInputBackspaceValue } from '../lib/numberInput';
import { getValidMapCoordinate } from '../map/mapContract';
import { resolveMapMarkerLabel } from '../map/mapMarkerLabels';
import { PlatformMap, type MapPoint } from '../map/PlatformMap';
import { LotCollectionAction } from '../presentations/LotCollectionAction';
import {
  formatCompletion,
  formatPrice,
  formatPriceFrom,
  formatPricePerMeterFrom,
  getLocationRows,
  getObjectContentSections,
  getObjectDistrictLocation,
  getObjectLocationLine,
  getObjectParameterRows,
} from './objectDetailViewModel';
import aerotourIconUrl from '../../../../aerotour-icon.png';

type ObjectDetailPageProps = {
  slug: string;
  navigate: (nextPathname: string) => void;
  onBack: () => void;
};

type ObjectLotDetailPageProps = {
  slug: string;
  unitId: string;
  navigate: (nextPathname: string) => void;
  onBack: () => void;
};

const objectStatusLabels: Record<RealEstateObjectDetail['status'], string> = {
  DRAFT: 'Черновик',
  PUBLISHED: 'Опубликован',
  ARCHIVED: 'Архивный',
};

const fileTypeLabels: Record<ObjectFileType, string> = {
  PRESENTATION: 'Презентация',
  FLOOR_PLAN: 'Планировка',
  DOCUMENT: 'Документ',
  OTHER: 'Файл',
};

const objectFeedUnitsPageSize = 20;

type ObjectFeedUnitSortBy = 'title' | 'status' | 'price' | 'discountPrice' | 'pricePerMeter' | 'area' | 'rooms' | 'floor' | 'building';
type ObjectFeedUnitSortDirection = 'asc' | 'desc';
type InitialObjectFeedUnitFilters = {
  priceMin: string;
  priceMax: string;
  pricePerMeterMin: string;
  pricePerMeterMax: string;
  rooms: string;
  floorMin: string;
  floorMax: string;
};
type FeedMediaWithFile = FeedUnit['media'][number] & {
  file: NonNullable<FeedUnit['media'][number]['file']>;
};

const feedUnitStatusLabels: Record<FeedUnitStatus, string> = {
  AVAILABLE: 'Доступен',
  BOOKED: 'Забронирован',
  RESERVED: 'Резерв',
  SOLD: 'Продан',
  ARCHIVED: 'Архив',
  UNKNOWN: 'Неизвестно',
};

const feedUnitTypeLabels: Record<FeedUnitType, string> = {
  RESIDENTIAL: 'Жилой',
  COMMERCIAL: 'Коммерческий',
};

const publicFeedUnitStatuses: FeedUnitStatus[] = [
  'AVAILABLE',
  'BOOKED',
  'RESERVED',
];

const feedUnitStatusFilterOptions = publicFeedUnitStatuses.map((status) => ({
  value: status,
  label: feedUnitStatusLabels[status],
}));

const feedUnitTypeFilterOptions: {
  value: FeedUnitType;
  label: string;
}[] = [
  { value: 'RESIDENTIAL', label: feedUnitTypeLabels.RESIDENTIAL },
  { value: 'COMMERCIAL', label: feedUnitTypeLabels.COMMERCIAL },
];

const feedUnitRoomFilterOptions = [
  { value: '0', label: 'Студия' },
  { value: '1', label: '1 спальня' },
  { value: '2', label: '2 спальни' },
  { value: '3', label: '3 спальни' },
  { value: '4', label: '4 спальни' },
  { value: '5', label: '5 спален' },
];

const feedUnitQuarterFilterOptions = [
  { value: '1', label: '1кв' },
  { value: '2', label: '2кв' },
  { value: '3', label: '3кв' },
  { value: '4', label: '4кв' },
];

const sectionOptions: {
  value: ObjectImageSection;
  label: string;
}[] = [
  { value: 'ARCHITECTURE', label: 'Архитектура' },
  { value: 'INTERIORS', label: 'Интерьеры' },
  { value: 'FILLING', label: 'Наполнение' },
];

export function ObjectDetailPage({ navigate, slug, onBack }: ObjectDetailPageProps) {
  const { accessToken, hasPermission } = useAuth();
  const [object, setObject] = useState<RealEstateObjectDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const canEditObject = hasPermission('admin:access') && hasPermission('objects:update');

  useEffect(() => {
    if (!accessToken) {
      return;
    }

    const token = accessToken;
    let isCancelled = false;

    async function loadObject() {
      setIsLoading(true);
      setError(null);

      try {
        const data = await apiRequest<ObjectResponse>(`/objects/slug/${encodeURIComponent(slug)}`, token);

        if (!isCancelled) {
          setObject(data.object);
        }
      } catch (caughtError) {
        if (!isCancelled) {
          setObject(null);
          setError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить объект');
        }
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadObject();

    return () => {
      isCancelled = true;
    };
  }, [accessToken, slug]);

  if (isLoading) {
    return (
      <div className="object-detail-page">
        <button className="text-button" type="button" onClick={onBack}>
          Вернуться к каталогу
        </button>
        <div className="content-panel">
          <p className="eyebrow">Объект</p>
          <h2>Загрузка</h2>
          <p className="muted-text">Получаем данные объекта.</p>
        </div>
      </div>
    );
  }

  if (error || !object) {
    return (
      <div className="object-detail-page">
        <button className="text-button" type="button" onClick={onBack}>
          Вернуться к каталогу
        </button>
        <div className="content-panel">
          <p className="eyebrow">Объект</p>
          <h2>Не удалось открыть объект</h2>
          <p className="muted-text">{error ?? 'Объект не найден или больше недоступен.'}</p>
        </div>
      </div>
    );
  }

  return (
    <ObjectDetail
      accessToken={accessToken ?? ''}
      canEditObject={canEditObject}
      navigate={navigate}
      object={object}
      onBack={onBack}
    />
  );
}

export function ObjectLotDetailPage({ navigate, slug, unitId, onBack }: ObjectLotDetailPageProps) {
  const { accessToken } = useAuth();
  const [object, setObject] = useState<RealEstateObjectDetail | null>(null);
  const [unit, setUnit] = useState<FeedUnit | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) {
      return;
    }

    const token = accessToken;
    let isCancelled = false;

    async function loadLot() {
      setIsLoading(true);
      setError(null);

      try {
        const objectData = await apiRequest<ObjectResponse>(`/objects/slug/${encodeURIComponent(slug)}`, token);
        const unitData = await apiRequest<FeedUnitResponse>(
          `/objects/${objectData.object.id}/feed-units/${encodeURIComponent(unitId)}`,
          token,
        );

        if (!isCancelled) {
          setObject(objectData.object);
          setUnit(unitData.unit);
        }
      } catch (caughtError) {
        if (!isCancelled) {
          setObject(null);
          setUnit(null);
          setError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить лот');
        }
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadLot();

    return () => {
      isCancelled = true;
    };
  }, [accessToken, slug, unitId]);

  if (isLoading) {
    return (
      <div className="object-detail-page object-lot-page">
        <button className="text-button object-detail-back" type="button" onClick={onBack}>
          <ChevronLeftIcon aria-hidden="true" />
          Вернуться к объекту
        </button>
        <div className="content-panel">
          <p className="eyebrow">Лот</p>
          <h2>Загрузка</h2>
          <p className="muted-text">Получаем данные лота.</p>
        </div>
      </div>
    );
  }

  if (error || !object || !unit) {
    return (
      <div className="object-detail-page object-lot-page">
        <button className="text-button object-detail-back" type="button" onClick={onBack}>
          <ChevronLeftIcon aria-hidden="true" />
          Вернуться к объекту
        </button>
        <div className="content-panel">
          <p className="eyebrow">Лот</p>
          <h2>Не удалось открыть лот</h2>
          <p className="muted-text">{error ?? 'Лот не найден или больше недоступен.'}</p>
        </div>
      </div>
    );
  }

  const title = getFeedUnitTitle(unit);
  const headerLine = getObjectLotHeaderLine(object, unit);
  const summaryFacts = getObjectLotSummaryFacts(unit);
  const priceSummary = getObjectLotPriceSummary(unit);
  const pricePerMeter = formatComputedFeedUnitPricePerMeter(unit);
  const aerotourUrl = getExternalObjectUrl(object.aerotourUrl);
  const layoutMedia = getObjectLotLayoutMedia(unit);

  return (
    <div className="object-detail-page object-lot-page">
      <button className="text-button object-detail-back" type="button" onClick={onBack}>
        <ChevronLeftIcon aria-hidden="true" />
        Вернуться к объекту
      </button>

      <header className="page-header object-detail-header object-lot-header">
        <div>
          <h2>{title}</h2>
          <p className="object-detail-location-line">{headerLine}</p>
        </div>
        {layoutMedia || aerotourUrl ? (
          <div className="object-lot-header-actions">
            {layoutMedia ? (
              <a
                className="object-detail-edit-link object-lot-download-link"
                download={getFeedMediaDownloadFileName(layoutMedia)}
                href={buildMediaFileContentUrl(layoutMedia.file.id, { download: true })}
              >
                <DownloadIcon aria-hidden="true" />
                Скачать планировку
              </a>
            ) : null}
            {aerotourUrl ? (
              <a
                className="object-lot-aerotour-link"
                href={aerotourUrl}
                aria-label="Открыть аэротур"
                title="Открыть аэротур"
                referrerPolicy="no-referrer"
                rel="noopener noreferrer nofollow"
                target="_blank"
              >
                <img alt="" aria-hidden="true" className="object-lot-aerotour-icon" src={aerotourIconUrl} />
              </a>
            ) : null}
          </div>
        ) : null}
      </header>

      {/* Same layout as the object page hero: floor plans next to the price summary. */}
      <section className="object-detail-hero object-lot-hero" aria-labelledby="object-lot-summary-title">
        <ObjectLotMediaCarousel accessToken={accessToken ?? ''} unit={unit} />

        <aside className="detail-section object-parameters-section object-lot-summary">
          <div className="object-lot-status-row">
            <p className="eyebrow" id="object-lot-summary-title">
              {priceSummary.label}
            </p>
            <span className={`object-feed-status object-feed-status--${unit.status.toLowerCase()}`}>
              {feedUnitStatusLabels[unit.status]}
            </span>
          </div>
          <strong className="object-detail-summary-price">{priceSummary.primaryPrice}</strong>
          {pricePerMeter === 'По запросу' ? null : (
            <small className="object-detail-summary-price-meter">{pricePerMeter}/м²</small>
          )}
          {priceSummary.secondaryPrice ? (
            <small className="object-lot-regular-price">
              Обычная цена {priceSummary.secondaryPrice}
              {priceSummary.secondaryPricePerMeter ? ` · ${priceSummary.secondaryPricePerMeter}/м²` : ''}
            </small>
          ) : null}

          {summaryFacts.length > 0 ? (
            <dl className="object-parameters-grid object-lot-facts">
              {summaryFacts.map((fact) => (
                <div className={fact.isWide ? 'object-lot-fact object-lot-fact--wide' : 'object-lot-fact'} key={fact.label}>
                  <dt>{fact.label}</dt>
                  <dd>{fact.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          <div className="object-lot-summary-action">
            <LotCollectionAction loadStateOnMount navigate={navigate} unitId={unit.id} />
          </div>
        </aside>
      </section>

      <div className="object-description-location-grid object-lot-context-grid">
        <ObjectLotHouseSection accessToken={accessToken ?? ''} navigate={navigate} object={object} unit={unit} />
        <ObjectLotSimilarSection accessToken={accessToken ?? ''} navigate={navigate} object={object} unit={unit} />
      </div>
    </div>
  );
}

function ObjectLotHouseSection({
  accessToken,
  navigate,
  object,
  unit,
}: {
  accessToken: string;
  navigate: (nextPathname: string) => void;
  object: RealEstateObjectDetail;
  unit: FeedUnit;
}) {
  const coverImage = useMemo(() => getCarouselImages(object)[0] ?? null, [object]);
  const objectPath = `/objects/${encodeURIComponent(object.slug)}`;
  const address = unit.address?.trim() || object.address?.trim() || null;

  return (
    <section className="detail-section object-lot-house-section" aria-labelledby="object-lot-house-title">
      <div>
        <p className="eyebrow">Дом</p>
        <h3 id="object-lot-house-title">{object.title}</h3>
      </div>

      <div className={coverImage ? 'object-lot-house-overview' : 'object-lot-house-overview object-lot-house-overview--no-cover'}>
        {coverImage ? (
          <SecureImage
            accessToken={accessToken}
            alt={object.title}
            className="object-lot-house-cover"
            fileId={coverImage.file.id}
            placeholderClassName="object-lot-house-cover object-lot-house-cover--placeholder"
            variant="card"
          />
        ) : null}
        {object.metroStations.length > 0 ? (
          <ul className="metro-list object-lot-house-metro">
            {object.metroStations.map((station) => (
              <MetroStationItem key={station.id} station={station} />
            ))}
          </ul>
        ) : (
          <p className="muted-text">Метро не указано</p>
        )}
      </div>

      {address ? <p className="object-lot-house-address">{address}</p> : null}

      <div className="object-developer-row">
        <span className="object-developer-icon" aria-hidden="true">
          <Building2Icon />
        </span>
        <span className="object-developer-name">
          <small>Застройщик</small>
          <b>{object.developer?.name ?? 'Не указан'}</b>
        </span>
        <a
          className="object-detail-edit-link object-developer-link"
          href={objectPath}
          onClick={(event) => {
            event.preventDefault();
            navigate(objectPath);
          }}
        >
          Открыть объект
        </a>
      </div>
    </section>
  );
}

const objectLotSimilarLimit = 4;

/** «Ещё в этом доме»: lots of the same rooms (or type) in the object, closest to this lot by price. */
function ObjectLotSimilarSection({
  accessToken,
  navigate,
  object,
  unit,
}: {
  accessToken: string;
  navigate: (nextPathname: string) => void;
  object: RealEstateObjectDetail;
  unit: FeedUnit;
}) {
  const [units, setUnits] = useState<FeedUnit[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const similarUnits = useMemo(() => pickSimilarObjectLots(units, unit, objectLotSimilarLimit), [unit, units]);
  const allLotsPath = buildObjectLotsPath(object.slug, unit);

  useEffect(() => {
    if (!accessToken) {
      return;
    }

    const token = accessToken;
    let isCancelled = false;

    async function loadSimilarUnits() {
      setIsLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams();
        params.set('sortBy', 'price');
        params.set('sortDirection', 'asc');
        params.set('status', publicFeedUnitStatuses.join(','));
        params.set('type', unit.type);

        if (unit.rooms !== null) {
          params.set('rooms', String(unit.rooms));
        }

        const data = await apiRequest<FeedUnitGroupsResponse>(`/objects/${object.id}/feed-units/groups?${params.toString()}`, token);

        if (!isCancelled) {
          setUnits(data.groups.flatMap((group) => group.roomGroups.flatMap((roomGroup) => roomGroup.items)));
        }
      } catch (caughtError) {
        if (!isCancelled) {
          setUnits([]);
          setError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить лоты дома');
        }
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadSimilarUnits();

    return () => {
      isCancelled = true;
    };
  }, [accessToken, object.id, unit.id, unit.rooms, unit.type]);

  if (!isLoading && !error && similarUnits.length === 0) {
    return null;
  }

  const total = Math.max(units.length, similarUnits.length + 1);

  function openPath(event: ReactMouseEvent<HTMLAnchorElement>, path: string) {
    event.preventDefault();
    navigate(path);
    window.scrollTo({ top: 0 });
  }

  return (
    <section className="detail-section object-lot-similar-section" aria-labelledby="object-lot-similar-title">
      <div className="object-lot-similar-heading">
        <div>
          <p className="eyebrow">Ещё в этом доме</p>
          <h3 id="object-lot-similar-title">
            {isLoading ? getUnitRoomsOrType(unit) : `${getUnitRoomsOrType(unit)} · ${formatNumber(total)} ${formatPlural(total, ['лот', 'лота', 'лотов'])}`}
          </h3>
        </div>
        {isLoading || error ? null : (
          <a className="object-detail-edit-link" href={allLotsPath} onClick={(event) => openPath(event, allLotsPath)}>
            Все {formatNumber(total)}
          </a>
        )}
      </div>

      {error ? <p className="muted-text">{error}</p> : null}

      {isLoading ? (
        <div className="object-lot-similar-list" aria-hidden="true">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton className="object-lot-similar-skeleton" key={index} />
          ))}
        </div>
      ) : (
        <ul className="object-lot-similar-list">
          {similarUnits.map((similarUnit) => {
            const lotPath = buildObjectLotPath(object.slug, similarUnit.id);

            return (
              <li key={similarUnit.id}>
                <a className="object-lot-similar-row" href={lotPath} onClick={(event) => openPath(event, lotPath)}>
                  <span className="object-lot-similar-name">
                    <strong>{getFeedUnitTitle(similarUnit)}</strong>
                    <small>{formatObjectLotSimilarMeta(similarUnit)}</small>
                  </span>
                  <span className="object-lot-similar-price">{formatFeedUnitDiscountPrice(similarUnit)}</span>
                  <span className="object-lot-similar-open">Открыть</span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ObjectDetail({
  accessToken,
  canEditObject,
  navigate,
  object,
  onBack,
}: {
  accessToken: string;
  canEditObject: boolean;
  navigate: (nextPathname: string) => void;
  object: RealEstateObjectDetail;
  onBack: () => void;
}) {
  const descriptionParagraphs = useMemo(() => getDescriptionParagraphs(object), [object]);
  const contentSections = useMemo(() => getObjectContentSections(object), [object]);
  const locationLine = useMemo(() => getObjectLocationLine(object), [object]);
  const locationRows = useMemo(() => getLocationRows(object), [object]);
  const parameterRows = useMemo(() => getObjectParameterRows(object), [object]);
  const primaryPresentationFile = object.files.find((file) => file.type === 'PRESENTATION') ?? null;
  const listedFiles = object.files.filter((file) => file.id !== primaryPresentationFile?.id);
  const aerotourUrl = getExternalObjectUrl(object.aerotourUrl);
  const carouselImages = useMemo(() => getCarouselImages(object), [object]);
  const { src: mapBalloonImageUrl } = useSecureImageObjectUrl({
    accessToken,
    fileId: carouselImages[0]?.file.id ?? null,
    variant: 'card',
  });
  const mapPoints = useMemo(() => getObjectMapPoints(object, mapBalloonImageUrl), [mapBalloonImageUrl, object]);
  const editObjectPath = `/admin/objects/${object.id}/edit`;
  const hasLocation = Boolean(locationLine.district) || locationLine.areas.length > 0;
  const summaryFacts = useMemo(() => getObjectSummaryFacts(object, parameterRows), [object, parameterRows]);
  const lotsCount = object.feedUnitsCount ?? 0;
  const specRows = lotsCount > 0
    ? [...summaryFacts, { label: 'Лотов в продаже', value: formatNumber(lotsCount) }]
    : summaryFacts;
  const pricePerMeter = object.feedPricePerMeterFrom ?? object.pricePerMeterFrom;
  const priceValue = object.feedPriceFrom ?? object.priceFrom;
  const priceLabel = formatPriceFrom(priceValue);
  const priceMeta = [
    pricePerMeter ? formatPricePerMeterFrom(pricePerMeter) : null,
    lotsCount > 0 ? `${formatNumber(lotsCount)} ${formatPlural(lotsCount, ['лот', 'лота', 'лотов'])}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  // The lots section reports back whether the object has a feed at all; without one there is nothing to pick.
  const [hasFeedUnits, setHasFeedUnits] = useState(true);
  const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(false);
  const isDescriptionLong = descriptionParagraphs.join(' ').length > 420;

  function scrollToSection(sectionId: string) {
    document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Links like «Все 12» on a lot page open the object straight at its lots.
  useEffect(() => {
    if (window.location.hash !== '#object-lots') {
      return;
    }

    const frameId = window.requestAnimationFrame(() => scrollToSection('object-lots'));

    return () => window.cancelAnimationFrame(frameId);
  }, [object.id]);

  return (
    <div className="object-detail-page">
      <button className="text-button object-detail-back" type="button" onClick={onBack}>
        <ChevronLeftIcon aria-hidden="true" />
        Вернуться к каталогу
      </button>

      {/* Approved variant C «Кинозал»: the 16:9 photo spans the page, everything else sits under it. */}
      <ObjectImageCarousel accessToken={accessToken} images={carouselImages} objectTitle={object.title} />

      {/* Passport: title, price and actions; sticks to the top while the page scrolls. */}
      <header className="object-passport" aria-labelledby="object-title">
        <div className="object-passport-heading">
          <h2 id="object-title">{object.title}</h2>
          <p className="object-detail-location-line object-passport-location">
            {hasLocation ? <span>{locationLine.line.split(' / ').join(' · ')}</span> : null}
            {object.metroStations.map((station) => (
              <span className="object-passport-metro" key={station.id}>
                <i aria-hidden="true" style={{ background: normalizeLineColor(station.lineColor) ?? undefined }} />
                {station.name}
              </span>
            ))}
          </p>
        </div>

        <div className="object-passport-price" aria-labelledby="object-parameters-title">
          <p className="sr-only" id="object-parameters-title">
            Стоимость
          </p>
          <strong className="object-passport-price-value">{priceLabel}</strong>
          {priceMeta ? <small>{priceMeta}</small> : null}
        </div>

        <section className="object-files-section object-passport-actions" aria-labelledby="object-files-title">
          <h3 className="sr-only" id="object-files-title">
            Файлы и документы
          </h3>
          {object.status === 'PUBLISHED' ? null : (
            <span className={`status-pill object-status object-status--${object.status.toLowerCase()}`}>
              {objectStatusLabels[object.status]}
            </span>
          )}
          <div className="object-detail-actions object-files-primary-actions" aria-label="Действия по объекту">
            {primaryPresentationFile ? (
              <SecureFileButton
                accessToken={accessToken}
                className="object-detail-action-button object-detail-action-button--primary"
                fileId={primaryPresentationFile.file.id}
                label={<FileActionLabel>Презентация</FileActionLabel>}
                openingLabel="Открываем презентацию"
                wrapperClassName="object-detail-action"
              />
            ) : (
              <button className="object-detail-action-button object-detail-action-button--disabled" disabled type="button">
                <FileActionLabel>Презентация</FileActionLabel>
              </button>
            )}

            {aerotourUrl ? (
              <a
                className="object-detail-action-button object-detail-action-button--secondary"
                href={aerotourUrl}
                referrerPolicy="no-referrer"
                rel="noopener noreferrer nofollow"
                target="_blank"
              >
                <FileActionLabel>Аэротур</FileActionLabel>
              </a>
            ) : null}

            {object.layoutsUrl ? (
              <a
                className="object-detail-action-button object-detail-action-button--secondary"
                href={object.layoutsUrl}
                referrerPolicy="no-referrer"
                rel="noopener noreferrer nofollow"
                target="_blank"
              >
                <FileActionLabel>Планировки</FileActionLabel>
              </a>
            ) : (
              <button
                className="object-detail-action-button object-detail-action-button--disabled object-detail-action-button--missing"
                disabled
                type="button"
              >
                <FileActionLabel>Планировки</FileActionLabel>
              </button>
            )}
          </div>

          {hasFeedUnits ? (
            <button className="object-detail-summary-cta" type="button" onClick={() => scrollToSection('object-lots')}>
              Подобрать лот
            </button>
          ) : null}

          {canEditObject ? (
            <a aria-label="Редактировать" className="object-detail-edit-link" href={editObjectPath} title="Редактировать">
              <PencilIcon aria-hidden="true" />
            </a>
          ) : null}
        </section>
      </header>

      {/*
        Lots come right after the specs. On wide screens the documents sit next to the specs
        (grid placement); on phones the grid is one column, so documents follow the lots.
      */}
      <div
        className={
          specRows.length > 0 && listedFiles.length > 0 ? 'object-specs-grid object-specs-grid--split' : 'object-specs-grid'
        }
      >
        {specRows.length > 0 ? (
          <section className="detail-section object-specs-section" aria-labelledby="object-specs-title">
            <p className="eyebrow" id="object-specs-title">
              Характеристики
            </p>
            <dl className="object-specs-list">
              {specRows.map((row) => (
                <div key={row.label}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}

        <ObjectFeedUnitsSection
          accessToken={accessToken}
          navigate={navigate}
          object={object}
          onFeedUnitsAvailabilityChange={setHasFeedUnits}
        />

        {listedFiles.length > 0 ? (
          <section className="detail-section object-documents-section" aria-label="Документы">
            <FileList accessToken={accessToken} files={listedFiles} title="Дополнительные файлы" />
          </section>
        ) : null}
      </div>

      <div className="object-description-location-grid">
        <section className="detail-section object-description-section" aria-labelledby="object-description-title">
          <div>
            <p className="eyebrow">О проекте</p>
            <h3 id="object-description-title">Описание и особенности</h3>
          </div>
          {descriptionParagraphs.length > 0 ? (
            <>
              <div
                className={
                  isDescriptionLong && !isDescriptionExpanded
                    ? 'object-description object-description--collapsed'
                    : 'object-description'
                }
              >
                {descriptionParagraphs.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
              {isDescriptionLong ? (
                <button
                  aria-expanded={isDescriptionExpanded}
                  className="text-button object-description-toggle"
                  type="button"
                  onClick={() => setIsDescriptionExpanded((isExpanded) => !isExpanded)}
                >
                  {isDescriptionExpanded ? 'Свернуть' : 'Читать полностью'}
                </button>
              ) : null}
            </>
          ) : (
            <p className="muted-text">Описание пока не заполнено.</p>
          )}

          {object.developer ? (
            <div className="object-developer-row">
              <span className="object-developer-icon" aria-hidden="true">
                <Building2Icon />
              </span>
              <span className="object-developer-name">
                <small>Застройщик</small>
                <b>{object.developer.name}</b>
              </span>
              <a
                className="object-detail-edit-link object-developer-link"
                href={`/catalog?developerId=${object.developer.id}`}
                onClick={(event) => {
                  event.preventDefault();
                  navigate(`/catalog?developerId=${object.developer?.id ?? ''}`);
                }}
              >
                Все проекты
              </a>
            </div>
          ) : null}
        </section>

        <section className="detail-section object-location-section" aria-labelledby="object-location-title">
          <div>
            <p className="eyebrow">Расположение</p>
            <h3 id="object-location-title">Район, окружение и метро</h3>
          </div>

          {locationRows.length > 0 ? (
            <dl className="location-list">
              {locationRows.map((row) => (
                <div key={`${row.label}-${row.value}`}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="muted-text">Район не указан.</p>
          )}

          {object.metroStations.length > 0 ? (
            <ul className="metro-list" aria-label="Станции метро">
              {object.metroStations.map((station) => (
                <MetroStationItem key={station.id} station={station} />
              ))}
            </ul>
          ) : (
            <p className="muted-text">Метро не указано.</p>
          )}

          <button className="object-location-map-button" type="button" onClick={() => scrollToSection('object-map')}>
            <MapIcon aria-hidden="true" />
            Показать на карте
          </button>
        </section>
      </div>

      <section className="detail-section object-content-detail-section" aria-labelledby="object-content-sections-title">
        <div>
          <p className="eyebrow">Детали</p>
          <h3 id="object-content-sections-title">Архитектура, инфраструктура и наполнение</h3>
        </div>

        <div className="object-content-sections">
          {contentSections.map((section) => (
            <article className="object-content-section-item" key={section.label}>
              <h4>{section.label}</h4>
              <div
                className={
                  section.isEmpty
                    ? 'object-content-section-text object-content-section-text--empty'
                    : 'object-content-section-text'
                }
              >
                {section.paragraphs.map((paragraph, index) => (
                  <p key={`${section.label}-${index}`}>{paragraph}</p>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="detail-section object-map-section" id="object-map" aria-labelledby="object-map-title">
        <div>
          <p className="eyebrow">Карта</p>
          <h3 id="object-map-title">Локация и расположение</h3>
        </div>

        <PlatformMap
          ariaLabel="Карта объекта"
          emptyState={{
            eyebrow: 'Карта объекта',
            title: 'Координаты не указаны',
            description: 'Добавьте широту и долготу в карточке объекта, чтобы показать его на карте.',
          }}
          points={mapPoints}
        />
      </section>

    </div>
  );
}

/** Summary plaques «Срок · 2028»: short labels and filled values only; the price sits above them. */
function getObjectSummaryFacts(object: RealEstateObjectDetail, rows: Array<{ label: string; value: string }>) {
  const valueByLabel = new Map(rows.map((row) => [row.label, row.value]));
  const facts = [
    ['Срок', valueByLabel.get('Срок сдачи')],
    ['Площадь', object.feedAreaRange ?? valueByLabel.get('Площадь квартир')],
    ['Класс', valueByLabel.get('Класс недвижимости')],
    ['Этажность', valueByLabel.get('Этажность')],
    ['Потолки', valueByLabel.get('Высота потолков')],
    ['Застройщик', valueByLabel.get('Застройщик')],
  ] as const;

  return facts.flatMap(([label, value]) => {
    if (!value || value.startsWith('Не указ')) {
      return [];
    }

    return [{ label, value: value.replace(/(\d)\.(\d)/g, '$1,$2').replace(/(\d)\s*-\s*(\d)/g, '$1–$2') }];
  });
}

function ObjectImageCarousel({
  accessToken,
  images,
  objectTitle,
}: {
  accessToken: string;
  images: RealEstateObjectDetail['images'];
  objectTitle: string;
}) {
  const [activeSection, setActiveSection] = useState<ObjectImageSection | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const filteredImages = useMemo(() => {
    if (!activeSection) {
      return images;
    }

    return images.filter((image) => image.section === activeSection);
  }, [activeSection, images]);
  const activeImage = filteredImages[activeIndex] ?? null;
  const lightboxImage = lightboxIndex === null ? null : filteredImages[lightboxIndex] ?? null;
  const hasManyImages = filteredImages.length > 1;
  // Only sections that have photos get a tab; «Все» always leads back to the whole gallery.
  const sectionTabs = useMemo(
    () => sectionOptions.filter((option) => images.some((image) => image.section === option.value)),
    [images],
  );
  const hasSectionFilters = sectionTabs.length > 0;

  useEffect(() => {
    if (activeIndex > Math.max(filteredImages.length - 1, 0)) {
      setActiveIndex(0);
    }

    if (lightboxIndex !== null && lightboxIndex > Math.max(filteredImages.length - 1, 0)) {
      setLightboxIndex(null);
    }
  }, [activeIndex, filteredImages.length, lightboxIndex]);

  const thumbnailsRef = useRef<HTMLDivElement>(null);
  const touchStartXRef = useRef<number | null>(null);

  // Keep the active thumbnail visible in the filmstrip without scrolling the page.
  useEffect(() => {
    const strip = thumbnailsRef.current;
    const thumbnail = strip?.children[activeIndex];

    if (!strip || !(thumbnail instanceof HTMLElement)) {
      return;
    }

    strip.scrollTo({ left: thumbnail.offsetLeft - (strip.clientWidth - thumbnail.offsetWidth) / 2, behavior: 'smooth' });
  }, [activeIndex, filteredImages]);

  function handleStageTouchEnd(event: ReactTouchEvent<HTMLDivElement>) {
    const startX = touchStartXRef.current;
    const endX = event.changedTouches[0]?.clientX;
    touchStartXRef.current = null;

    if (!hasManyImages || startX === null || endX === undefined || Math.abs(endX - startX) < 40) {
      return;
    }

    if (endX < startX) {
      showNextImage();
    } else {
      showPreviousImage();
    }
  }

  function showPreviousImage() {
    setActiveIndex((currentIndex) => (currentIndex === 0 ? filteredImages.length - 1 : currentIndex - 1));
  }

  function showNextImage() {
    setActiveIndex((currentIndex) => (currentIndex + 1) % filteredImages.length);
  }

  function selectSection(section: ObjectImageSection | null) {
    setActiveSection(section);
    setActiveIndex(0);
    setLightboxIndex(null);
  }

  function openLightbox() {
    setLightboxIndex(activeIndex);
  }

  function closeLightbox() {
    setLightboxIndex(null);
  }

  function showPreviousLightboxImage() {
    setLightboxIndex((currentIndex) => {
      if (currentIndex === null) {
        return currentIndex;
      }

      return currentIndex === 0 ? filteredImages.length - 1 : currentIndex - 1;
    });
  }

  function showNextLightboxImage() {
    setLightboxIndex((currentIndex) => {
      if (currentIndex === null) {
        return currentIndex;
      }

      return (currentIndex + 1) % filteredImages.length;
    });
  }

  useEffect(() => {
    if (lightboxIndex === null) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        closeLightbox();
      }

      if (event.key === 'ArrowLeft' && hasManyImages) {
        event.preventDefault();
        showPreviousLightboxImage();
      }

      if (event.key === 'ArrowRight' && hasManyImages) {
        event.preventDefault();
        showNextLightboxImage();
      }
    }

    window.addEventListener('keydown', handleKeyDown);

    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [filteredImages.length, hasManyImages, lightboxIndex]);

  if (!activeImage) {
    return (
      <div className="media-gallery-frame object-image-carousel object-image-carousel--empty">
        <span>Фотографии пока не загружены</span>
      </div>
    );
  }

  return (
    <section className="media-gallery-frame object-image-carousel" aria-label="Галерея объекта">
      <div
        className="media-gallery-stage object-carousel-media"
        onTouchEnd={handleStageTouchEnd}
        onTouchStart={(event) => {
          touchStartXRef.current = event.touches[0]?.clientX ?? null;
        }}
      >
        <button
          aria-label="Открыть фото в полном размере"
          className="media-gallery-button object-carousel-media-button"
          type="button"
          onClick={openLightbox}
        >
          <SecureImage
            accessToken={accessToken}
            alt={activeImage.alt ?? objectTitle}
            className="media-gallery-image object-carousel-image"
            fileId={activeImage.file.id}
            variant="original"
          />
        </button>

        {hasManyImages ? (
          <>
            <button
              aria-label="Предыдущее фото"
              className="carousel-button carousel-button--previous"
              type="button"
              onClick={showPreviousImage}
            >
              <ChevronLeftIcon aria-hidden="true" />
            </button>
            <button
              aria-label="Следующее фото"
              className="carousel-button carousel-button--next"
              type="button"
              onClick={showNextImage}
            >
              <ChevronRightIcon aria-hidden="true" />
            </button>
          </>
        ) : null}
      </div>

      <div className="object-carousel-topbar">
        {hasSectionFilters ? (
          <div className="carousel-section-filters" aria-label="Разделы галереи">
            {[{ value: null, label: 'Все' }, ...sectionTabs].map((option) => (
              <button
                key={option.value ?? 'all'}
                aria-pressed={activeSection === option.value}
                className={
                  activeSection === option.value
                    ? 'carousel-section-filter carousel-section-filter--active'
                    : 'carousel-section-filter'
                }
                type="button"
                onClick={() => selectSection(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}

        <div className="object-carousel-corner">
          {hasManyImages ? (
            <span className="carousel-counter">
              {activeIndex + 1} / {filteredImages.length}
            </span>
          ) : null}
          <button className="object-carousel-expand" type="button" onClick={openLightbox}>
            <Maximize2Icon aria-hidden="true" />
            Во весь экран
          </button>
        </div>
      </div>

      {hasManyImages ? (
        <div className="carousel-thumbnail-zone object-carousel-filmstrip">
          <div className="carousel-thumbnails" aria-label="Миниатюры галереи" ref={thumbnailsRef}>
            {filteredImages.map((image, index) => (
              <button
                key={image.id}
                aria-label={`Фото ${index + 1}`}
                aria-current={index === activeIndex ? 'true' : undefined}
                className={index === activeIndex ? 'carousel-thumbnail carousel-thumbnail--active' : 'carousel-thumbnail'}
                type="button"
                onClick={() => setActiveIndex(index)}
              >
                <SecureImage
                  accessToken={accessToken}
                  alt={image.alt ?? `${objectTitle}, миниатюра ${index + 1}`}
                  fileId={image.file.id}
                  variant="thumbnail"
                />
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* Portal: the carousel is its own stacking context, so an in-place overlay would sit under the passport and the menu. */}
      {lightboxImage ? createPortal(
        <div className="carousel-modal-backdrop" onClick={closeLightbox}>
          <section
            aria-label="Полноразмерное фото объекта"
            aria-modal="true"
            className="carousel-modal"
            role="dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              aria-label="Закрыть полноразмерное фото"
              className="carousel-modal-close"
              type="button"
              onClick={closeLightbox}
            >
              ×
            </button>

            <a
              className="carousel-modal-download"
              download={getImageDownloadFileName(lightboxImage, objectTitle)}
              href={buildMediaFileContentUrl(lightboxImage.file.id, { download: true })}
            >
              <DownloadIcon aria-hidden="true" />
              Скачать оригинал
            </a>

            {hasManyImages ? (
              <button
                aria-label="Предыдущее полноразмерное фото"
                className="carousel-modal-button carousel-modal-button--previous"
                type="button"
                onClick={showPreviousLightboxImage}
              >
                ‹
              </button>
            ) : null}

            <div className="carousel-modal-image">
              <SecureImage
                accessToken={accessToken}
                alt={lightboxImage.alt ?? objectTitle}
                fileId={lightboxImage.file.id}
                variant="original"
              />
            </div>

            {hasManyImages ? (
              <>
                <button
                  aria-label="Следующее полноразмерное фото"
                  className="carousel-modal-button carousel-modal-button--next"
                  type="button"
                  onClick={showNextLightboxImage}
                >
                  ›
                </button>
                <span className="carousel-modal-counter">
                  {(lightboxIndex ?? 0) + 1} / {filteredImages.length}
                </span>
              </>
            ) : null}
          </section>
        </div>,
        document.body,
      ) : null}
    </section>
  );
}

function getImageDownloadFileName(image: RealEstateObjectDetail['images'][number], objectTitle: string) {
  return image.file.originalName?.trim() || `${objectTitle.trim() || 'object-image'}.jpg`;
}

function ObjectFeedUnitsSection({
  accessToken,
  navigate,
  object,
  onFeedUnitsAvailabilityChange,
}: {
  accessToken: string;
  navigate: (nextPathname: string) => void;
  object: RealEstateObjectDetail;
  onFeedUnitsAvailabilityChange: (hasFeedUnits: boolean) => void;
}) {
  const [groups, setGroups] = useState<FeedUnitGroupSummary[]>([]);
  const initialFilters = useMemo(() => getInitialObjectFeedUnitFiltersFromLocation(), []);
  const [total, setTotal] = useState(0);
  // null until the first response: the object may simply have no feed, and then there is nothing to show.
  const [objectFeedUnitsTotal, setObjectFeedUnitsTotal] = useState<number | null>(null);
  const [hasDiscountPrices, setHasDiscountPrices] = useState(false);
  const [expandedCompletionGroups, setExpandedCompletionGroups] = useState<Set<string>>(() => new Set());
  const [expandedRoomGroups, setExpandedRoomGroups] = useState<Set<string>>(() => new Set());
  const [visibleRoomLotCounts, setVisibleRoomLotCounts] = useState<Record<string, number>>({});
  const [searchFilter, setSearchFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [priceMinFilter, setPriceMinFilter] = useState(initialFilters.priceMin);
  const [priceMaxFilter, setPriceMaxFilter] = useState(initialFilters.priceMax);
  const [pricePerMeterMinFilter, setPricePerMeterMinFilter] = useState(initialFilters.pricePerMeterMin);
  const [pricePerMeterMaxFilter, setPricePerMeterMaxFilter] = useState(initialFilters.pricePerMeterMax);
  const [roomFilter, setRoomFilter] = useState(initialFilters.rooms);
  const [floorMinFilter, setFloorMinFilter] = useState(initialFilters.floorMin);
  const [floorMaxFilter, setFloorMaxFilter] = useState(initialFilters.floorMax);
  const [completionYearFilter, setCompletionYearFilter] = useState('');
  const [completionQuarterFilter, setCompletionQuarterFilter] = useState('');
  const [sortBy, setSortBy] = useState<ObjectFeedUnitSortBy>('price');
  const [sortDirection, setSortDirection] = useState<ObjectFeedUnitSortDirection>('asc');
  const [mediaCarouselUnit, setMediaCarouselUnit] = useState<FeedUnit | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const hasActiveFilters = Boolean(
    searchFilter.trim() ||
      statusFilter ||
      typeFilter ||
      priceMinFilter ||
      priceMaxFilter ||
      pricePerMeterMinFilter ||
      pricePerMeterMaxFilter ||
      roomFilter ||
      floorMinFilter ||
      floorMaxFilter ||
      completionYearFilter ||
      completionQuarterFilter,
  );
  const showFeedUnitsSkeleton = isLoading && groups.length === 0;
  const feedUnitsTableColumnCount = 11;
  const feedUnitsUpdatedAt = object.feedUpdatedAt ? formatObjectFeedUpdatedAt(object.feedUpdatedAt) : null;
  const priceFilterValue = formatObjectFeedPriceFilterValue(
    priceMinFilter,
    priceMaxFilter,
    pricePerMeterMinFilter,
    pricePerMeterMaxFilter,
  );
  const floorFilterValue = formatRangeValue(floorMinFilter, floorMaxFilter, (value) => value);
  const feedUnitFiltersKey = [
    object.id,
    searchFilter.trim(),
    statusFilter,
    typeFilter,
    priceMinFilter,
    priceMaxFilter,
    pricePerMeterMinFilter,
    pricePerMeterMaxFilter,
    roomFilter,
    floorMinFilter,
    floorMaxFilter,
    completionYearFilter,
    completionQuarterFilter,
  ].join('\u001f');
  const previousFeedUnitFiltersKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (objectFeedUnitsTotal !== null) {
      onFeedUnitsAvailabilityChange(objectFeedUnitsTotal > 0);
    }
  }, [objectFeedUnitsTotal, onFeedUnitsAvailabilityChange]);

  useEffect(() => {
    if (!accessToken) {
      return;
    }

    const token = accessToken;
    let isCancelled = false;

    async function loadFeedUnits() {
      setIsLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams();
        params.set('sortBy', sortBy);
        params.set('sortDirection', sortDirection);

        if (statusFilter) {
          params.set('status', statusFilter);
        } else {
          params.set('status', publicFeedUnitStatuses.join(','));
        }

        if (typeFilter) {
          params.set('type', typeFilter);
        }

        setOptionalParam(params, 'search', searchFilter.trim());
        setOptionalParam(params, 'priceMin', priceMinFilter);
        setOptionalParam(params, 'priceMax', priceMaxFilter);
        setOptionalParam(params, 'pricePerMeterMin', pricePerMeterMinFilter);
        setOptionalParam(params, 'pricePerMeterMax', pricePerMeterMaxFilter);
        setOptionalParam(params, 'rooms', roomFilter);
        setOptionalParam(params, 'floorMin', floorMinFilter);
        setOptionalParam(params, 'floorMax', floorMaxFilter);
        setOptionalParam(params, 'completionYear', completionYearFilter);
        setOptionalParam(params, 'completionQuarter', completionQuarterFilter);

        const data = await apiRequest<FeedUnitGroupsResponse>(`/objects/${object.id}/feed-units/groups?${params.toString()}`, token);

        if (!isCancelled) {
          const shouldResetExpandedGroups = previousFeedUnitFiltersKeyRef.current !== feedUnitFiltersKey;

          previousFeedUnitFiltersKeyRef.current = feedUnitFiltersKey;
          setGroups(data.groups);
          setTotal(data.total);
          setObjectFeedUnitsTotal(data.objectFeedUnitsTotal);
          setHasDiscountPrices(data.hasDiscountPrices);
          if (shouldResetExpandedGroups) {
            setVisibleRoomLotCounts({});
            setExpandedCompletionGroups(new Set());
            setExpandedRoomGroups(new Set());
          }
        }
      } catch (caughtError) {
        if (!isCancelled) {
          setGroups([]);
          setTotal(0);
          setHasDiscountPrices(false);
          setExpandedCompletionGroups(new Set());
          setExpandedRoomGroups(new Set());
          setVisibleRoomLotCounts({});
          setError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить лоты');
        }
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadFeedUnits();

    return () => {
      isCancelled = true;
    };
  }, [
    accessToken,
    completionQuarterFilter,
    completionYearFilter,
    feedUnitFiltersKey,
    floorMaxFilter,
    floorMinFilter,
    object.id,
    priceMaxFilter,
    priceMinFilter,
    pricePerMeterMaxFilter,
    pricePerMeterMinFilter,
    roomFilter,
    searchFilter,
    sortBy,
    sortDirection,
    statusFilter,
    typeFilter,
  ]);

  function resetFilters() {
    setSearchFilter('');
    setStatusFilter('');
    setTypeFilter('');
    setPriceMinFilter('');
    setPriceMaxFilter('');
    setPricePerMeterMinFilter('');
    setPricePerMeterMaxFilter('');
    setRoomFilter('');
    setFloorMinFilter('');
    setFloorMaxFilter('');
    setCompletionYearFilter('');
    setCompletionQuarterFilter('');
    setVisibleRoomLotCounts({});
  }

  function handleCurrencyInputBackspace(
    event: ReactKeyboardEvent<HTMLInputElement>,
    setNextValue: (nextValue: string) => void,
  ) {
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
    setNextValue(sanitizeDecimalText(nextValue));
    setVisibleRoomLotCounts({});
  }

  function handleSort(field: ObjectFeedUnitSortBy) {
    const nextDirection: ObjectFeedUnitSortDirection = sortBy === field && sortDirection === 'desc' ? 'asc' : 'desc';

    setSortBy(field);
    setSortDirection(nextDirection);
  }

  function toggleCompletionGroup(groupKey: string) {
    setExpandedCompletionGroups((currentGroups) => {
      const nextGroups = new Set(currentGroups);

      if (nextGroups.has(groupKey)) {
        nextGroups.delete(groupKey);
      } else {
        nextGroups.add(groupKey);
      }

      return nextGroups;
    });
  }

  function toggleRoomGroup(roomExpansionKey: string) {
    setExpandedRoomGroups((currentGroups) => {
      const nextGroups = new Set(currentGroups);

      if (nextGroups.has(roomExpansionKey)) {
        nextGroups.delete(roomExpansionKey);
      } else {
        nextGroups.add(roomExpansionKey);
      }

      return nextGroups;
    });
  }

  // An object without a feed has no lots to filter, so the whole section stays out of the page.
  if (objectFeedUnitsTotal === 0) {
    return null;
  }

  return (
    <section className="detail-section object-feed-units-section" id="object-lots" aria-labelledby="object-feed-units-title">
      <div className="object-feed-units-heading">
        <div className="object-feed-units-heading-title">
          <p className="eyebrow">Планировки и цены</p>
          <h3 id="object-feed-units-title">Лоты</h3>
          {feedUnitsUpdatedAt ? (
            <p className="object-feed-updated-at">Обновлено: {feedUnitsUpdatedAt}</p>
          ) : null}
        </div>
        <span>{isLoading ? 'Загрузка лотов' : `Лотов: ${formatNumber(total)}`}</span>
      </div>

      <div className="object-feed-units-toolbar" aria-label="Фильтры лотов">
        <div className="catalog-filter-search-row">
          <label className="catalog-filter-search">
            <span className="sr-only">Поиск лота</span>
            <span className="catalog-filter-search-field">
              <SearchIcon aria-hidden="true" />
              <input
                placeholder="Номер квартиры, корпус или адрес"
                type="search"
                value={searchFilter}
                onChange={(event) => {
                  setSearchFilter(event.target.value);
                  setVisibleRoomLotCounts({});
                }}
              />
            </span>
          </label>

          <div className="catalog-filter-header-actions">
            <button
              aria-label="Сбросить фильтры лотов"
              className="catalog-filter-reset object-feed-units-reset-button"
              disabled={!hasActiveFilters}
              type="button"
              onClick={resetFilters}
            >
              <RotateCcwIcon aria-hidden="true" className="catalog-filter-reset-icon" />
              <span>Сбросить</span>
            </button>
          </div>
        </div>

        <div className="catalog-filter-bar" role="group" aria-label="Параметры лотов">
          <FilterPill
            ariaLabel="Фильтр лотов по статусу"
            isSet={Boolean(statusFilter)}
            label="Доступные и резерв"
            value={feedUnitStatusFilterOptions.find((option) => option.value === statusFilter)?.label ?? ''}
          >
            {(close) => (
              <DropdownListbox aria-label="Фильтр лотов по статусу">
                {[{ value: '', label: 'Доступные и резерв' }, ...feedUnitStatusFilterOptions].map((option) => (
                  <DropdownOption
                    key={option.value || 'public'}
                    label={option.label}
                    selected={option.value === statusFilter}
                    onSelect={() => {
                      setStatusFilter(option.value);
                      setVisibleRoomLotCounts({});
                      close('select');
                    }}
                  />
                ))}
              </DropdownListbox>
            )}
          </FilterPill>

          <FilterPill
            ariaLabel="Фильтр лотов по типу"
            isSet={Boolean(typeFilter)}
            label="Все типы"
            value={feedUnitTypeFilterOptions.find((option) => option.value === typeFilter)?.label ?? ''}
          >
            {(close) => (
              <DropdownListbox aria-label="Фильтр лотов по типу">
                {[{ value: '', label: 'Все типы' }, ...feedUnitTypeFilterOptions].map((option) => (
                  <DropdownOption
                    key={option.value || 'all'}
                    label={option.label}
                    selected={option.value === typeFilter}
                    onSelect={() => {
                      setTypeFilter(option.value);
                      setVisibleRoomLotCounts({});
                      close('select');
                    }}
                  />
                ))}
              </DropdownListbox>
            )}
          </FilterPill>

          <span aria-hidden="true" className="catalog-filter-divider" />

          <FilterPill
            ariaLabel="Фильтр лотов по цене"
            isSet={Boolean(priceFilterValue)}
            label="Цена"
            menuClassName="catalog-filter-popover"
            value={priceFilterValue}
          >
            {(close) => (
              <>
                <div className="catalog-filter-range object-feed-units-filter-range--price" aria-label="Диапазон цены лота" role="group">
                  <span className="catalog-filter-range-title">Цена лота</span>
                  <div className="catalog-filter-range-field">
                    <label>
                      от
                      <input
                        inputMode="decimal"
                        placeholder="0 ₽"
                        type="text"
                        value={formatCurrencyInputValue(priceMinFilter)}
                        onChange={(event) => {
                          setPriceMinFilter(sanitizeDecimalText(event.target.value));
                          setVisibleRoomLotCounts({});
                        }}
                        onKeyDown={(event) => handleCurrencyInputBackspace(event, setPriceMinFilter)}
                      />
                    </label>
                    <i aria-hidden="true" />
                    <label>
                      до
                      <input
                        inputMode="decimal"
                        placeholder="50 000 000 ₽"
                        type="text"
                        value={formatCurrencyInputValue(priceMaxFilter)}
                        onChange={(event) => {
                          setPriceMaxFilter(sanitizeDecimalText(event.target.value));
                          setVisibleRoomLotCounts({});
                        }}
                        onKeyDown={(event) => handleCurrencyInputBackspace(event, setPriceMaxFilter)}
                      />
                    </label>
                  </div>
                </div>

                <div
                  className="catalog-filter-range object-feed-units-filter-range--price-meter"
                  aria-label="Диапазон цены за метр лота"
                  role="group"
                >
                  <span className="catalog-filter-range-title">Цена за м²</span>
                  <div className="catalog-filter-range-field">
                    <label>
                      от
                      <input
                        inputMode="decimal"
                        placeholder="0 ₽"
                        type="text"
                        value={formatCurrencyInputValue(pricePerMeterMinFilter)}
                        onChange={(event) => {
                          setPricePerMeterMinFilter(sanitizeDecimalText(event.target.value));
                          setVisibleRoomLotCounts({});
                        }}
                        onKeyDown={(event) => handleCurrencyInputBackspace(event, setPricePerMeterMinFilter)}
                      />
                    </label>
                    <i aria-hidden="true" />
                    <label>
                      до
                      <input
                        inputMode="decimal"
                        placeholder="500 000 ₽"
                        type="text"
                        value={formatCurrencyInputValue(pricePerMeterMaxFilter)}
                        onChange={(event) => {
                          setPricePerMeterMaxFilter(sanitizeDecimalText(event.target.value));
                          setVisibleRoomLotCounts({});
                        }}
                        onKeyDown={(event) => handleCurrencyInputBackspace(event, setPricePerMeterMaxFilter)}
                      />
                    </label>
                  </div>
                </div>

                <FilterPopoverFooter
                  onClear={() => {
                    setPriceMinFilter('');
                    setPriceMaxFilter('');
                    setPricePerMeterMinFilter('');
                    setPricePerMeterMaxFilter('');
                    setVisibleRoomLotCounts({});
                  }}
                  onDone={() => close('select')}
                />
              </>
            )}
          </FilterPill>

          <FilterPill
            ariaLabel="Фильтр лотов по комнатам"
            isSet={Boolean(roomFilter)}
            label="Комнаты"
            value={formatPillSelection(
              feedUnitRoomFilterOptions
                .filter((option) => getFeedUnitRoomFilterValues(roomFilter).includes(option.value))
                .map((option) => option.label),
            )}
          >
            {() => (
              <DropdownListbox aria-label="Фильтр лотов по комнатам" aria-multiselectable={true}>
                <DropdownOption
                  label="Любые"
                  selected={!roomFilter}
                  onSelect={() => {
                    setRoomFilter('');
                    setVisibleRoomLotCounts({});
                  }}
                />
                {feedUnitRoomFilterOptions.map((option) => {
                  const selectedValues = getFeedUnitRoomFilterValues(roomFilter);
                  const isSelected = selectedValues.includes(option.value);

                  return (
                    <DropdownOption
                      key={option.value}
                      label={option.label}
                      selected={isSelected}
                      onSelect={() => {
                        setRoomFilter(
                          formatFeedUnitRoomFilterValues(
                            isSelected
                              ? selectedValues.filter((value) => value !== option.value)
                              : [...selectedValues, option.value],
                          ),
                        );
                        setVisibleRoomLotCounts({});
                      }}
                    />
                  );
                })}
              </DropdownListbox>
            )}
          </FilterPill>

          <FilterPill
            ariaLabel="Фильтр лотов по этажу"
            isSet={Boolean(floorFilterValue)}
            label="Этаж"
            menuClassName="catalog-filter-popover"
            value={floorFilterValue}
          >
            {(close) => (
              <>
                <div className="catalog-filter-range object-feed-units-filter-range--floor" aria-label="Диапазон этажа лота" role="group">
                  <span className="catalog-filter-range-title">Этаж</span>
                  <div className="catalog-filter-range-field">
                    <label>
                      от
                      <input
                        inputMode="numeric"
                        placeholder="1"
                        type="text"
                        value={floorMinFilter}
                        onChange={(event) => {
                          setFloorMinFilter(sanitizeIntegerText(event.target.value, 3));
                          setVisibleRoomLotCounts({});
                        }}
                      />
                    </label>
                    <i aria-hidden="true" />
                    <label>
                      до
                      <input
                        inputMode="numeric"
                        placeholder="25"
                        type="text"
                        value={floorMaxFilter}
                        onChange={(event) => {
                          setFloorMaxFilter(sanitizeIntegerText(event.target.value, 3));
                          setVisibleRoomLotCounts({});
                        }}
                      />
                    </label>
                  </div>
                </div>

                <FilterPopoverFooter
                  onClear={() => {
                    setFloorMinFilter('');
                    setFloorMaxFilter('');
                    setVisibleRoomLotCounts({});
                  }}
                  onDone={() => close('select')}
                />
              </>
            )}
          </FilterPill>

          <FilterPill
            ariaLabel="Фильтр лотов по сроку сдачи"
            isSet={Boolean(completionYearFilter)}
            label="Срок сдачи"
            menuClassName="catalog-filter-popover"
            value={
              completionYearFilter
                ? [feedUnitQuarterFilterOptions.find((option) => option.value === completionQuarterFilter)?.label, completionYearFilter]
                    .filter(Boolean)
                    .join(' ')
                : ''
            }
          >
            {(close) => (
              <>
                <div className="catalog-filter-range object-feed-units-filter--completion-year" role="group" aria-label="Год сдачи">
                  <span className="catalog-filter-range-title">Год сдачи</span>
                  <div className="catalog-filter-range-field catalog-filter-range-field--single">
                    <label>
                      год
                      <input
                        inputMode="numeric"
                        placeholder="2028"
                        type="text"
                        value={completionYearFilter}
                        onChange={(event) => {
                          const nextYear = sanitizeIntegerText(event.target.value, 4);

                          setCompletionYearFilter(nextYear);
                          if (!nextYear) {
                            setCompletionQuarterFilter('');
                          }
                          setVisibleRoomLotCounts({});
                        }}
                      />
                    </label>
                  </div>
                </div>

                <div className="catalog-filter-range object-feed-units-filter--completion-quarter" role="group" aria-label="Квартал">
                  <span className="catalog-filter-range-title">Квартал</span>
                  <div className="object-feed-units-quarters">
                    {[{ value: '', label: 'Любой' }, ...feedUnitQuarterFilterOptions].map((option) => (
                      <button
                        aria-pressed={completionQuarterFilter === option.value}
                        disabled={!completionYearFilter}
                        key={option.value || 'any'}
                        type="button"
                        onClick={() => {
                          setCompletionQuarterFilter(option.value);
                          setVisibleRoomLotCounts({});
                        }}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>

                <FilterPopoverFooter
                  onClear={() => {
                    setCompletionYearFilter('');
                    setCompletionQuarterFilter('');
                    setVisibleRoomLotCounts({});
                  }}
                  onDone={() => close('select')}
                />
              </>
            )}
          </FilterPill>
        </div>
      </div>

      {showFeedUnitsSkeleton ? (
        <div className="table-scroll object-feed-units-table-wrap">
          <Table className="object-feed-units-table">
            <TableBody>
              <ObjectFeedUnitsTableSkeleton columnsCount={feedUnitsTableColumnCount} />
            </TableBody>
          </Table>
        </div>
      ) : null}

      {!showFeedUnitsSkeleton && error ? (
        <div className="object-feed-units-state object-feed-units-state--error">
          <strong>Не удалось загрузить лоты</strong>
          <span>{error}</span>
        </div>
      ) : null}

      {!showFeedUnitsSkeleton && !error && groups.length === 0 ? (
        <div className="object-feed-units-state">
          <strong>{hasActiveFilters ? 'Лоты не найдены' : 'Свободных лотов нет'}</strong>
          <span>
            {hasActiveFilters
              ? 'Измените или сбросьте фильтры.'
              : 'Все лоты этого объекта проданы или сняты с продажи.'}
          </span>
        </div>
      ) : null}

      {!showFeedUnitsSkeleton && !error && groups.length > 0 ? (
        <div className="object-feed-groups">
          {groups.map((group) => (
            <ObjectFeedCompletionGroup
              accessToken={accessToken}
              expandedRoomGroups={expandedRoomGroups}
              group={group}
              isExpanded={expandedCompletionGroups.has(group.key)}
              key={group.key}
              navigate={navigate}
              objectSlug={object.slug}
              sortBy={sortBy}
              sortDirection={sortDirection}
              visibleRoomLotCounts={visibleRoomLotCounts}
              onOpenMedia={setMediaCarouselUnit}
              onShowMoreLots={(roomExpansionKey, visibleCount) => {
                setVisibleRoomLotCounts((currentCounts) => ({
                  ...currentCounts,
                  [roomExpansionKey]: visibleCount + objectFeedUnitsPageSize,
                }));
              }}
              onSort={handleSort}
              onToggleCompletionGroup={toggleCompletionGroup}
              onToggleRoomGroup={toggleRoomGroup}
            />
          ))}
        </div>
      ) : null}

      <ObjectFeedMediaCarousel
        accessToken={accessToken}
        unit={mediaCarouselUnit}
        onClose={() => setMediaCarouselUnit(null)}
      />
    </section>
  );
}

function ObjectFeedCompletionGroup({
  accessToken,
  expandedRoomGroups,
  group,
  isExpanded,
  navigate,
  objectSlug,
  sortBy,
  sortDirection,
  visibleRoomLotCounts,
  onOpenMedia,
  onShowMoreLots,
  onSort,
  onToggleCompletionGroup,
  onToggleRoomGroup,
}: {
  accessToken: string;
  expandedRoomGroups: Set<string>;
  group: FeedUnitGroupSummary;
  isExpanded: boolean;
  navigate: (nextPathname: string) => void;
  objectSlug: string;
  sortBy: ObjectFeedUnitSortBy;
  sortDirection: ObjectFeedUnitSortDirection;
  visibleRoomLotCounts: Record<string, number>;
  onOpenMedia: (unit: FeedUnit) => void;
  onShowMoreLots: (roomExpansionKey: string, visibleCount: number) => void;
  onSort: (field: ObjectFeedUnitSortBy) => void;
  onToggleCompletionGroup: (groupKey: string) => void;
  onToggleRoomGroup: (roomExpansionKey: string) => void;
}) {
  const buildingsLabel = group.buildings.length > 0 ? group.buildings.join(', ') : 'Корпуса не указаны';

  return (
    <section className="object-feed-completion-group">
      <button
        aria-expanded={isExpanded}
        className="object-feed-completion-button"
        type="button"
        onClick={() => onToggleCompletionGroup(group.key)}
      >
        {isExpanded ? <ChevronDownIcon aria-hidden="true" /> : <ChevronRightIcon aria-hidden="true" />}
        <span>
          <strong>{buildingsLabel}</strong>
          <small>{group.label}</small>
        </span>
        <b>{formatNumber(group.total)}</b>
      </button>

      {isExpanded ? (
        <div className="object-feed-room-groups">
          {group.roomGroups.map((roomGroup) => {
            const roomExpansionKey = makeRoomGroupExpansionKey(group.key, roomGroup.key);

            return (
              <ObjectFeedRoomGroup
                accessToken={accessToken}
                isExpanded={expandedRoomGroups.has(roomExpansionKey)}
                key={roomExpansionKey}
                navigate={navigate}
                objectSlug={objectSlug}
                roomExpansionKey={roomExpansionKey}
                roomGroup={roomGroup}
                sortBy={sortBy}
                sortDirection={sortDirection}
                visibleCount={visibleRoomLotCounts[roomExpansionKey] ?? objectFeedUnitsPageSize}
                onOpenMedia={onOpenMedia}
                onShowMoreLots={onShowMoreLots}
                onSort={onSort}
                onToggleRoomGroup={onToggleRoomGroup}
              />
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function ObjectFeedRoomGroup({
  accessToken,
  isExpanded,
  navigate,
  objectSlug,
  roomExpansionKey,
  roomGroup,
  sortBy,
  sortDirection,
  visibleCount,
  onOpenMedia,
  onShowMoreLots,
  onSort,
  onToggleRoomGroup,
}: {
  accessToken: string;
  isExpanded: boolean;
  navigate: (nextPathname: string) => void;
  objectSlug: string;
  roomExpansionKey: string;
  roomGroup: FeedUnitRoomGroupSummary;
  sortBy: ObjectFeedUnitSortBy;
  sortDirection: ObjectFeedUnitSortDirection;
  visibleCount: number;
  onOpenMedia: (unit: FeedUnit) => void;
  onShowMoreLots: (roomExpansionKey: string, visibleCount: number) => void;
  onSort: (field: ObjectFeedUnitSortBy) => void;
  onToggleRoomGroup: (roomExpansionKey: string) => void;
}) {
  const visibleItems = roomGroup.items.slice(0, visibleCount);
  const hiddenItemsCount = Math.max(0, roomGroup.items.length - visibleItems.length);

  return (
    <section className="object-feed-room-group">
      <button
        aria-expanded={isExpanded}
        className="object-feed-room-row"
        type="button"
        onClick={() => onToggleRoomGroup(roomExpansionKey)}
      >
        <span className="object-feed-room-name">
          <strong>{roomGroup.label}</strong>
          <small>
            {formatFeedUnitRange(roomGroup.areaMin, roomGroup.areaMax, formatArea)} ·{' '}
            {formatNumber(roomGroup.total)} {formatPlural(roomGroup.total, ['лот', 'лота', 'лотов'])}
          </small>
        </span>
        <span className="object-feed-room-price">
          {formatFeedUnitRange(roomGroup.priceMin, roomGroup.priceMax, (value) => formatFeedUnitPrice(value, null))}
        </span>
        <span className="object-feed-room-toggle">
          {isExpanded ? 'Скрыть' : 'Показать'}
          {isExpanded ? <ChevronDownIcon aria-hidden="true" /> : <ChevronRightIcon aria-hidden="true" />}
        </span>
      </button>

      {isExpanded ? (
        <>
          <div className="table-scroll object-feed-units-table-wrap">
            <Table className="object-feed-units-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Медиа</TableHead>
                  <ObjectFeedSortableHead field="building" sortBy={sortBy} sortDirection={sortDirection} onSort={onSort}>
                    Корпус
                  </ObjectFeedSortableHead>
                  <TableHead>Секц.</TableHead>
                  <ObjectFeedSortableHead field="floor" sortBy={sortBy} sortDirection={sortDirection} onSort={onSort}>
                    Эт.
                  </ObjectFeedSortableHead>
                  <ObjectFeedSortableHead field="title" sortBy={sortBy} sortDirection={sortDirection} onSort={onSort}>
                    Номер квартиры
                  </ObjectFeedSortableHead>
                  <ObjectFeedSortableHead field="area" sortBy={sortBy} sortDirection={sortDirection} onSort={onSort}>
                    Площадь
                  </ObjectFeedSortableHead>
                  <ObjectFeedSortableHead field="price" sortBy={sortBy} sortDirection={sortDirection} onSort={onSort}>
                    Цена
                  </ObjectFeedSortableHead>
                  <ObjectFeedSortableHead field="discountPrice" sortBy={sortBy} sortDirection={sortDirection} onSort={onSort}>
                    Цена со скидкой
                  </ObjectFeedSortableHead>
                  <ObjectFeedSortableHead field="pricePerMeter" sortBy={sortBy} sortDirection={sortDirection} onSort={onSort}>
                    За м²
                  </ObjectFeedSortableHead>
                  <ObjectFeedSortableHead field="status" sortBy={sortBy} sortDirection={sortDirection} onSort={onSort}>
                    Статус
                  </ObjectFeedSortableHead>
                  <TableHead aria-label="В работе" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleItems.map((unit) => (
                  <ObjectFeedUnitRow
                    accessToken={accessToken}
                    key={unit.id}
                    navigate={navigate}
                    objectSlug={objectSlug}
                    unit={unit}
                    onOpenMedia={onOpenMedia}
                  />
                ))}
              </TableBody>
            </Table>
          </div>

          {hiddenItemsCount > 0 ? (
            <button
              className="text-button object-feed-room-show-more"
              type="button"
              onClick={() => onShowMoreLots(roomExpansionKey, visibleCount)}
            >
              Показать еще {formatNumber(Math.min(objectFeedUnitsPageSize, hiddenItemsCount))}
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function ObjectFeedSortableHead({
  children,
  field,
  sortBy,
  sortDirection,
  onSort,
}: {
  children: ReactNode;
  field: ObjectFeedUnitSortBy;
  sortBy: ObjectFeedUnitSortBy;
  sortDirection: ObjectFeedUnitSortDirection;
  onSort: (field: ObjectFeedUnitSortBy) => void;
}) {
  const isActive = sortBy === field;
  const ariaSort: 'ascending' | 'descending' | 'none' = isActive
    ? sortDirection === 'desc'
      ? 'descending'
      : 'ascending'
    : 'none';

  return (
    <TableHead aria-sort={ariaSort}>
      <button
        className={`object-feed-sort-button${isActive ? ' is-active' : ''}`}
        type="button"
        onClick={() => onSort(field)}
      >
        <span>{children}</span>
        {isActive ? (
          sortDirection === 'desc' ? (
            <ArrowDownIcon aria-hidden="true" />
          ) : (
            <ArrowUpIcon aria-hidden="true" />
          )
        ) : (
          <ArrowUpDownIcon aria-hidden="true" />
        )}
      </button>
    </TableHead>
  );
}

function ObjectFeedUnitRow({
  accessToken,
  navigate,
  objectSlug,
  unit,
  onOpenMedia,
}: {
  accessToken: string;
  navigate: (nextPathname: string) => void;
  objectSlug: string;
  unit: FeedUnit;
  onOpenMedia: (unit: FeedUnit) => void;
}) {
  const primaryMedia = unit.media.find((media) => media.file) ?? null;
  const title = getFeedUnitTitle(unit);
  const mediaButtonLabel = `Открыть файлы лота ${title}`;
  const lotHref = buildObjectLotPath(objectSlug, unit.id);

  function openLotInNewTab() {
    window.open(lotHref, '_blank', 'noopener,noreferrer');
  }

  function handleRowKeyDown(event: ReactKeyboardEvent<HTMLTableRowElement>) {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }

    event.preventDefault();
    openLotInNewTab();
  }

  return (
    <TableRow
      aria-label={`Открыть карточку лота ${title}`}
      className="object-feed-unit-row"
      role="link"
      tabIndex={0}
      onClick={openLotInNewTab}
      onKeyDown={handleRowKeyDown}
    >
      <TableCell>
        {primaryMedia?.file ? (
          <button
            aria-label={mediaButtonLabel}
            className="object-feed-media-button"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpenMedia(unit);
            }}
          >
            <span className="object-feed-media-preview">
              <SecureImage
                accessToken={accessToken}
                alt={primaryMedia.label ?? unit.title ?? 'Медиа лота'}
                className="object-feed-media-image"
                fileId={primaryMedia.file.id}
                lazy
                placeholderClassName="object-feed-media-placeholder"
                variant="thumbnail"
              />
            </span>
            <span>{formatMediaCount(unit.media.length)}</span>
          </button>
        ) : (
          <span className="object-feed-media-empty">{formatMediaCount(0)}</span>
        )}
      </TableCell>
      <TableCell>{formatFeedUnitBuildingValue(unit.building)}</TableCell>
      <TableCell>{formatFeedUnitShortValue(unit.section)}</TableCell>
      <TableCell>{unit.floor ?? 'Не указан'}</TableCell>
      <TableCell>
        <div className="object-feed-unit-cell">
          <a
            className="object-feed-unit-link"
            href={lotHref}
            rel="noopener noreferrer"
            target="_blank"
            onClick={(event) => event.stopPropagation()}
          >
            <strong>{title}</strong>
          </a>
          {unit.address ? <span>{unit.address}</span> : null}
        </div>
      </TableCell>
      <TableCell>{formatArea(unit.area)}</TableCell>
      <TableCell>{formatFeedUnitPrice(unit.price, unit.currency)}</TableCell>
      <TableCell>
        {hasFeedUnitRealDiscount(unit) ? (
          <strong>{formatFeedUnitDiscountPrice(unit)}</strong>
        ) : (
          formatFeedUnitDiscountPrice(unit)
        )}
      </TableCell>
      <TableCell>{formatFeedUnitPricePerMeter(unit)}</TableCell>
      <TableCell>
        <span className={`object-feed-status object-feed-status--${unit.status.toLowerCase()}`}>
          {feedUnitStatusLabels[unit.status]}
        </span>
      </TableCell>
      <TableCell>
        <LotCollectionAction mode="icon" navigate={navigate} unitId={unit.id} />
      </TableCell>
    </TableRow>
  );
}

function ObjectFeedMediaCarousel({
  accessToken,
  unit,
  onClose,
}: {
  accessToken: string;
  unit: FeedUnit | null;
  onClose: () => void;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [fullscreenMedia, setFullscreenMedia] = useState<FeedUnit['media'][number] | null>(null);
  const mediaItems = useMemo(() => unit?.media.filter(hasFeedMediaFile) ?? [], [unit]);
  const activeMedia = mediaItems[activeIndex] ?? mediaItems[0] ?? null;
  const hasManyMedia = mediaItems.length > 1;

  useEffect(() => {
    if (!unit) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (fullscreenMedia) {
          setFullscreenMedia(null);
          return;
        }

        onClose();
      }

      if (event.key === 'ArrowLeft' && hasManyMedia) {
        event.preventDefault();

        if (fullscreenMedia) {
          showPreviousFullscreenMedia();
          return;
        }

        showPreviousMedia();
      }

      if (event.key === 'ArrowRight' && hasManyMedia) {
        event.preventDefault();

        if (fullscreenMedia) {
          showNextFullscreenMedia();
          return;
        }

        showNextMedia();
      }
    }

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeIndex, fullscreenMedia, hasManyMedia, mediaItems, onClose, unit]);

  useEffect(() => {
    setActiveIndex(0);
    setFullscreenMedia(null);
  }, [unit?.id]);

  if (!unit) {
    return null;
  }

  const title = getFeedUnitTitle(unit);

  function showPreviousMedia() {
    setActiveIndex((currentIndex) => wrapCarouselIndex(currentIndex - 1, mediaItems.length));
  }

  function showNextMedia() {
    setActiveIndex((currentIndex) => wrapCarouselIndex(currentIndex + 1, mediaItems.length));
  }

  function getFullscreenMediaIndex() {
    if (!fullscreenMedia) {
      return activeIndex;
    }

    const fullscreenMediaIndex = mediaItems.findIndex((media) => media.id === fullscreenMedia.id);

    return fullscreenMediaIndex === -1 ? activeIndex : fullscreenMediaIndex;
  }

  function showFullscreenMediaByOffset(offset: number) {
    const nextIndex = wrapCarouselIndex(getFullscreenMediaIndex() + offset, mediaItems.length);

    setActiveIndex(nextIndex);
    setFullscreenMedia(mediaItems[nextIndex] ?? null);
  }

  function showPreviousFullscreenMedia() {
    showFullscreenMediaByOffset(-1);
  }

  function showNextFullscreenMedia() {
    showFullscreenMediaByOffset(1);
  }

  return (
    <div className="object-feed-media-carousel-backdrop" onClick={onClose}>
      <section
        aria-labelledby="object-feed-media-carousel-title"
        className="object-feed-media-carousel"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="object-feed-media-carousel-header">
          <div>
            <p className="eyebrow">Медиа лота</p>
            <h3 id="object-feed-media-carousel-title">{title}</h3>
            <span>{formatMediaCount(mediaItems.length)}</span>
          </div>
          <button
            aria-label="Закрыть карусель файлов"
            className="object-feed-media-carousel-close"
            type="button"
            onClick={onClose}
          >
            <XIcon aria-hidden="true" />
          </button>
        </header>

        {activeMedia ? (
          <>
            <div className="object-feed-media-carousel-stage">
              {hasManyMedia ? (
                <button
                  aria-label="Предыдущий файл лота"
                  className="object-feed-media-carousel-nav object-feed-media-carousel-nav--previous"
                  type="button"
                  onClick={showPreviousMedia}
                >
                  <ChevronLeftIcon aria-hidden="true" />
                </button>
              ) : null}

              <button
                aria-label="Открыть фото лота на полный экран"
                className="object-feed-media-carousel-image-button"
                type="button"
                onClick={() => setFullscreenMedia(activeMedia)}
              >
                <SecureImage
                  accessToken={accessToken}
                  alt={getFeedMediaTitle(activeMedia)}
                  className="object-feed-media-carousel-image"
                  fileId={activeMedia.file.id}
                  placeholderClassName="object-feed-media-placeholder"
                  variant="original"
                />
              </button>

              {hasManyMedia ? (
                <button
                  aria-label="Следующий файл лота"
                  className="object-feed-media-carousel-nav object-feed-media-carousel-nav--next"
                  type="button"
                  onClick={showNextMedia}
                >
                  <ChevronRightIcon aria-hidden="true" />
                </button>
              ) : null}
            </div>

            <div className="object-feed-media-carousel-caption">
              <strong>{getFeedMediaTitle(activeMedia)}</strong>
              <span>
                {activeIndex + 1} / {mediaItems.length}
              </span>
            </div>

            {hasManyMedia ? (
              <div className="object-feed-media-carousel-thumbs" aria-label="Файлы лота">
                {unit.media.map((media) => {
                  if (!hasFeedMediaFile(media)) {
                    return null;
                  }

                  const mediaIndex = mediaItems.findIndex((item) => item.id === media.id);
                  const mediaTitle = getFeedMediaTitle(media);

                  return (
                    <button
                      aria-label={`Показать файл ${mediaTitle}`}
                      className={`object-feed-media-carousel-thumb${mediaIndex === activeIndex ? ' is-active' : ''}`}
                      key={media.id}
                      type="button"
                      onClick={() => setActiveIndex(mediaIndex)}
                    >
                      <SecureImage
                        accessToken={accessToken}
                        alt={mediaTitle}
                        className="object-feed-media-carousel-thumb-image"
                        fileId={media.file.id}
                        lazy
                        placeholderClassName="object-feed-media-placeholder"
                        variant="thumbnail"
                      />
                    </button>
                  );
                })}
              </div>
            ) : null}
          </>
        ) : (
          <div className="object-feed-media-carousel-empty">Файлы не найдены.</div>
        )}
      </section>

      {fullscreenMedia?.file ? (
        <div className="object-feed-media-fullscreen" onClick={(event) => event.stopPropagation()}>
          <button
            aria-label="Закрыть полноэкранное фото"
            className="object-feed-media-fullscreen-close"
            type="button"
            onClick={() => setFullscreenMedia(null)}
          >
            <XIcon aria-hidden="true" />
          </button>
          <a
            aria-label="Скачать оригинал полноэкранного медиа лота"
            className="object-feed-media-fullscreen-open"
            download={getFeedMediaDownloadFileName(fullscreenMedia)}
            href={buildMediaFileContentUrl(fullscreenMedia.file.id, { download: true })}
          >
            <DownloadIcon aria-hidden="true" />
            Скачать оригинал
          </a>
          {hasManyMedia ? (
            <>
              <button
                aria-label="Предыдущее полноэкранное медиа лота"
                className="object-feed-media-fullscreen-nav object-feed-media-fullscreen-nav--previous"
                type="button"
                onClick={showPreviousFullscreenMedia}
              >
                <ChevronLeftIcon aria-hidden="true" />
              </button>
              <button
                aria-label="Следующее полноэкранное медиа лота"
                className="object-feed-media-fullscreen-nav object-feed-media-fullscreen-nav--next"
                type="button"
                onClick={showNextFullscreenMedia}
              >
                <ChevronRightIcon aria-hidden="true" />
              </button>
            </>
          ) : null}
          <button
            aria-label="Закрыть полноэкранное фото"
            className="object-feed-media-fullscreen-image-button"
            type="button"
            onClick={() => setFullscreenMedia(null)}
          >
            <SecureImage
              accessToken={accessToken}
              alt={getFeedMediaTitle(fullscreenMedia)}
              className="object-feed-media-fullscreen-image"
              fileId={fullscreenMedia.file.id}
              placeholderClassName="object-feed-media-placeholder"
              variant="original"
            />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ObjectLotMediaCarousel({ accessToken, unit }: { accessToken: string; unit: FeedUnit }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [fullscreenMedia, setFullscreenMedia] = useState<FeedMediaWithFile | null>(null);
  const mediaItems = useMemo(() => unit.media.filter(hasFeedMediaFile), [unit.media]);
  const activeMedia = mediaItems[activeIndex] ?? mediaItems[0] ?? null;
  const hasManyMedia = mediaItems.length > 1;

  useEffect(() => {
    setActiveIndex(0);
    setFullscreenMedia(null);
  }, [unit.id]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setFullscreenMedia(null);
      }

      if (event.key === 'ArrowLeft' && hasManyMedia) {
        event.preventDefault();

        if (fullscreenMedia) {
          showPreviousFullscreenMedia();
          return;
        }

        showPreviousMedia();
      }

      if (event.key === 'ArrowRight' && hasManyMedia) {
        event.preventDefault();

        if (fullscreenMedia) {
          showNextFullscreenMedia();
          return;
        }

        showNextMedia();
      }
    }

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeIndex, fullscreenMedia, hasManyMedia, mediaItems]);

  function showPreviousMedia() {
    setActiveIndex((currentIndex) => wrapCarouselIndex(currentIndex - 1, mediaItems.length));
  }

  function showNextMedia() {
    setActiveIndex((currentIndex) => wrapCarouselIndex(currentIndex + 1, mediaItems.length));
  }

  function getFullscreenMediaIndex() {
    if (!fullscreenMedia) {
      return activeIndex;
    }

    const fullscreenMediaIndex = mediaItems.findIndex((media) => media.id === fullscreenMedia.id);

    return fullscreenMediaIndex === -1 ? activeIndex : fullscreenMediaIndex;
  }

  function showFullscreenMediaByOffset(offset: number) {
    const nextIndex = wrapCarouselIndex(getFullscreenMediaIndex() + offset, mediaItems.length);

    setActiveIndex(nextIndex);
    setFullscreenMedia(mediaItems[nextIndex] ?? null);
  }

  function showPreviousFullscreenMedia() {
    showFullscreenMediaByOffset(-1);
  }

  function showNextFullscreenMedia() {
    showFullscreenMediaByOffset(1);
  }

  if (!activeMedia) {
    return (
      <section className="media-gallery-frame object-lot-media-carousel object-lot-media-carousel--empty" aria-label="Медиа лота">
        <span>Медиа лота пока не загружены</span>
      </section>
    );
  }

  return (
    <section className="media-gallery-frame object-lot-media-carousel" aria-label="Медиа лота">
      <div className="media-gallery-stage object-lot-media-stage">
        {hasManyMedia ? (
          <button
            aria-label="Предыдущее медиа лота"
            className="carousel-button carousel-button--previous object-lot-media-nav"
            type="button"
            onClick={showPreviousMedia}
          >
            ‹
          </button>
        ) : null}

        <button
          aria-label="Открыть медиа лота на полный экран"
          className="media-gallery-button object-lot-media-button"
          type="button"
          onClick={() => setFullscreenMedia(activeMedia)}
        >
          <SecureImage
            accessToken={accessToken}
            alt={getFeedMediaTitle(activeMedia)}
            className="media-gallery-image object-lot-media-image"
            fileId={activeMedia.file.id}
            placeholderClassName="object-feed-media-placeholder"
            variant="original"
          />
        </button>

        {hasManyMedia ? (
          <>
            <button
              aria-label="Следующее медиа лота"
              className="carousel-button carousel-button--next object-lot-media-nav"
              type="button"
              onClick={showNextMedia}
            >
              ›
            </button>
            <span className="carousel-counter">
              {activeIndex + 1} / {mediaItems.length}
            </span>
          </>
        ) : null}
      </div>

      {hasManyMedia ? (
        <div className="carousel-thumbnail-zone object-lot-thumbnail-zone">
          <div className="carousel-thumbnails object-lot-thumbnails" aria-label="Миниатюры медиа лота">
            {mediaItems.map((media, index) => (
              <button
                key={media.id}
                aria-label={`Медиа ${index + 1}`}
                className={index === activeIndex ? 'carousel-thumbnail carousel-thumbnail--active' : 'carousel-thumbnail'}
                type="button"
                onClick={() => setActiveIndex(index)}
              >
                <SecureImage
                  accessToken={accessToken}
                  alt={getFeedMediaTitle(media)}
                  fileId={media.file.id}
                  placeholderClassName="object-feed-media-placeholder"
                  variant="thumbnail"
                />
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {fullscreenMedia ? (
        <div className="object-feed-media-fullscreen">
          <button
            aria-label="Закрыть полноэкранное медиа"
            className="object-feed-media-fullscreen-close"
            type="button"
            onClick={() => setFullscreenMedia(null)}
          >
            <XIcon aria-hidden="true" />
          </button>
          <a
            aria-label="Скачать оригинал полноэкранного медиа"
            className="object-feed-media-fullscreen-open"
            download={getFeedMediaDownloadFileName(fullscreenMedia)}
            href={buildMediaFileContentUrl(fullscreenMedia.file.id, { download: true })}
          >
            <DownloadIcon aria-hidden="true" />
            Скачать оригинал
          </a>
          {hasManyMedia ? (
            <>
              <button
                aria-label="Предыдущее полноэкранное медиа лота"
                className="object-feed-media-fullscreen-nav object-feed-media-fullscreen-nav--previous"
                type="button"
                onClick={showPreviousFullscreenMedia}
              >
                <ChevronLeftIcon aria-hidden="true" />
              </button>
              <button
                aria-label="Следующее полноэкранное медиа лота"
                className="object-feed-media-fullscreen-nav object-feed-media-fullscreen-nav--next"
                type="button"
                onClick={showNextFullscreenMedia}
              >
                <ChevronRightIcon aria-hidden="true" />
              </button>
            </>
          ) : null}
          <button
            aria-label="Закрыть полноэкранное медиа"
            className="object-feed-media-fullscreen-image-button"
            type="button"
            onClick={() => setFullscreenMedia(null)}
          >
            <SecureImage
              accessToken={accessToken}
              alt={getFeedMediaTitle(fullscreenMedia)}
              className="object-feed-media-fullscreen-image"
              fileId={fullscreenMedia.file.id}
              placeholderClassName="object-feed-media-placeholder"
              variant="original"
            />
          </button>
        </div>
      ) : null}
    </section>
  );
}

function hasFeedMediaFile(media: FeedUnit['media'][number]): media is FeedMediaWithFile {
  return Boolean(media.file);
}

function wrapCarouselIndex(index: number, itemsCount: number) {
  if (itemsCount <= 0) {
    return 0;
  }

  if (index < 0) {
    return itemsCount - 1;
  }

  if (index >= itemsCount) {
    return 0;
  }

  return index;
}

function sortFeedUnitsForDisplay(
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

function getInitialObjectFeedUnitFiltersFromLocation(): InitialObjectFeedUnitFilters {
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

function parseInitialObjectFeedUnitRooms(value: string | null) {
  return formatFeedUnitRoomFilterValues(getFeedUnitRoomFilterValues(value ?? ''));
}

/** Price pill value: lot price range first, price per m² as «+1» or on its own. */
function formatObjectFeedPriceFilterValue(priceMin: string, priceMax: string, pricePerMeterMin: string, pricePerMeterMax: string) {
  const lotPrice = formatRangeValue(priceMin, priceMax, formatCompactMoney);
  const pricePerMeter = formatRangeValue(pricePerMeterMin, pricePerMeterMax, formatCompactMoney);

  if (lotPrice && pricePerMeter) {
    return `${lotPrice} +1`;
  }

  return lotPrice || (pricePerMeter ? `за м² ${pricePerMeter}` : '');
}

function makeRoomGroupExpansionKey(completionGroupKey: string, roomGroupKey: string) {
  return `${completionGroupKey}:${roomGroupKey}`;
}

function formatFeedUnitRange(valueMin: string | null, valueMax: string | null, formatter: (value: string) => string) {
  if (!valueMin && !valueMax) {
    return 'Не указано';
  }

  if (valueMin && valueMax && valueMin !== valueMax) {
    return `${formatter(valueMin)} - ${formatter(valueMax)}`;
  }

  return formatter(valueMin ?? valueMax ?? '');
}

function getFeedUnitRoomFilterValues(value: string) {
  const valueSet = new Set(
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

  return feedUnitRoomFilterOptions.filter((option) => valueSet.has(option.value)).map((option) => option.value);
}

function formatFeedUnitRoomFilterValues(values: string[]) {
  const valueSet = new Set(values);

  return feedUnitRoomFilterOptions
    .filter((option) => valueSet.has(option.value))
    .map((option) => option.value)
    .join(',');
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

function setOptionalParam(params: URLSearchParams, key: string, value: string) {
  if (value.trim()) {
    params.set(key, value);
  }
}

function sanitizeIntegerText(value: string, maxLength: number) {
  return value.replace(/\D/g, '').slice(0, maxLength);
}

function sanitizeDecimalText(value: string) {
  return value.replace(/[^\d,.]/g, '').replace(',', '.').slice(0, 15);
}

function ObjectFeedUnitsTableSkeleton({ columnsCount }: { columnsCount: number }) {
  return (
    <>
      {Array.from({ length: 4 }, (_, index) => (
        <TableRow key={index}>
          <TableCell colSpan={columnsCount}>
            <Skeleton className="object-feed-units-skeleton" />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

function FileList({
  accessToken,
  files,
  title,
}: {
  accessToken: string;
  files: ObjectLinkedFile[];
  title: string;
}) {
  return (
    <div className="detail-file-group">
      <h4>{title}</h4>
      <ul className="detail-file-list">
        {files.map((file) => {
          const displayTitle = getLinkedFileTitle(file, fileTypeLabels);

          return (
            <li key={file.id}>
              <div>
                <strong>{displayTitle}</strong>
                <span>
                  {fileTypeLabels[file.type]}
                  {file.file.sizeBytes ? `, ${formatFileSize(file.file.sizeBytes)}` : ''}
                </span>
              </div>
              <SecureFileButton accessToken={accessToken} fileId={file.file.id} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FileActionLabel({ children }: { children: ReactNode }) {
  return <span className="object-file-action-label">{children}</span>;
}

function MetroStationItem({ station }: { station: ObjectMetroStationLink }) {
  const lineColor = normalizeLineColor(station.lineColor);

  return (
    <li>
      <span className="metro-line-dot" style={lineColor ? { background: lineColor } : undefined} />
      <div>
        <strong>{station.name}</strong>
        <span>{station.lineName ?? 'Линия не указана'}</span>
      </div>
    </li>
  );
}

function SecureFileButton({
  className = 'text-button',
  fileId,
  label = 'Открыть',
  wrapperClassName = 'detail-file-action',
}: {
  accessToken: string;
  className?: string;
  fileId: string;
  label?: ReactNode;
  openingLabel?: string;
  wrapperClassName?: string;
}) {
  return (
    <div className={wrapperClassName}>
      <a className={className} href={buildMediaFileContentUrl(fileId)} rel="noopener noreferrer" target="_blank">
        {label}
      </a>
    </div>
  );
}

function formatFeedUnitPrice(value: string | null, currency: string | null) {
  if (!value) {
    return 'По запросу';
  }

  if (currency && !['RUB', 'RUR'].includes(currency.toUpperCase())) {
    return `${formatNumber(Number(value))} ${currency}`;
  }

  return formatPrice(value);
}

function formatFeedUnitDiscountPrice(unit: FeedUnit) {
  return formatFeedUnitPrice(unit.discountPrice ?? unit.price, unit.currency);
}

function formatArea(value: string | null) {
  if (!value) {
    return 'Не указана';
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return `${value} м²`;
  }

  return `${formatNumber(parsed)} м²`;
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

function formatFeedUnitPricePerMeter(unit: FeedUnit) {
  const pricePerMeter = getFeedUnitPricePerMeterValue(unit);

  return pricePerMeter === null ? 'По запросу' : formatFeedUnitPrice(String(pricePerMeter), unit.currency);
}

function formatComputedFeedUnitPricePerMeter(unit: FeedUnit) {
  return formatFeedUnitPricePerMeter(unit);
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

function hasFeedUnitRealDiscount(unit: FeedUnit) {
  if (!unit.price || !unit.discountPrice) {
    return false;
  }

  const price = Number(unit.price);
  const discountPrice = Number(unit.discountPrice);

  return Number.isFinite(price) && Number.isFinite(discountPrice) && price > 0 && discountPrice > 0 && discountPrice < price;
}

function getObjectLotPriceSummary(unit: FeedUnit) {
  const hasRealDiscount = hasFeedUnitRealDiscount(unit);

  return {
    label: hasRealDiscount ? 'Цена со скидкой' : 'Стоимость',
    primaryPrice: formatFeedUnitPrice(hasRealDiscount ? unit.discountPrice : unit.price, unit.currency),
    secondaryPrice: hasRealDiscount ? formatFeedUnitPrice(unit.price, unit.currency) : null,
    secondaryPricePerMeter: hasRealDiscount ? formatFeedUnitBasePricePerMeter(unit) : null,
  };
}

function formatFeedUnitCompletion(unit: FeedUnit) {
  if (!unit.completionYear) {
    return null;
  }

  if (!unit.completionQuarter) {
    return String(unit.completionYear);
  }

  return `${unit.completionQuarter} кв. ${unit.completionYear}`;
}

/** Lot area with tenths kept at any size: «140,7 м²», not the table's rounded «141 м²». */
function formatObjectLotArea(value: string | null) {
  const parsedValue = parseNullableNumber(value);

  if (parsedValue === null) {
    return null;
  }

  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(parsedValue)} м²`;
}

function formatObjectLotBuilding(unit: FeedUnit) {
  const building = unit.building?.trim();
  const section = unit.section?.trim();

  if (building && section) {
    return { label: 'Корпус', value: `${building}, секция ${section}` };
  }

  if (building) {
    return { label: 'Корпус', value: building };
  }

  return section ? { label: 'Секция', value: section } : null;
}

function getObjectLotHeaderLine(object: RealEstateObjectDetail, unit: FeedUnit) {
  const building = formatObjectLotBuilding(unit);

  return [
    object.title,
    building ? `${building.label.toLocaleLowerCase('ru-RU')} ${building.value}` : null,
    unit.floor === null ? null : `${unit.floor} этаж`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Summary plaques «Площадь · 140,7 м²»: filled values only; the price and status sit above them. */
function getObjectLotSummaryFacts(unit: FeedUnit) {
  const building = formatObjectLotBuilding(unit);
  const commercialDetails = unit.commercialDetails;
  const facts: Array<{ label: string; value: string | null; isWide?: boolean }> = [
    { label: 'Тип', value: getUnitRoomsOrType(unit) },
    { label: 'Площадь', value: formatObjectLotArea(unit.area) },
    { label: 'Жилая', value: formatObjectLotArea(unit.residentialDetails?.livingArea ?? null) },
    { label: 'Кухня', value: formatObjectLotArea(unit.residentialDetails?.kitchenArea ?? null) },
    { label: 'Потолки', value: commercialDetails?.ceilingHeight ? `${commercialDetails.ceilingHeight.replace('.', ',')} м` : null },
    { label: 'Мощность', value: commercialDetails?.powerKw ? `${commercialDetails.powerKw.replace('.', ',')} кВт` : null },
    {
      label: 'Вход',
      value: commercialDetails?.separateEntrance ? 'Отдельный' : commercialDetails?.entrance?.trim() || null,
    },
    { label: 'Этаж', value: unit.floor === null ? null : String(unit.floor) },
    { label: 'Срок', value: formatFeedUnitCompletion(unit) },
    { label: building?.label ?? 'Корпус', value: building?.value ?? null, isWide: true },
  ];

  return facts.flatMap((fact) => (fact.value ? [{ label: fact.label, value: fact.value, isWide: fact.isWide ?? false }] : []));
}

function getObjectLotLayoutMedia(unit: FeedUnit) {
  const mediaItems = unit.media.filter(hasFeedMediaFile);

  return mediaItems.find((media) => media.label === 'layout-photo') ?? mediaItems[0] ?? null;
}

function pickSimilarObjectLots(units: FeedUnit[], currentUnit: FeedUnit, limit: number) {
  const currentPrice = getEffectiveFeedUnitPrice(currentUnit);

  return units
    .filter((candidate) => candidate.id !== currentUnit.id)
    .map((candidate) => ({
      unit: candidate,
      distance:
        currentPrice === null ? 0 : Math.abs((getEffectiveFeedUnitPrice(candidate) ?? Number.MAX_SAFE_INTEGER) - currentPrice),
    }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, limit)
    .map((entry) => entry.unit)
    .sort((left, right) => compareNullableNumber(getEffectiveFeedUnitPrice(left), getEffectiveFeedUnitPrice(right)));
}

function formatObjectLotSimilarMeta(unit: FeedUnit) {
  return [
    formatObjectLotArea(unit.area),
    unit.floor === null ? null : `${unit.floor} этаж`,
    unit.section?.trim() ? `секция ${unit.section.trim()}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Object page with the lots list narrowed to this lot's rooms and scrolled into view. */
function buildObjectLotsPath(objectSlug: string, unit: FeedUnit) {
  const query = unit.rooms !== null && getFeedUnitRoomFilterValues(String(unit.rooms)).length > 0 ? `?lotRooms=${unit.rooms}` : '';

  return `/objects/${encodeURIComponent(objectSlug)}${query}#object-lots`;
}

function formatFeedUnitShortValue(value: string | null) {
  return value?.trim() || 'Не указано';
}

function formatFeedUnitBuildingValue(value: string | null) {
  return value?.trim() || 'Корпус не указан';
}

function getUnitRoomsOrType(unit: FeedUnit) {
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

function getFeedUnitTitle(unit: FeedUnit) {
  return unit.title?.trim() || 'Лот без названия';
}

function buildObjectLotPath(objectSlug: string, unitId: string) {
  return `/objects/${encodeURIComponent(objectSlug)}/lots/${encodeURIComponent(unitId)}`;
}

function formatBuildingSection(unit: FeedUnit) {
  const building = unit.building ? `Корпус ${unit.building}` : null;
  const section = unit.section ? `Секция ${unit.section}` : null;
  const parts = [building, section].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(' / ') : 'Не указаны';
}

function formatMediaCount(value: number) {
  if (value === 0) {
    return 'Нет';
  }

  return `${formatNumber(value)} ${formatPlural(value, ['файл', 'файла', 'файлов'])}`;
}

function formatObjectFeedUpdatedAt(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const day = padDatePart(date.getDate());
  const month = padDatePart(date.getMonth() + 1);
  const year = date.getFullYear();
  const hours = padDatePart(date.getHours());
  const minutes = padDatePart(date.getMinutes());

  return `${day}.${month}.${year} ${hours}:${minutes}`;
}

function padDatePart(value: number) {
  return String(value).padStart(2, '0');
}

function getFeedMediaTitle(media: FeedUnit['media'][number]) {
  return media.label ?? media.file?.originalName ?? media.file?.mimeType ?? media.contentType ?? 'Файл';
}

function getFeedMediaDownloadFileName(media: FeedUnit['media'][number]) {
  return media.file?.originalName?.trim() || media.label?.trim() || 'original-media';
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) {
    return 'Не указано';
  }

  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: value < 100 ? 1 : 0,
  }).format(value);
}

function formatPlural(value: number, forms: [string, string, string]) {
  const normalizedValue = Math.abs(value) % 100;
  const lastDigit = normalizedValue % 10;

  if (normalizedValue > 10 && normalizedValue < 20) {
    return forms[2];
  }

  if (lastDigit > 1 && lastDigit < 5) {
    return forms[1];
  }

  if (lastDigit === 1) {
    return forms[0];
  }

  return forms[2];
}

function getDescriptionParagraphs(object: RealEstateObjectDetail) {
  return (object.description ?? '')
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function getCarouselImages(object: RealEstateObjectDetail) {
  const coverImage = object.images.find((image) => image.isCover) ?? object.images[0] ?? null;

  if (!coverImage) {
    return [];
  }

  return [coverImage, ...object.images.filter((image) => image.id !== coverImage.id)];
}

function getObjectMapPoints(object: RealEstateObjectDetail, imageUrl: string | null): MapPoint[] {
  const coordinates = getValidMapCoordinate(object.latitude, object.longitude);

  if (!coordinates) {
    return [];
  }

  return [
    {
      id: object.id,
      title: object.title,
      hint: object.title,
      coordinates,
      popupHtml: buildObjectMapPopup(object, imageUrl),
      markerLabel: resolveMapMarkerLabel(object),
    },
  ];
}

function buildObjectMapPopup(object: RealEstateObjectDetail, imageUrl: string | null) {
  const title = escapeHtml(object.title);
  const location = escapeHtml(getObjectDistrictLocation(object)?.name ?? 'Район не указан');
  const address = object.address ? escapeHtml(object.address) : null;
  const developer = escapeHtml(object.developer?.name ?? 'Застройщик не указан');
  const price = escapeHtml(formatPriceFrom(object.priceFrom));
  const completion = escapeHtml(formatCompletion(object.completionYear, object.completionQuarter));
  const image = imageUrl ? `<img class="map-balloon-image" src="${escapeHtml(imageUrl)}" alt="${title}" />` : '';

  return [
    '<div class="map-balloon">',
    image,
    `<strong>${title}</strong>`,
    `<span>${location}</span>`,
    address ? `<span>${address}</span>` : '',
    `<span>${developer}</span>`,
    `<span>${price}, ${completion}</span>`,
    '</div>',
  ]
    .filter(Boolean)
    .join('');
}

function formatCompactRussianNumber(value: number) {
  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: value < 10 ? 1 : 0,
  }).format(value);
}

function formatFileSize(value: string) {
  const size = Number(value);

  if (!Number.isFinite(size)) {
    return value;
  }

  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} КБ`;
  }

  return `${(size / 1024 / 1024).toFixed(1)} МБ`;
}

function normalizeLineColor(value: string | null) {
  if (!value) {
    return null;
  }

  const trimmedValue = value.trim();

  return /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/iu.test(trimmedValue) ? trimmedValue : null;
}

function getExternalObjectUrl(value: string | null) {
  const trimmedValue = value?.trim();

  if (!trimmedValue) {
    return null;
  }

  try {
    const url = new URL(trimmedValue);

    return url.protocol === 'http:' || url.protocol === 'https:' ? trimmedValue : null;
  } catch {
    return null;
  }
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
