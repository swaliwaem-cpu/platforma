import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { PencilIcon } from 'lucide-react';
import type {
  ObjectFileType,
  ObjectImageSection,
  ObjectLinkedFile,
  ObjectMetroStationLink,
  ObjectResponse,
  RealEstateObjectDetail,
} from '@platforma/shared';

import { apiRequest } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';
import { getLinkedFileTitle } from '../files/fileDisplay';
import { SecureImage, buildMediaFileContentUrl, useSecureImageObjectUrl } from '../files/SecureImage';
import { YandexMap, type YandexMapPoint } from '../map/YandexMap';
import {
  formatCompletion,
  formatPrice,
  getLocationRows,
  getObjectContentSections,
  getObjectDistrictLocation,
  getObjectLocationLine,
  getObjectParameterRows,
} from './objectDetailViewModel';

type ObjectDetailPageProps = {
  slug: string;
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

const sectionOptions: {
  value: ObjectImageSection;
  label: string;
}[] = [
  { value: 'ARCHITECTURE', label: 'Архитектура' },
  { value: 'INTERIORS', label: 'Интерьеры' },
  { value: 'FILLING', label: 'Наполнение' },
];

export function ObjectDetailPage({ slug, onBack }: ObjectDetailPageProps) {
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
      object={object}
      onBack={onBack}
    />
  );
}

function ObjectDetail({
  accessToken,
  canEditObject,
  object,
  onBack,
}: {
  accessToken: string;
  canEditObject: boolean;
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
  const carouselImages = useMemo(() => getCarouselImages(object), [object]);
  const { src: mapBalloonImageUrl } = useSecureImageObjectUrl({
    accessToken,
    fileId: carouselImages[0]?.file.id ?? null,
    variant: 'card',
  });
  const mapPoints = useMemo(() => getObjectMapPoints(object, mapBalloonImageUrl), [mapBalloonImageUrl, object]);
  const editObjectPath = `/admin/objects/${object.id}/edit`;

  return (
    <div className="object-detail-page">
      <header className="page-header object-detail-header">
        <div>
          <button className="text-button" type="button" onClick={onBack}>
            Вернуться к каталогу
          </button>
          <h2>{object.title}</h2>
          <p className="object-detail-location-line">{locationLine.line}</p>
        </div>
        {object.status !== 'PUBLISHED' || canEditObject ? (
          <div className="object-detail-header-actions">
            {object.status === 'PUBLISHED' ? null : (
              <span className={`status-pill object-status object-status--${object.status.toLowerCase()}`}>
                {objectStatusLabels[object.status]}
              </span>
            )}
            {canEditObject ? (
              <a className="object-detail-edit-link" href={editObjectPath}>
                <PencilIcon aria-hidden="true" />
                Редактировать
              </a>
            ) : null}
          </div>
        ) : null}
      </header>

      <ObjectImageCarousel accessToken={accessToken} images={carouselImages} objectTitle={object.title} />

      <div className="object-parameters-files-grid">
        <section className="detail-section object-parameters-section" aria-labelledby="object-parameters-title">
          <div>
            <h3 id="object-parameters-title">Основные параметры</h3>
          </div>

          <dl className="object-parameters-grid">
            {parameterRows.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="detail-section object-files-section" aria-labelledby="object-files-title">
          <div>
            <h3 id="object-files-title">Файлы и документы</h3>
          </div>

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

          {listedFiles.length > 0 ? (
            <FileList accessToken={accessToken} files={listedFiles} title="Дополнительные файлы" />
          ) : (
            <div className="detail-file-group object-files-additional">
              <h4>Дополнительные файлы</h4>
              <p className="muted-text object-files-empty">Не загружены.</p>
            </div>
          )}
        </section>
      </div>

      <section className="detail-section object-map-section" aria-labelledby="object-map-title">
        <div>
          <p className="eyebrow">Карта</p>
          <h3 id="object-map-title">Локация и расположение</h3>
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

      <div className="object-description-location-grid">
        <section className="detail-section object-description-section" aria-labelledby="object-description-title">
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

        <section className="detail-section object-location-section" aria-labelledby="object-location-title">
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
  const hasSectionFilters = images.some((image) => image.section !== null);

  useEffect(() => {
    if (activeIndex > Math.max(filteredImages.length - 1, 0)) {
      setActiveIndex(0);
    }

    if (lightboxIndex !== null && lightboxIndex > Math.max(filteredImages.length - 1, 0)) {
      setLightboxIndex(null);
    }
  }, [activeIndex, filteredImages.length, lightboxIndex]);

  function showPreviousImage() {
    setActiveIndex((currentIndex) => (currentIndex === 0 ? filteredImages.length - 1 : currentIndex - 1));
  }

  function showNextImage() {
    setActiveIndex((currentIndex) => (currentIndex + 1) % filteredImages.length);
  }

  function toggleSectionFilter(section: ObjectImageSection) {
    setActiveSection((currentSection) => (currentSection === section ? null : section));
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
    }

    window.addEventListener('keydown', handleKeyDown);

    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [lightboxIndex]);

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
        <button
          aria-label="Открыть фото в полном размере"
          className="object-carousel-media-button"
          type="button"
          onClick={openLightbox}
        >
          <SecureImage
            accessToken={accessToken}
            alt={activeImage.alt ?? objectTitle}
            className="object-carousel-image"
            fileId={activeImage.file.id}
            variant="detail"
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
              {activeIndex + 1} / {filteredImages.length}
            </span>
          </>
        ) : null}
      </div>

      {hasManyImages || hasSectionFilters ? (
        <div className="carousel-thumbnail-zone">
          {hasSectionFilters ? (
            <div className="carousel-section-filters" aria-label="Разделы галереи">
              {sectionOptions.map((option) => {
                const sectionImageCount = images.filter((image) => image.section === option.value).length;
                const sectionButtonClassName =
                  activeSection === option.value
                    ? 'carousel-section-filter carousel-section-filter--active'
                    : 'carousel-section-filter';

                return (
                  <button
                    key={option.value}
                    className={sectionButtonClassName}
                    disabled={sectionImageCount === 0}
                    type="button"
                    onClick={() => toggleSectionFilter(option.value)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          ) : null}

          {hasManyImages ? (
            <div className="carousel-thumbnails" aria-label="Миниатюры галереи">
              {filteredImages.map((image, index) => (
                <button
                  key={image.id}
                  aria-label={`Фото ${index + 1}`}
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
          ) : null}
        </div>
      ) : null}

      {lightboxImage ? (
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
                variant="detail"
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

function formatObjectMapMarkerPrice(value: string | null) {
  if (!value) {
    return 'по запросу';
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return `от ${value}`;
  }

  return `от ${formatCompactRussianNumber(parsed / 1000)}т`;
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
