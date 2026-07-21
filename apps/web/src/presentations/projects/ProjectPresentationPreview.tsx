import { useEffect, useMemo, useState } from 'react';
import { ChevronLeftIcon, ChevronRightIcon, MessageCircleIcon } from 'lucide-react';
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
  | { key: 'contents'; label: 'Содержание'; kind: 'contents' }
  | { key: string; label: string; kind: 'project'; item: ProjectPresentationDraftObject; number: number }
  | { key: 'telegram'; label: 'Telegram'; kind: 'telegram' }
  | { key: 'contacts'; label: 'Контакты'; kind: 'contacts' };

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
      { key: 'contents', label: 'Содержание', kind: 'contents' },
      ...form.objects.map((item, index) => ({
        key: item.objectId,
        label: item.manualTitle || item.object.title,
        kind: 'project' as const,
        item,
        number: index + 1,
      })),
      { key: 'telegram', label: 'Telegram', kind: 'telegram' },
      { key: 'contacts', label: 'Контакты', kind: 'contacts' },
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

  return (
    <section className={compact ? 'project-preview project-preview--compact' : 'project-preview'}>
      <div className="project-preview-toolbar">
        <div>
          <strong>{activePage.label}</strong>
          <span>{safePageIndex + 1} / {pages.length}</span>
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
        {activePage.kind === 'cover' ? <CoverPage accessToken={accessToken} form={form} /> : null}
        {activePage.kind === 'contents' ? <ContentsPage form={form} /> : null}
        {activePage.kind === 'project' ? (
          <ProjectPage accessToken={accessToken} item={activePage.item} number={activePage.number} />
        ) : null}
        {activePage.kind === 'telegram' ? <TelegramPage /> : null}
        {activePage.kind === 'contacts' ? <ContactsPage clientName={form.clientName} user={user} /> : null}
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

function CoverPage({ accessToken, form }: { accessToken: string; form: ProjectPresentationDraftForm }) {
  const coverImage = findProjectImage(form.objects, form.coverImageId);
  const coverFileId = form.coverFile?.id ?? coverImage?.file.id ?? null;

  return (
    <article className="project-preview-page project-preview-cover">
      {coverFileId ? (
        <SecureImage
          accessToken={accessToken}
          alt=""
          fileId={coverFileId}
          variant="detail"
        />
      ) : <div className="project-preview-image-placeholder" />}
      <div className="project-preview-cover-shade" />
      <div className="project-preview-brand">FLUFFY WHITE</div>
      <div className="project-preview-cover-copy">
        <p>{form.issueLabel || 'Персональная подборка'}</p>
        <h3>{form.coverTitle || 'Презентация жилых комплексов'}</h3>
        <span>{form.coverSubtitle || 'Москва · недвижимость для жизни'}</span>
      </div>
      <small>{form.clientName ? `Подготовлено для ${form.clientName}` : 'Подготовлено специально для вас'}</small>
    </article>
  );
}

function ContentsPage({ form }: { form: ProjectPresentationDraftForm }) {
  return (
    <article className="project-preview-page project-preview-contents">
      <PageBrand />
      <p className="project-preview-kicker">Навигация</p>
      <h3>Содержание</h3>
      <ol>
        {form.objects.length ? form.objects.map((item, index) => (
          <li key={item.objectId}>
            <span>{String(index + 1).padStart(2, '0')}</span>
            <strong>{item.manualTitle || item.object.title}</strong>
          </li>
        )) : (
          <li><span>01</span><strong>Добавьте жилые комплексы</strong></li>
        )}
      </ol>
      <div className="project-preview-page-number">02</div>
    </article>
  );
}

function ProjectPage({
  accessToken,
  item,
  number,
}: {
  accessToken: string;
  item: ProjectPresentationDraftObject;
  number: number;
}) {
  const images = item.imageIds
    .map((imageId) => item.object.images.find((image) => image.id === imageId))
    .filter((image): image is NonNullable<typeof image> => Boolean(image));
  const facts = [item.propertyClass, item.completion, item.price, item.district, item.developer, item.metro].filter(Boolean);

  return (
    <article className="project-preview-page project-preview-project">
      <PageBrand />
      <div className="project-preview-project-number">{String(number).padStart(2, '0')}</div>
      <p className="project-preview-kicker">Жилой комплекс</p>
      <h3>{item.manualTitle || item.object.title}</h3>
      <div className="project-preview-project-facts">
        {facts.slice(0, 6).map((fact, index) => <span key={`${fact}-${index}`}>{fact}</span>)}
      </div>
      <p className="project-preview-description">
        {item.manualDescription ?? item.object.description ?? 'Добавьте краткое описание проекта — оно появится на этой странице.'}
      </p>
      {item.advantages.some(Boolean) ? (
        <ul className="project-preview-advantages">
          {item.advantages.filter(Boolean).map((advantage, index) => <li key={`${advantage}-${index}`}>{advantage}</li>)}
        </ul>
      ) : null}
      <div className={`project-preview-gallery project-preview-gallery--${Math.min(images.length, 3)}`}>
        {images.length ? images.map((image) => (
          <SecureImage
            accessToken={accessToken}
            alt={image.alt || item.manualTitle || item.object.title}
            fileId={image.file.id}
            key={image.id}
            lazy
            variant="detail"
          />
        )) : <div className="project-preview-image-placeholder">Выберите до 3 фото</div>}
      </div>
      <div className="project-preview-page-number">{String(number + 2).padStart(2, '0')}</div>
    </article>
  );
}

function TelegramPage() {
  return (
    <article className="project-preview-page project-preview-promo">
      <PageBrand />
      <MessageCircleIcon aria-hidden="true" />
      <p className="project-preview-kicker">Всегда на связи</p>
      <h3>Новые объекты и аналитика в Telegram</h3>
      <p>Свежие подборки, редкие лоты и новости рынка — коротко и по делу.</p>
      <span className="project-preview-promo-button">Открыть канал</span>
    </article>
  );
}

function ContactsPage({
  clientName,
  user,
}: {
  clientName: string;
  user: Pick<AuthUser, 'brokerEmail' | 'brokerPhone' | 'email' | 'name'>;
}) {
  return (
    <article className="project-preview-page project-preview-contacts">
      <PageBrand />
      <p className="project-preview-kicker">Следующий шаг</p>
      <h3>{clientName ? `${clientName}, обсудим детали?` : 'Обсудим детали?'}</h3>
      <p>Подберём подходящие планировки, проверим условия сделки и организуем просмотры.</p>
      <div className="project-preview-broker-card">
        <strong>{user.name || 'Ваш брокер Fluffy White'}</strong>
        <span>{user.brokerPhone || 'Телефон в профиле не указан'}</span>
        <span>{user.brokerEmail || user.email}</span>
        <span>@FluffyWhite</span>
      </div>
      <strong className="project-preview-contacts-brand">FLUFFY WHITE</strong>
    </article>
  );
}

function PageBrand() {
  return <div className="project-preview-brand">FLUFFY WHITE</div>;
}
