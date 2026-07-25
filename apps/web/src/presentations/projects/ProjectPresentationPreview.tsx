import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import type { AuthUser } from '@platforma/shared';

import { Button } from '../../components/ui/button';
import { SecureImage } from '../../files/SecureImage';
import { findProjectImage } from './projectPresentationState';
import type {
  ProjectPresentationDraftForm,
  ProjectPresentationDraftObject,
} from './projectPresentationTypes';

type ProjectPresentationPreviewProps = {
  accessToken: string;
  form: ProjectPresentationDraftForm;
  compact?: boolean;
  preferredPageKey?: string | null;
  user: Pick<AuthUser, 'brokerEmail' | 'brokerPhone' | 'email' | 'name'>;
};

type PreviewPage =
  | { key: 'cover'; label: 'Обложка'; kind: 'cover' }
  | { key: 'map'; label: 'География'; kind: 'map' }
  | { key: string; label: string; kind: 'project'; item: ProjectPresentationDraftObject; number: number }
  | { key: 'company'; label: 'О компании'; kind: 'company' }
  | { key: 'final'; label: 'Финал'; kind: 'final' };

export function ProjectPresentationPreview({
  accessToken,
  compact = false,
  form,
  preferredPageKey = null,
  user,
}: ProjectPresentationPreviewProps) {
  const pages = useMemo<PreviewPage[]>(
    () => [
      { key: 'cover', label: 'Обложка', kind: 'cover' },
      { key: 'map', label: 'География', kind: 'map' },
      ...form.objects.map((item, index) => ({
        key: item.objectId,
        label: item.manualTitle || item.object.title,
        kind: 'project' as const,
        item,
        number: index + 1,
      })),
      { key: 'company', label: 'О компании', kind: 'company' },
      { key: 'final', label: 'Финал', kind: 'final' },
    ],
    [form.objects],
  );
  const [activePageIndex, setActivePageIndex] = useState(0);
  const safePageIndex = Math.min(activePageIndex, Math.max(pages.length - 1, 0));
  const activePage = pages[safePageIndex];

  useEffect(() => {
    if (!preferredPageKey) {
      return;
    }

    const preferredIndex = pages.findIndex((page) => page.key === preferredPageKey);

    if (preferredIndex >= 0) {
      setActivePageIndex(preferredIndex);
    }
  }, [pages, preferredPageKey]);

  if (!activePage) {
    return null;
  }

  const pageNumber = safePageIndex + 1;

  return (
    <section className={compact ? 'project-preview project-preview--compact' : 'project-preview'}>
      <div className="project-preview-toolbar">
        <div>
          <strong>{activePage.label}</strong>
          <span>{pageNumber} / {pages.length}</span>
        </div>
        <div>
          <Button
            aria-label="Предыдущая страница"
            disabled={safePageIndex === 0}
            size="icon-sm"
            type="button"
            variant="outline"
            onClick={() => setActivePageIndex((index) => Math.max(0, index - 1))}
          >
            <ChevronLeftIcon aria-hidden="true" />
          </Button>
          <Button
            aria-label="Следующая страница"
            disabled={safePageIndex === pages.length - 1}
            size="icon-sm"
            type="button"
            variant="outline"
            onClick={() => setActivePageIndex((index) => Math.min(pages.length - 1, index + 1))}
          >
            <ChevronRightIcon aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div className="project-preview-frame" aria-live="polite">
        {activePage.kind === 'cover' ? (
          <CoverPage accessToken={accessToken} form={form} pageNumber={pageNumber} totalPages={pages.length} />
        ) : null}
        {activePage.kind === 'map' ? (
          <EditorialMapPage form={form} pageNumber={pageNumber} totalPages={pages.length} />
        ) : null}
        {activePage.kind === 'project' ? (
          <ProjectPage
            accessToken={accessToken}
            issueLabel={form.issueLabel}
            item={activePage.item}
            number={activePage.number}
            pageNumber={pageNumber}
            totalPages={pages.length}
          />
        ) : null}
        {activePage.kind === 'company' ? (
          <CompanyPage issueLabel={form.issueLabel} pageNumber={pageNumber} totalPages={pages.length} />
        ) : null}
        {activePage.kind === 'final' ? (
          <FinalPage
            issueLabel={form.issueLabel}
            pageNumber={pageNumber}
            totalPages={pages.length}
            user={user}
          />
        ) : null}
      </div>

      <div className="project-preview-pages" aria-label="Страницы презентации">
        {pages.map((page, index) => (
          <button
            aria-current={index === safePageIndex ? 'page' : undefined}
            className={index === safePageIndex ? 'is-active' : ''}
            key={page.key}
            title={page.label}
            type="button"
            onClick={() => setActivePageIndex(index)}
          >
            <span>{String(index + 1).padStart(2, '0')}</span>
            {page.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function CoverPage({
  accessToken,
  form,
  pageNumber,
  totalPages,
}: {
  accessToken: string;
  form: ProjectPresentationDraftForm;
  pageNumber: number;
  totalPages: number;
}) {
  const coverImage = findProjectImage(form.objects, form.coverImageId);
  const coverFileId = form.coverFile?.id ?? coverImage?.file.id ?? null;
  const teasers = ['Старты\nпродаж', 'Преимущества', 'Локации\nи цифры', 'Условия\nпокупки'];

  return (
    <article className="project-preview-page project-preview-cover">
      <PageHeader issueLabel={form.issueLabel} />
      <p className="project-preview-kicker project-preview-kicker--center">Каталог проектов Москвы</p>
      <h3>{form.coverTitle || 'Лучшие проекты Москвы'}</h3>
      <div className="project-preview-cover-image">
        {coverFileId ? (
          <SecureImage accessToken={accessToken} alt="" fileId={coverFileId} variant="detail" />
        ) : <div className="project-preview-image-placeholder">Фото обложки</div>}
      </div>
      <h4>{form.coverSubtitle || 'Проекты для жизни'}</h4>
      <div className="project-preview-teasers">
        {teasers.map((teaser) => (
          <div key={teaser}>
            <GoldStar />
            <strong>{teaser}</strong>
          </div>
        ))}
      </div>
      {form.clientName ? <small>Подготовлено для {form.clientName}</small> : null}
      <PageFooter label="Вариант A · Обложка" pageNumber={pageNumber} totalPages={totalPages} />
    </article>
  );
}

function EditorialMapPage({
  form,
  pageNumber,
  totalPages,
}: {
  form: ProjectPresentationDraftForm;
  pageNumber: number;
  totalPages: number;
}) {
  const points = getMapPoints(form.objects);

  return (
    <article className="project-preview-page project-preview-map">
      <PageHeader issueLabel={form.issueLabel} />
      <p className="project-preview-kicker">Почему эти проекты</p>
      <h3>Москва, в которой<br />хочется жить</h3>
      <p className="project-preview-lead">
        Мы собрали проекты, где архитектура, зелёные маршруты и ежедневная инфраструктура работают вместе.
        Карта показывает подборку как единый городской сценарий.
      </p>
      <div className="project-preview-map-grid">
        {points.map((point, index) => (
          <div
            className="project-preview-map-point"
            key={point.item.objectId}
            style={{ '--point-x': `${point.x}%`, '--point-y': `${point.y}%` } as CSSProperties}
          >
            <span>{index + 1}</span>
            {index < 4 ? <strong>{point.item.manualTitle || point.item.object.title}</strong> : null}
          </div>
        ))}
      </div>
      <ol className="project-preview-map-legend">
        {form.objects.slice(0, 6).map((item, index) => (
          <li key={item.objectId}><span>{String(index + 1).padStart(2, '0')}</span>{item.manualTitle || item.object.title}</li>
        ))}
      </ol>
      <PageFooter label="Вариант A · География подборки" pageNumber={pageNumber} totalPages={totalPages} />
    </article>
  );
}

function ProjectPage({
  accessToken,
  issueLabel,
  item,
  number,
  pageNumber,
  totalPages,
}: {
  accessToken: string;
  issueLabel: string;
  item: ProjectPresentationDraftObject;
  number: number;
  pageNumber: number;
  totalPages: number;
}) {
  const selectedImageIds = item.imageIds.length
    ? item.imageIds
    : item.object.images.slice(0, 3).map((image) => image.id);
  const images = selectedImageIds
    .map((imageId) => item.object.images.find((image) => image.id === imageId))
    .filter((image): image is NonNullable<typeof image> => Boolean(image));
  const facts = [
    ['Цена от', item.price || formatPrice(item.object.priceFrom)],
    ['Локация', item.district || item.object.primaryLocation?.name || 'Не указана'],
    ['Класс', item.propertyClass || item.object.propertyClass || 'Не указан'],
    ['Метро', item.metro || item.object.metroStations.map((link) => link.name).join(', ') || 'Не указано'],
  ];
  const advantages = item.advantages.filter(Boolean).slice(0, 4);
  const defaults = ['Старт продаж', 'Специальные условия', 'Продуманная среда', 'Рядом с центром'];
  while (advantages.length < 4) advantages.push(defaults[advantages.length] ?? 'Преимущество');

  return (
    <article className="project-preview-page project-preview-project">
      <PageHeader issueLabel={issueLabel} />
      <h3>{item.manualTitle || item.object.title}</h3>
      <div className="project-preview-project-main">
        {images[0] ? (
          <SecureImage
            accessToken={accessToken}
            alt={images[0].alt || item.manualTitle || item.object.title}
            fileId={images[0].file.id}
            variant="detail"
          />
        ) : <div className="project-preview-image-placeholder">Главное фото ЖК</div>}
      </div>
      <div className="project-preview-project-facts">
        {facts.map(([label, value]) => (
          <div key={label}><span>{label}</span><strong>{value}</strong></div>
        ))}
      </div>
      <div className="project-preview-project-details">
        {[images[1], images[2]].map((image, index) => image ? (
          <SecureImage
            accessToken={accessToken}
            alt={image.alt || item.manualTitle || item.object.title}
            fileId={image.file.id}
            key={image.id}
            lazy
            variant="detail"
          />
        ) : <div className="project-preview-image-placeholder" key={`placeholder-${index}`}>{index === 0 ? 'Деталь проекта' : 'Территория'}</div>)}
      </div>
      <p className="project-preview-description">
        {item.manualDescription ?? item.object.description ?? 'Добавьте краткое описание проекта — оно появится на этой странице.'}
      </p>
      <span className="project-preview-details-link">Узнать подробности <span aria-hidden="true">→</span></span>
      <div className="project-preview-advantages">
        {advantages.map((advantage, index) => (
          <div key={`${advantage}-${index}`}><GoldStar /><strong>{advantage}</strong></div>
        ))}
      </div>
      <PageFooter label={`Вариант A · Карточка ЖК ${String(number).padStart(2, '0')}`} pageNumber={pageNumber} totalPages={totalPages} />
    </article>
  );
}

function CompanyPage({
  issueLabel,
  pageNumber,
  totalPages,
}: {
  issueLabel: string;
  pageNumber: number;
  totalPages: number;
}) {
  const services = [
    ['Полное сопровождение', 'Сопровождаем сделку и документы от первого шага. Остаёмся на связи до получения ключей.'],
    ['Специальные условия', 'Знаем акции и закрытые предложения. Ведём переговоры и добиваемся дополнительной выгоды.'],
    ['Честный подход', 'Открыто говорим о плюсах, минусах и рисках, чтобы выбор был объективным.'],
    ['Независимый анализ', 'Сравниваем рынок и выбираем лучший вариант для вас.'],
  ];

  return (
    <article className="project-preview-page project-preview-company">
      <PageHeader issueLabel={issueLabel} />
      <p className="project-preview-kicker">О компании</p>
      <div className="project-preview-company-statement">
        <div>
          <strong>Наша главная цель —<br />найти вам</strong>
          <em>лучший объект,</em>
          <strong>а не продать то,<br />что есть в наличии</strong>
        </div>
        <div className="project-preview-company-logo">
          <img alt="" aria-hidden="true" src="/fluffywhite-logo-gold.png" />
          <strong>FluffyWhite</strong>
        </div>
      </div>
      <div className="project-preview-company-services">
        {services.map(([title, description]) => (
          <div key={title}>
            <GoldStar />
            <strong>{title}</strong>
            <p>{description}</p>
          </div>
        ))}
      </div>
      <p className="project-preview-kicker project-preview-kicker--center">А главное</p>
      <h3>Бесплатно для вас</h3>
      <PageFooter label="Вариант A · О компании" pageNumber={pageNumber} totalPages={totalPages} />
    </article>
  );
}

function FinalPage({
  issueLabel,
  pageNumber,
  totalPages,
  user,
}: {
  issueLabel: string;
  pageNumber: number;
  totalPages: number;
  user: Pick<AuthUser, 'brokerEmail' | 'brokerPhone' | 'email' | 'name'>;
}) {
  const steps = [
    'Подбор вариантов жилых комплексов по вашим параметрам',
    'Проведение показов непосредственно на стройке',
    'Анализ конкурентов и альтернатив',
    'Бронирование и заключение договора с застройщиком',
    'Регистрация прав на вашу квартиру',
  ];

  return (
    <article className="project-preview-page project-preview-final">
      <PageHeader issueLabel={issueLabel} />
      <p className="project-preview-kicker project-preview-kicker--center">С нами вы пройдёте</p>
      <h3>Весь путь:</h3>
      <GoldStar />
      <p className="project-preview-final-lead">{steps[0]}</p>
      <div className="project-preview-final-steps">
        {steps.slice(1).map((step) => <div key={step}><GoldStar /><span>{step}</span></div>)}
      </div>
      <GoldStar />
      <p className="project-preview-final-statement">
        С FluffyWhite вы не просто покупаете квартиру.<br />
        Вы получаете уверенность, спокойствие и опору.
      </p>
      <span className="project-preview-details-link">Начать подбор <span aria-hidden="true">→</span></span>
      <div className="project-preview-final-contacts">
        <span>Telegram</span>
        <span>Instagram</span>
        <span>YouTube</span>
        <strong>{user.brokerPhone || '+7 (495) 492-48-58'}</strong>
      </div>
      <PageFooter label="Вариант A · Финал" pageNumber={pageNumber} totalPages={totalPages} />
    </article>
  );
}

function PageHeader({ issueLabel }: { issueLabel: string }) {
  return (
    <div className="project-preview-page-header">
      <span />
      <div><img alt="" aria-hidden="true" src="/fluffywhite-logo-gold.png" /><strong>FluffyWhite</strong></div>
      <span />
      <small>{issueLabel || 'Каталог проектов'}</small>
    </div>
  );
}

function PageFooter({
  label,
  pageNumber,
  totalPages,
}: {
  label: string;
  pageNumber: number;
  totalPages: number;
}) {
  return (
    <div className="project-preview-page-footer">
      <span>{label}</span>
      <span>{String(pageNumber).padStart(2, '0')} / {String(totalPages).padStart(2, '0')}</span>
    </div>
  );
}

function GoldStar() {
  return <span className="project-preview-gold-star" aria-hidden="true">✦</span>;
}

function formatPrice(value: string | null) {
  if (!value) {
    return 'По запросу';
  }
  const number = Number(value);
  return Number.isFinite(number)
    ? `от ${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(number)} ₽`
    : value;
}

function getMapPoints(items: ProjectPresentationDraftObject[]) {
  const valid = items
    .filter((item) => item.object.latitude !== null && item.object.longitude !== null)
    .map((item) => ({ item, latitude: item.object.latitude!, longitude: item.object.longitude! }));
  const latitudes = valid.map((item) => item.latitude);
  const longitudes = valid.map((item) => item.longitude);
  const minLatitude = Math.min(...latitudes);
  const maxLatitude = Math.max(...latitudes);
  const minLongitude = Math.min(...longitudes);
  const maxLongitude = Math.max(...longitudes);
  const latitudeRange = Math.max(maxLatitude - minLatitude, 0.01);
  const longitudeRange = Math.max(maxLongitude - minLongitude, 0.01);
  const validById = new Map(valid.map((point) => [point.item.objectId, point]));

  return items.map((item, index) => {
    const point = validById.get(item.objectId);
    if (point) {
      return {
        item,
        x: 12 + ((point.longitude - minLongitude) / longitudeRange) * 76,
        y: 13 + (1 - (point.latitude - minLatitude) / latitudeRange) * 74,
      };
    }
    const angle = (index / Math.max(items.length, 1)) * Math.PI * 2 - Math.PI / 2;
    return {
      item,
      x: 50 + Math.cos(angle) * 32,
      y: 50 + Math.sin(angle) * 30,
    };
  });
}
