import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeftIcon,
  DownloadIcon,
  FileClockIcon,
  FilePlus2Icon,
  PencilIcon,
  RefreshCwIcon,
  Trash2Icon,
} from 'lucide-react';

import { useAuth } from '../../auth/AuthProvider';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../../components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../../components/ui/empty';
import { Skeleton } from '../../components/ui/skeleton';
import {
  deleteProjectPresentationDocument,
  deleteProjectPresentationDraft,
  downloadProjectPresentationDocument,
  getProjectPresentationDocument,
  listProjectPresentationDocuments,
  listProjectPresentationDrafts,
  retryProjectPresentationDocument,
} from './projectPresentationApi';
import type {
  ProjectPresentationDocument,
  ProjectPresentationDraft,
} from './projectPresentationTypes';
import './projectPresentations.css';

type ProjectPresentationsPageProps = {
  navigate: (pathname: string) => void;
};

type DeleteTarget =
  | { kind: 'draft'; item: ProjectPresentationDraft }
  | { kind: 'document'; item: ProjectPresentationDocument };

const activeDocumentStatuses = new Set<ProjectPresentationDocument['status']>(['PENDING', 'RUNNING']);

export function ProjectPresentationsPage({ navigate }: ProjectPresentationsPageProps) {
  const { accessToken } = useAuth();
  const [activeTab, setActiveTab] = useState<'drafts' | 'documents'>('drafts');
  const [drafts, setDrafts] = useState<ProjectPresentationDraft[]>([]);
  const [documents, setDocuments] = useState<ProjectPresentationDocument[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const hasActiveDocuments = useMemo(
    () => documents.some((document) => activeDocumentStatuses.has(document.status)),
    [documents],
  );

  useEffect(() => {
    if (!accessToken) {
      return;
    }

    void loadData();
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken || !hasActiveDocuments) {
      return;
    }

    const timerId = window.setInterval(() => {
      void pollDocuments();
    }, 2000);

    return () => window.clearInterval(timerId);
  }, [accessToken, hasActiveDocuments]);

  async function loadData() {
    if (!accessToken) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const [draftsResponse, documentsResponse] = await Promise.all([
        listProjectPresentationDrafts(accessToken),
        listProjectPresentationDocuments(accessToken),
      ]);

      setDrafts(draftsResponse.items);
      setDocuments(documentsResponse.items);
    } catch (caughtError) {
      setError(resolveError(caughtError, 'Не удалось загрузить презентации ЖК'));
    } finally {
      setIsLoading(false);
    }
  }

  async function pollDocuments() {
    if (!accessToken) {
      return;
    }

    const activeDocuments = documents.filter((document) => activeDocumentStatuses.has(document.status));

    if (activeDocuments.length === 0) {
      return;
    }

    try {
      const responses = await Promise.all(
        activeDocuments.map((document) => getProjectPresentationDocument(accessToken, document.id)),
      );
      const updatedById = new Map(responses.map((response) => [response.document.id, response.document]));

      setDocuments((currentDocuments) =>
        currentDocuments.map((document) => updatedById.get(document.id) ?? document),
      );
    } catch {
      // История остается доступной; следующий polling повторит запрос.
    }
  }

  async function confirmDelete() {
    if (!accessToken || !deleteTarget || isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      if (deleteTarget.kind === 'draft') {
        await deleteProjectPresentationDraft(accessToken, deleteTarget.item.id);
        setDrafts((currentItems) => currentItems.filter((item) => item.id !== deleteTarget.item.id));
        setNotice('Черновик удалён');
      } else {
        await deleteProjectPresentationDocument(accessToken, deleteTarget.item.id);
        setDocuments((currentItems) => currentItems.filter((item) => item.id !== deleteTarget.item.id));
        setNotice('PDF удалён');
      }

      setDeleteTarget(null);
    } catch (caughtError) {
      setError(resolveError(caughtError, 'Не удалось удалить запись'));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function retryDocument(document: ProjectPresentationDocument) {
    if (!accessToken || isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const response = await retryProjectPresentationDocument(accessToken, document.id);

      setDocuments((currentItems) =>
        currentItems.map((item) => (item.id === document.id ? response.document : item)),
      );
    } catch (caughtError) {
      setError(resolveError(caughtError, 'Не удалось повторить генерацию'));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="project-presentations-page">
      <header className="page-header project-presentations-header">
        <div className="project-presentations-header-main">
          <h2>Презентации жилых комплексов</h2>
          <Button
            size="lg"
            type="button"
            onClick={() => navigate('/presentations/projects/new')}
          >
            <FilePlus2Icon data-icon="inline-start" aria-hidden="true" />
            Новая презентация
          </Button>
        </div>
        <div className="header-actions">
          <Button size="lg" type="button" variant="outline" onClick={() => navigate('/presentations')}>
            <ArrowLeftIcon data-icon="inline-start" aria-hidden="true" />
            Подборки лотов
          </Button>
        </div>
      </header>

      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {notice ? <p className="form-notice" aria-live="polite">{notice}</p> : null}

      <div className="project-presentations-tabs" role="tablist" aria-label="Презентации ЖК">
        <button
          aria-selected={activeTab === 'drafts'}
          className={activeTab === 'drafts' ? 'is-active' : ''}
          role="tab"
          type="button"
          onClick={() => setActiveTab('drafts')}
        >
          Черновики <Badge variant="secondary">{drafts.length}</Badge>
        </button>
        <button
          aria-selected={activeTab === 'documents'}
          className={activeTab === 'documents' ? 'is-active' : ''}
          role="tab"
          type="button"
          onClick={() => setActiveTab('documents')}
        >
          История PDF <Badge variant="secondary">{documents.length}</Badge>
        </button>
      </div>

      {isLoading ? <ProjectPresentationListSkeleton /> : null}

      {!isLoading && activeTab === 'drafts' ? (
        drafts.length > 0 ? (
          <div className="project-presentations-card-grid">
            {drafts.map((draft) => (
              <Card className="project-presentation-list-card" key={draft.id}>
                <CardHeader>
                  <div className="project-presentation-card-heading">
                  <Badge variant="outline">Черновик</Badge>
                    <span>{formatDateTime(draft.updatedAt)}</span>
                  </div>
                  <CardTitle>{draft.title}</CardTitle>
                  <CardDescription>{draft.owner?.name ?? draft.owner?.email ?? `Изменён ${formatDateTime(draft.updatedAt)}`}</CardDescription>
                </CardHeader>
                <CardContent>
                  <strong>{draft.objectsCount ?? draft.objects.length} из 12 ЖК</strong>
                  <span>Версия {draft.version}</span>
                </CardContent>
                <CardFooter>
                  <Button type="button" onClick={() => navigate(`/presentations/projects/${encodeURIComponent(draft.id)}`)}>
                    <PencilIcon data-icon="inline-start" aria-hidden="true" />
                    Продолжить
                  </Button>
                  <Button
                    aria-label={`Удалить черновик ${draft.title}`}
                    type="button"
                    variant="destructive"
                    onClick={() => setDeleteTarget({ kind: 'draft', item: draft })}
                  >
                    <Trash2Icon data-icon="inline-start" aria-hidden="true" />
                    Удалить
                  </Button>
                </CardFooter>
              </Card>
            ))}
          </div>
        ) : (
          <Empty className="content-panel project-presentations-empty">
            <EmptyHeader>
              <EmptyMedia variant="icon"><FilePlus2Icon aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>Черновиков пока нет</EmptyTitle>
              <EmptyDescription>Создайте презентацию и добавьте до 12 жилых комплексов.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button type="button" onClick={() => navigate('/presentations/projects/new')}>Создать презентацию</Button>
            </EmptyContent>
          </Empty>
        )
      ) : null}

      {!isLoading && activeTab === 'documents' ? (
        documents.length > 0 ? (
          <div className="project-presentations-documents content-panel">
            {documents.map((document) => (
              <article className="project-presentation-document-row" key={document.id}>
                <FileClockIcon aria-hidden="true" />
                <div>
                  <strong>{document.title}</strong>
                  <span>
                    {document.objectsCount} ЖК · {document.createdBy?.name ?? document.createdBy?.email ?? 'Автор не указан'} · {formatDateTime(document.createdAt)}
                  </span>
                  {document.errorMessage ? <small>{document.errorMessage}</small> : null}
                </div>
                <DocumentStatus document={document} />
                <div className="project-presentation-document-actions">
                  {document.canDownload ? (
                    <Button
                      aria-label={`Скачать ${document.title}`}
                      size="icon-lg"
                      title="Скачать PDF"
                      type="button"
                      variant="outline"
                      onClick={() => accessToken && void downloadProjectPresentationDocument(accessToken, document)}
                    >
                      <DownloadIcon aria-hidden="true" />
                    </Button>
                  ) : null}
                  {document.status === 'FAILED' ? (
                    <Button
                      aria-label={`Повторить генерацию ${document.title}`}
                      size="icon-lg"
                      title="Повторить генерацию"
                      type="button"
                      variant="outline"
                      onClick={() => void retryDocument(document)}
                    >
                      <RefreshCwIcon aria-hidden="true" />
                    </Button>
                  ) : null}
                  <Button
                    aria-label={`Удалить PDF ${document.title}`}
                    size="icon-lg"
                    title="Удалить PDF"
                    type="button"
                    variant="destructive"
                    onClick={() => setDeleteTarget({ kind: 'document', item: document })}
                  >
                    <Trash2Icon aria-hidden="true" />
                  </Button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty className="content-panel project-presentations-empty">
            <EmptyHeader>
              <EmptyMedia variant="icon"><FileClockIcon aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>PDF ещё не создавались</EmptyTitle>
              <EmptyDescription>Готовые документы появятся здесь после генерации.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )
      ) : null}

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && !isSubmitting && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{deleteTarget?.kind === 'draft' ? 'Удалить черновик?' : 'Удалить PDF?'}</DialogTitle>
            <DialogDescription>
              {deleteTarget?.kind === 'draft'
                ? 'Черновик нельзя будет восстановить. Уже созданные PDF останутся в истории.'
                : 'Файл и запись истории будут удалены без возможности восстановления.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button disabled={isSubmitting} type="button" variant="outline" onClick={() => setDeleteTarget(null)}>
              Отмена
            </Button>
            <Button disabled={isSubmitting} type="button" variant="destructive" onClick={() => void confirmDelete()}>
              {isSubmitting ? 'Удаляем…' : 'Удалить'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DocumentStatus({ document }: { document: ProjectPresentationDocument }) {
  const labels: Record<ProjectPresentationDocument['status'], string> = {
    PENDING: 'В очереди',
    RUNNING: `Формируется ${document.progress}%`,
    READY: 'Готов',
    FAILED: 'Ошибка',
  };

  return <Badge variant={document.status === 'FAILED' ? 'destructive' : 'secondary'}>{labels[document.status]}</Badge>;
}

function ProjectPresentationListSkeleton() {
  return (
    <div className="project-presentations-card-grid" aria-label="Загрузка презентаций">
      {[0, 1, 2].map((item) => (
        <Card key={item}>
          <CardHeader><Skeleton className="h-5 w-2/3" /><Skeleton className="h-4 w-1/2" /></CardHeader>
          <CardContent><Skeleton className="h-10 w-full" /></CardContent>
        </Card>
      ))}
    </div>
  );
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function resolveError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
