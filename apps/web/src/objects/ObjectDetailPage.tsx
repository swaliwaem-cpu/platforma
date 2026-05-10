import { useEffect, useMemo, useState } from 'react';
import type {
  ObjectFileType,
  ObjectLinkedFile,
  ObjectLocation,
  ObjectMetroStationLink,
  ObjectResponse,
  RealEstateObjectDetail,
} from '@platforma/shared';

import { apiRequest, apiUrl } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';
import { YandexMap, type YandexMapPoint } from '../map/YandexMap';

type ObjectDetailPageProps = {
  slug: string;
  onBack: () => void;
};

type FeatureRow = {
  label: string;
  value: string;
};

type DisplayLocation = Pick<ObjectLocation, 'id' | 'name' | 'type'>;

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

export function ObjectDetailPage({ slug, onBack }: ObjectDetailPageProps) {
  const { accessToken } = useAuth();
  const [object, setObject] = useState<RealEstateObjectDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  return <ObjectDetail object={object} accessToken={accessToken ?? ''} onBack={onBack} />;
}

function ObjectDetail({
  accessToken,
  object,
  onBack,
}: {
  accessToken: string;
  object: RealEstateObjectDetail;
  onBack: () => void;
}) {
  const descriptionParagraphs = useMemo(() => getDescriptionParagraphs(object), [object]);
  const districtLocation = useMemo(() => getObjectDistrictLocation(object), [object]);
  const locationRows = useMemo(() => getLocationRows(object), [object]);
  const presentationFiles = object.files.filter((file) => file.type === 'PRESENTATION');
  const otherFiles = object.files.filter((file) => file.type !== 'PRESENTATION');
  const carouselImages = useMemo(() => getCarouselImages(object), [object]);
  const mapBalloonImageUrl = useSecureImageObjectUrl(accessToken, carouselImages[0]?.file.id ?? null);
  const mapPoints = useMemo(() => getObjectMapPoints(object, mapBalloonImageUrl), [mapBalloonImageUrl, object]);

  return (
    <div className="object-detail-page">
      <header className="page-header object-detail-header">
        <div>
          <button className="text-button" type="button" onClick={onBack}>
            Вернуться к каталогу
          </button>
          <p className="eyebrow">Объект</p>
          <h2>{object.title}</h2>
        </div>
        {object.status === 'PUBLISHED' ? null : (
          <span className={`status-pill object-status object-status--${object.status.toLowerCase()}`}>
            {objectStatusLabels[object.status]}
          </span>
        )}
      </header>

      <section className="object-detail-hero" aria-label="Основные данные объекта">
        <ObjectImageCarousel accessToken={accessToken} images={carouselImages} objectTitle={object.title} />

        <div className="object-detail-summary">
          <dl className="object-detail-metrics">
            <div>
              <dt>Цена</dt>
              <dd>{formatPrice(object.priceFrom)}</dd>
            </div>
            <div>
              <dt>За метр</dt>
              <dd>{formatPrice(object.pricePerMeterFrom)}</dd>
            </div>
            <div>
              <dt>Район</dt>
              <dd>{districtLocation?.name ?? 'Не указан'}</dd>
            </div>
            <div>
              <dt>Застройщик</dt>
              <dd>{object.developer?.name ?? 'Не указан'}</dd>
            </div>
          </dl>

          {object.layoutsUrl ? (
            <div className="object-layouts-cta">
              <span>Планировки и цены</span>
              <a
                href={object.layoutsUrl}
                referrerPolicy="no-referrer"
                rel="noopener noreferrer nofollow"
                target="_blank"
              >
                Открыть на сайте застройщика
              </a>
            </div>
          ) : null}
        </div>
      </section>

      <div className="object-detail-layout">
        <div className="object-detail-main">
          <section className="detail-section object-map-section" aria-labelledby="object-map-title">
            <div>
              <p className="eyebrow">Карта</p>
              <h3 id="object-map-title">На карте</h3>
            </div>

            <YandexMap
              emptyState={{
                eyebrow: 'Карта объекта',
                title: 'Координаты не указаны',
                description: 'Добавьте широту и долготу в карточке объекта, чтобы показать его на карте.',
              }}
              points={mapPoints}
            />
          </section>

          <section className="detail-section" aria-labelledby="object-description-title">
            <div>
              <p className="eyebrow">Описание</p>
              <h3 id="object-description-title">Описание и особенности</h3>
            </div>
            {descriptionParagraphs.length > 0 ? (
              <div className="object-description">
                {descriptionParagraphs.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
            ) : (
              <p className="muted-text">Описание пока не заполнено.</p>
            )}
          </section>
        </div>

        <aside className="object-detail-aside">
          <section className="detail-section" aria-labelledby="object-files-title">
            <div>
              <p className="eyebrow">Файлы</p>
              <h3 id="object-files-title">Презентация и документы</h3>
            </div>

            {presentationFiles.length > 0 ? (
              <FileList accessToken={accessToken} files={presentationFiles} title="Презентация" />
            ) : (
              <p className="muted-text">Презентация не загружена.</p>
            )}

            {otherFiles.length > 0 ? (
              <FileList accessToken={accessToken} files={otherFiles} title="Другие файлы" />
            ) : (
              <p className="muted-text">Дополнительные файлы не загружены.</p>
            )}
          </section>

          <section className="detail-section" aria-labelledby="object-location-title">
            <div>
              <p className="eyebrow">Район</p>
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
          </section>
        </aside>
      </div>
    </div>
  );
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
  const [activeIndex, setActiveIndex] = useState(0);
  const activeImage = images[activeIndex] ?? null;
  const hasManyImages = images.length > 1;

  useEffect(() => {
    if (activeIndex > Math.max(images.length - 1, 0)) {
      setActiveIndex(0);
    }
  }, [activeIndex, images.length]);

  function showPreviousImage() {
    setActiveIndex((currentIndex) => (currentIndex === 0 ? images.length - 1 : currentIndex - 1));
  }

  function showNextImage() {
    setActiveIndex((currentIndex) => (currentIndex + 1) % images.length);
  }

  if (!activeImage) {
    return (
      <div className="object-image-carousel object-image-carousel--empty">
        <span>Фотографии пока не загружены</span>
      </div>
    );
  }

  return (
    <section className="object-image-carousel" aria-label="Галерея объекта">
      <div className="object-carousel-media">
        <SecureImage accessToken={accessToken} alt={activeImage.alt ?? objectTitle} fileId={activeImage.file.id} />

        {hasManyImages ? (
          <>
            <button
              aria-label="Предыдущее фото"
              className="carousel-button carousel-button--previous"
              type="button"
              onClick={showPreviousImage}
            >
              ‹
            </button>
            <button
              aria-label="Следующее фото"
              className="carousel-button carousel-button--next"
              type="button"
              onClick={showNextImage}
            >
              ›
            </button>
            <span className="carousel-counter">
              {activeIndex + 1} / {images.length}
            </span>
          </>
        ) : null}
      </div>

      {hasManyImages ? (
        <div className="carousel-thumbnails" aria-label="Миниатюры галереи">
          {images.map((image, index) => (
            <button
              key={image.id}
              aria-label={`Фото ${index + 1}`}
              className={index === activeIndex ? 'carousel-thumbnail carousel-thumbnail--active' : 'carousel-thumbnail'}
              type="button"
              onClick={() => setActiveIndex(index)}
            >
              <SecureImage accessToken={accessToken} alt={image.alt ?? `${objectTitle}, миниатюра ${index + 1}`} fileId={image.file.id} />
            </button>
          ))}
        </div>
      ) : null}
    </section>
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
        {files.map((file) => (
          <li key={file.id}>
            <div>
              <strong>{file.title || file.file.originalName || fileTypeLabels[file.type]}</strong>
              <span>
                {fileTypeLabels[file.type]}
                {file.file.sizeBytes ? `, ${formatFileSize(file.file.sizeBytes)}` : ''}
              </span>
            </div>
            <SecureFileButton accessToken={accessToken} fileId={file.file.id} />
          </li>
        ))}
      </ul>
    </div>
  );
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

function SecureImage({ accessToken, alt, fileId }: { accessToken: string; alt: string; fileId: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let isCancelled = false;

    async function loadImage() {
      setSrc(null);
      setHasError(false);

      try {
        const response = await fetch(`${apiUrl}/files/${fileId}/content`, {
          credentials: 'include',
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });

        if (!response.ok) {
          throw new Error('Image request failed');
        }

        const blob = await response.blob();

        if (isCancelled) {
          return;
        }

        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      } catch {
        if (!isCancelled) {
          setHasError(true);
        }
      }
    }

    void loadImage();

    return () => {
      isCancelled = true;

      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [accessToken, fileId]);

  if (hasError) {
    return <span>Изображение недоступно</span>;
  }

  if (!src) {
    return <span>Загрузка изображения</span>;
  }

  return <img alt={alt} src={src} />;
}

function useSecureImageObjectUrl(accessToken: string, fileId: string | null) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let isCancelled = false;

    setSrc(null);

    const imageFileId = fileId ?? '';

    if (!imageFileId) {
      return () => undefined;
    }

    async function loadImage() {
      const nextObjectUrl = await fetchFileObjectUrl(accessToken, imageFileId).catch(() => null);

      if (!nextObjectUrl) {
        return;
      }

      if (isCancelled) {
        URL.revokeObjectURL(nextObjectUrl);
        return;
      }

      objectUrl = nextObjectUrl;
      setSrc(nextObjectUrl);
    }

    void loadImage();

    return () => {
      isCancelled = true;

      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [accessToken, fileId]);

  return src;
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

function SecureFileButton({ accessToken, fileId }: { accessToken: string; fileId: string }) {
  const [isOpening, setIsOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleOpen() {
    setIsOpening(true);
    setError(null);

    try {
      const response = await fetch(`${apiUrl}/files/${fileId}/content`, {
        credentials: 'include',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        throw new Error('File request failed');
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);

      window.open(objectUrl, '_blank', 'noopener,noreferrer');
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    } catch {
      setError('Файл недоступен');
    } finally {
      setIsOpening(false);
    }
  }

  return (
    <div className="detail-file-action">
      <button className="text-button" disabled={isOpening} type="button" onClick={() => void handleOpen()}>
        {isOpening ? 'Открываем' : 'Открыть'}
      </button>
      {error ? <span>{error}</span> : null}
    </div>
  );
}

function getDescriptionParagraphs(object: RealEstateObjectDetail) {
  const featureTextSections = Array.isArray(object.featuresJson.textSections)
    ? object.featuresJson.textSections.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const sourceText = object.description || object.shortDescription || featureTextSections.join('\n\n');

  return sourceText
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

function getObjectMapPoints(object: RealEstateObjectDetail, imageUrl: string | null): YandexMapPoint[] {
  if (object.latitude === null || object.longitude === null) {
    return [];
  }

  return [
    {
      id: object.id,
      title: object.title,
      hint: object.title,
      coordinates: [object.latitude, object.longitude],
      balloonHtml: buildObjectMapBalloon(object, imageUrl),
      markerLabel: formatObjectMapMarkerPrice(object.pricePerMeterFrom),
    },
  ];
}

function buildObjectMapBalloon(object: RealEstateObjectDetail, imageUrl: string | null) {
  const title = escapeHtml(object.title);
  const location = escapeHtml(getObjectDistrictLocation(object)?.name ?? 'Район не указан');
  const address = object.address ? escapeHtml(object.address) : null;
  const developer = escapeHtml(object.developer?.name ?? 'Застройщик не указан');
  const price = escapeHtml(formatPrice(object.priceFrom));
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

function getLocationRows(object: RealEstateObjectDetail): FeatureRow[] {
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

function getObjectDistrictLocation(object: RealEstateObjectDetail): DisplayLocation | null {
  if (object.primaryLocation?.type === 'DISTRICT') {
    return object.primaryLocation;
  }

  return object.locations.find((location) => location.type === 'DISTRICT') ?? null;
}

function getObjectAreaLocations(object: RealEstateObjectDetail): DisplayLocation[] {
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

function formatObjectMapMarkerPrice(value: string | null) {
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

function formatCompactRussianNumber(value: number) {
  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: value < 10 ? 1 : 0,
  }).format(value);
}

function formatCompletion(year: number | null, quarter: number | null) {
  if (!year) {
    return 'Не указан';
  }

  return quarter ? `${quarter} кв. ${year}` : String(year);
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
