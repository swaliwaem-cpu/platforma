import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import type { AuthUser } from '@platforma/shared';
import {
  getProjectPresentationFallbackMarkers,
  PROJECT_PRESENTATION_LINKS,
  PROJECT_PRESENTATION_PAGE_SIZE,
  renderProjectPresentationHtml,
  type ProjectPresentationTemplateModel,
} from '@platforma/shared/project-presentation-template';
import interMediumUrl from '@platforma/shared/project-presentation-fonts/Inter-Medium.woff2?url';
import interRegularUrl from '@platforma/shared/project-presentation-fonts/Inter-Regular.woff2?url';
import involveMediumUrl from '@platforma/shared/project-presentation-fonts/Involve-Medium.woff2?url';
import involveRegularUrl from '@platforma/shared/project-presentation-fonts/Involve-Regular.woff2?url';
import loraItalicUrl from '@platforma/shared/project-presentation-fonts/Lora-Italic.woff2?url';

import { Button } from '../../components/ui/button';
import { buildMediaFileContentUrl } from '../../files/SecureImage';
import { useProjectPresentationMapSnapshot } from './projectPresentationMapSnapshot';
import { findProjectImage, formatProjectPrice, resolveProjectDescription } from './projectPresentationState';
import type { ProjectPresentationDraftForm } from './projectPresentationTypes';

type ProjectPresentationPreviewProps = {
  accessToken: string;
  form: ProjectPresentationDraftForm;
  compact?: boolean;
  preferredPageKey?: string | null;
  user: Pick<AuthUser, 'brokerEmail' | 'brokerPhone' | 'email' | 'name'>;
};

type PreviewPage = { key: string; label: string };

const fontUrls = {
  'Involve-Regular.woff2': involveRegularUrl,
  'Involve-Medium.woff2': involveMediumUrl,
  'Inter-Regular.woff2': interRegularUrl,
  'Inter-Medium.woff2': interMediumUrl,
  'Lora-Italic.woff2': loraItalicUrl,
};

// Renders the exact PDF template (packages/shared) page by page inside an iframe.
export function ProjectPresentationPreview({
  compact = false,
  form,
  preferredPageKey = null,
  user,
}: ProjectPresentationPreviewProps) {
  const pages = useMemo<PreviewPage[]>(
    () => [
      { key: 'cover', label: 'Обложка' },
      { key: 'map', label: 'География' },
      ...form.objects.map((item) => ({ key: item.objectId, label: item.manualTitle || item.object.title })),
      { key: 'company', label: 'О компании' },
      { key: 'final', label: 'Финал' },
    ],
    [form.objects],
  );
  const [activePageIndex, setActivePageIndex] = useState(0);
  const safePageIndex = Math.min(activePageIndex, Math.max(pages.length - 1, 0));
  const activePage = pages[safePageIndex];
  const locatedProjects = useMemo(
    () => form.objects.flatMap((item) => (
      item.object.latitude !== null && item.object.longitude !== null
        ? [{
          latitude: item.object.latitude,
          longitude: item.object.longitude,
          label: item.manualTitle || item.object.title,
        }]
        : []
    )),
    [form.objects],
  );
  const mapPoints = useMemo(
    () => locatedProjects.map(({ latitude, longitude }) => ({ latitude, longitude })),
    [locatedProjects],
  );
  const mapSnapshot = useProjectPresentationMapSnapshot(mapPoints);
  const deferredForm = useDeferredValue(form);
  const activePageKey = activePage?.key ?? 'cover';
  const html = useMemo(
    () => renderProjectPresentationHtml(
      createPreviewModel(deferredForm, mapSnapshot, locatedProjects),
      { fontUrls, pageKeys: [activePageKey] },
    ),
    [activePageKey, deferredForm, locatedProjects, mapSnapshot],
  );
  const { frameRef, scale } = usePageScale();

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

      <div
        aria-live="polite"
        className="project-preview-frame"
        ref={frameRef}
        style={{ '--project-preview-scale': scale } as CSSProperties}
      >
        <iframe
          className="project-preview-document"
          height={PROJECT_PRESENTATION_PAGE_SIZE.height}
          srcDoc={html}
          tabIndex={-1}
          title={`Страница ${pageNumber}: ${activePage.label}`}
          width={PROJECT_PRESENTATION_PAGE_SIZE.width}
        />
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

function createPreviewModel(
  form: ProjectPresentationDraftForm,
  mapSnapshot: ReturnType<typeof useProjectPresentationMapSnapshot>,
  locatedProjects: Array<{ latitude: number; longitude: number; label: string }>,
): ProjectPresentationTemplateModel {
  const coverImage = findProjectImage(form.objects, form.coverImageId);
  const coverFileId = form.coverFile?.id ?? coverImage?.file.id ?? null;
  // Snapshot markers come back in the order the points were projected, so the titles line up one by one.
  const markers = mapSnapshot
    ? mapSnapshot.markers.map((marker, index) => ({ ...marker, label: locatedProjects[index]?.label ?? '' }))
    : getProjectPresentationFallbackMarkers(locatedProjects);

  return {
    cover: {
      title: form.coverTitle || 'Заголовок обложки',
      subtitle: form.coverSubtitle,
      issueLabel: form.issueLabel,
      imageSrc: coverFileId ? buildMediaFileContentUrl(coverFileId, 'detail') : null,
      features: form.coverFeatures,
    },
    map: {
      title: form.mapTitle || 'Заголовок страницы с картой',
      imageSrc: mapSnapshot?.imageSrc ?? null,
      markers,
    },
    projects: form.objects.map((item) => ({
      key: item.objectId,
      title: item.manualTitle || item.object.title,
      description: resolveProjectDescription(item),
      price: item.price || formatProjectPrice(item.object.priceFrom) || 'По запросу',
      propertyClass: item.propertyClass || item.object.propertyClass || 'Не указан',
      metro: item.metro || item.object.metroStations[0]?.name || 'Не указано',
      advantages: item.advantages,
      imageSrcs: [0, 1, 2].map((slot) => {
        const image = item.object.images.find((candidate) => candidate.id === item.imageIds[slot]);
        return image ? buildMediaFileContentUrl(image.file.id, 'detail') : null;
      }),
    })),
    contacts: { ctaUrl: PROJECT_PRESENTATION_LINKS.chat },
  };
}

function usePageScale() {
  const frameRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);

  useEffect(() => {
    const frame = frameRef.current;

    if (!frame || typeof ResizeObserver === 'undefined') {
      return undefined;
    }

    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        setScale(entry.contentRect.width / PROJECT_PRESENTATION_PAGE_SIZE.width);
      }
    });
    observer.observe(frame);

    return () => observer.disconnect();
  }, []);

  return { frameRef, scale };
}
