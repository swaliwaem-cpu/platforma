import { FormEvent, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeftIcon,
  EyeIcon,
  FileTextIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SaveIcon,
} from 'lucide-react';
import type {
  DevelopersResponse,
  FeedFormat,
  FeedImportRun,
  FeedImportRunResponse,
  FeedImportRunsResponse,
  FeedSource,
  FeedSourceResponse,
  FeedSourcesResponse,
  FeedSourceKind,
  FeedUnit,
  FeedUnitStatus,
  FeedUnitType,
  FeedUnitsResponse,
  ImportMode,
  ImportStatus,
  JsonValue,
  ObjectDeveloper,
  ObjectsResponse,
  RealEstateObjectSummary,
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

import { useAuth } from '../auth/AuthProvider';
import { AdminAlert, AdminButton, AdminEmptyState, AdminPanel, AdminStatusBadge } from './AdminUi';
import { apiRequest } from './api';

type FeedsAdminPageProps = {
  pathname: string;
  navigate: (nextPathname: string) => void;
  onBack: () => void;
};

type SourceFormState = {
  sourceKind: FeedSourceKind;
  url: string;
  xmlFile: File | null;
  format: FeedFormat;
  developerId: string;
  objectId: string;
  isActive: boolean;
};

type FeedCommandMode = 'preview' | 'run';

const sourceListPageSize = 20;
const sourceLookupLimit = 100;
const objectDirectoryPageSize = 100;
const runsPageSize = 10;
const unitsPageSize = 20;

const emptySourceForm: SourceFormState = {
  sourceKind: 'URL',
  url: '',
  xmlFile: null,
  format: 'YANDEX_REALTY',
  developerId: '',
  objectId: '',
  isActive: true,
};

const feedFormatLabels: Record<FeedFormat, string> = {
  YANDEX_REALTY: 'Yandex Realty',
  CIAN_XML: 'Cian XML',
};

const feedUnitTypeLabels: Record<FeedUnitType, string> = {
  RESIDENTIAL: 'Жилой',
  COMMERCIAL: 'Коммерческий',
};

const feedUnitStatusLabels: Record<FeedUnitStatus, string> = {
  AVAILABLE: 'Доступен',
  BOOKED: 'Забронирован',
  RESERVED: 'Резерв',
  SOLD: 'Продан',
  ARCHIVED: 'Архив',
  UNKNOWN: 'Неизвестно',
};

const importModeLabels: Record<ImportMode, string> = {
  PREVIEW: 'Preview',
  RUN: 'Run',
};

const importStatusLabels: Record<ImportStatus, string> = {
  PENDING: 'В процессе',
  SUCCESS: 'Успешно',
  PARTIAL: 'Частично',
  FAILED: 'Ошибка',
};

async function loadObjectDirectoryPages(accessToken: string) {
  const createParams = (page: number) =>
    new URLSearchParams({
      page: String(page),
      limit: String(objectDirectoryPageSize),
      sortBy: 'title',
      sortDirection: 'asc',
    });
  const firstPage = await apiRequest<ObjectsResponse>(`/objects?${createParams(1).toString()}`, accessToken);
  const remainingPageRequests: Array<Promise<ObjectsResponse>> = [];

  for (let page = 2; page <= firstPage.totalPages; page += 1) {
    remainingPageRequests.push(apiRequest<ObjectsResponse>(`/objects?${createParams(page).toString()}`, accessToken));
  }

  const remainingPages = await Promise.all(remainingPageRequests);

  return [firstPage, ...remainingPages].flatMap((page) => page.items);
}

export function FeedsAdminPage({ pathname, navigate, onBack }: FeedsAdminPageProps) {
  const { accessToken, hasPermission } = useAuth();
  const [sources, setSources] = useState<FeedSource[]>([]);
  const [developers, setDevelopers] = useState<ObjectDeveloper[]>([]);
  const [objects, setObjects] = useState<RealEstateObjectSummary[]>([]);
  const [form, setForm] = useState<SourceFormState>(emptySourceForm);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [runs, setRuns] = useState<FeedImportRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<FeedImportRun | null>(null);
  const [units, setUnits] = useState<FeedUnit[]>([]);
  const [sourcePage, setSourcePage] = useState(1);
  const [sourceTotal, setSourceTotal] = useState(0);
  const [sourceTotalPages, setSourceTotalPages] = useState(1);
  const [runsPage, setRunsPage] = useState(1);
  const [runsTotal, setRunsTotal] = useState(0);
  const [runsTotalPages, setRunsTotalPages] = useState(1);
  const [unitsPage, setUnitsPage] = useState(1);
  const [unitsTotal, setUnitsTotal] = useState(0);
  const [unitsTotalPages, setUnitsTotalPages] = useState(1);
  const [unitStatusFilter, setUnitStatusFilter] = useState('');
  const [unitTypeFilter, setUnitTypeFilter] = useState('');
  const [isLoadingDirectories, setIsLoadingDirectories] = useState(true);
  const [isLoadingSources, setIsLoadingSources] = useState(true);
  const [isLoadingForm, setIsLoadingForm] = useState(false);
  const [isLoadingRuns, setIsLoadingRuns] = useState(false);
  const [isLoadingUnits, setIsLoadingUnits] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [runningMode, setRunningMode] = useState<FeedCommandMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canManage = hasPermission('feeds:manage');
  const canRun = hasPermission('feeds:run');
  const editSourceId = useMemo(() => {
    const match = pathname.match(/^\/admin\/feeds\/([0-9a-f-]+)\/edit$/i);

    return match?.[1] ?? null;
  }, [pathname]);
  const isCreateRoute = pathname === '/admin/feeds/new';
  const isListRoute = pathname === '/admin/feeds';
  const isFormRoute = isCreateRoute || Boolean(editSourceId);
  const selectedSource = sources.find((source) => source.id === selectedSourceId) ?? null;
  const editorSource = editSourceId ? sources.find((source) => source.id === editSourceId) ?? null : null;
  const selectedRunSummary = useMemo(
    () => (isPlainObject(selectedRun?.summaryJson) ? selectedRun.summaryJson : null),
    [selectedRun],
  );
  const editorPreviewSummary = useMemo(() => {
    if (!editorSource || selectedRun?.sourceId !== editorSource.id || selectedRun.mode !== 'PREVIEW') {
      return null;
    }

    return selectedRunSummary;
  }, [editorSource, selectedRun, selectedRunSummary]);
  const selectedSourcePreviewSummary = useMemo(() => {
    if (!selectedSource || selectedRun?.sourceId !== selectedSource.id || selectedRun.mode !== 'PREVIEW') {
      return null;
    }

    return selectedRunSummary;
  }, [selectedRun, selectedRunSummary, selectedSource]);
  const selectedRunWarnings = useMemo(() => toJsonArray(selectedRun?.warningsJson), [selectedRun]);
  const selectedRunErrors = useMemo(() => toJsonArray(selectedRun?.errorsJson), [selectedRun]);
  const hasActiveUnitFilters = Boolean(unitStatusFilter || unitTypeFilter);
  const filteredObjects = useMemo(() => {
    if (!form.developerId) {
      return [];
    }

    return objects.filter((object) => object.developer?.id === form.developerId);
  }, [form.developerId, objects]);

  useEffect(() => {
    if (!accessToken) {
      return;
    }

    void loadDirectories();
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) {
      return;
    }

    if (isCreateRoute) {
      setForm(emptySourceForm);
      setSelectedSourceId(null);
      setSelectedRun(null);
      setRuns([]);
      setUnits([]);
      setIsLoadingSources(false);
      setIsLoadingForm(false);
      setError(null);
      setNotice(null);
      return;
    }

    if (editSourceId) {
      void loadSourceForEdit(editSourceId);
      return;
    }

    if (isListRoute) {
      void loadSources();
    }
  }, [accessToken, editSourceId, isCreateRoute, isListRoute, sourcePage]);

  useEffect(() => {
    if (!accessToken || !isListRoute || !selectedSourceId) {
      return;
    }

    void loadSourceRuns(selectedSourceId);
  }, [accessToken, isListRoute, selectedSourceId, runsPage]);

  useEffect(() => {
    if (!accessToken || !isListRoute || !selectedSourceId) {
      return;
    }

    void loadUnits(selectedSourceId);
  }, [accessToken, isListRoute, selectedSourceId, unitsPage, unitStatusFilter, unitTypeFilter]);

  async function loadDirectories() {
    if (!accessToken) {
      return;
    }

    setIsLoadingDirectories(true);

    try {
      const [developersData, objectsData] = await Promise.all([
        apiRequest<DevelopersResponse>('/developers?limit=500', accessToken),
        loadObjectDirectoryPages(accessToken),
      ]);

      setDevelopers(developersData.items);
      setObjects(objectsData);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить справочники фидов');
    } finally {
      setIsLoadingDirectories(false);
    }
  }

  async function loadSources() {
    if (!accessToken) {
      return;
    }

    setIsLoadingSources(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        page: String(sourcePage),
        limit: String(sourceListPageSize),
      });
      const data = await apiRequest<FeedSourcesResponse>(`/feeds/sources?${params.toString()}`, accessToken);

      setSources(data.items);
      setSourceTotal(data.total);
      setSourceTotalPages(data.totalPages);
      setSelectedSourceId((currentSourceId) => {
        if (currentSourceId && data.items.some((source) => source.id === currentSourceId)) {
          return currentSourceId;
        }

        return data.items[0]?.id ?? null;
      });
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить источники фидов');
    } finally {
      setIsLoadingSources(false);
    }
  }

  async function loadSourceForEdit(sourceId: string) {
    if (!accessToken) {
      return;
    }

    setIsLoadingSources(true);
    setIsLoadingForm(true);
    setError(null);

    try {
      const lookupItems: FeedSource[] = [];
      let source: FeedSource | undefined;
      let lookupPage = 1;
      let lookupTotalPages = 1;

      do {
        const params = new URLSearchParams({
          page: String(lookupPage),
          limit: String(sourceLookupLimit),
        });
        const data = await apiRequest<FeedSourcesResponse>(`/feeds/sources?${params.toString()}`, accessToken);

        lookupItems.push(...data.items);
        source = data.items.find((item) => item.id === sourceId);
        lookupTotalPages = data.totalPages;
        lookupPage += 1;
      } while (!source && lookupPage <= lookupTotalPages);

      if (!source) {
        throw new Error('Источник фида не найден');
      }

      setSources(lookupItems);
      setSelectedSourceId(source.id);
      setForm(createFormFromSource(source));
      void loadLatestPreviewRun(source.id);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось открыть источник фида');
    } finally {
      setIsLoadingSources(false);
      setIsLoadingForm(false);
    }
  }

  async function loadLatestPreviewRun(sourceId: string) {
    if (!accessToken) {
      return;
    }

    setIsLoadingRuns(true);

    try {
      const params = new URLSearchParams({
        page: '1',
        limit: '1',
        mode: 'preview',
      });
      const data = await apiRequest<FeedImportRunsResponse>(`/feeds/sources/${sourceId}/runs?${params.toString()}`, accessToken);

      setSelectedRun(data.items[0] ?? null);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить последний preview фида');
    } finally {
      setIsLoadingRuns(false);
    }
  }

  async function loadSourceRuns(sourceId: string) {
    if (!accessToken) {
      return;
    }

    setIsLoadingRuns(true);

    try {
      const params = new URLSearchParams({
        page: String(runsPage),
        limit: String(runsPageSize),
      });
      const data = await apiRequest<FeedImportRunsResponse>(`/feeds/sources/${sourceId}/runs?${params.toString()}`, accessToken);

      setRuns(data.items);
      setRunsTotal(data.total);
      setRunsTotalPages(data.totalPages);
      setSelectedRun((currentRun) => {
        if (currentRun && data.items.some((run) => run.id === currentRun.id)) {
          return currentRun;
        }

        return data.items[0] ?? null;
      });
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить отчёты фида');
    } finally {
      setIsLoadingRuns(false);
    }
  }

  async function loadUnits(sourceId: string) {
    if (!accessToken) {
      return;
    }

    setIsLoadingUnits(true);

    try {
      const params = new URLSearchParams({
        page: String(unitsPage),
        limit: String(unitsPageSize),
        sourceId,
      });

      if (unitStatusFilter) {
        params.set('status', unitStatusFilter);
      }

      if (unitTypeFilter) {
        params.set('type', unitTypeFilter);
      }

      const data = await apiRequest<FeedUnitsResponse>(`/feeds/units?${params.toString()}`, accessToken);

      setUnits(data.items);
      setUnitsTotal(data.total);
      setUnitsTotalPages(data.totalPages);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить лоты фида');
    } finally {
      setIsLoadingUnits(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!accessToken) {
      return;
    }

    const validationError = validateSourceForm(form, editorSource);

    if (validationError) {
      setError(validationError);
      setNotice(null);
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setNotice(null);

    try {
      if (isCreateRoute) {
        const data = await apiRequest<FeedSourceResponse>('/feeds/sources', accessToken, {
          method: 'POST',
          body: createSourceRequestBody(form),
        });

        setNotice('Источник фида создан');
        navigate(`/admin/feeds/${data.source.id}/edit`);
        return;
      }

      if (editSourceId) {
        const sourceId = editSourceId;
        const data = await apiRequest<FeedSourceResponse>(`/feeds/sources/${sourceId}`, accessToken, {
          method: 'PATCH',
          body: createSourceRequestBody(form),
        });

        setSources((currentSources) =>
          currentSources.map((source) => (source.id === data.source.id ? data.source : source)),
        );
        setForm(createFormFromSource(data.source));
        setSelectedSourceId(data.source.id);
        setNotice('Источник фида сохранён');
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось сохранить источник фида');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function runSourceCommand(sourceId: string, mode: FeedCommandMode) {
    if (!accessToken) {
      return;
    }

    const confirmed = mode === 'preview' || window.confirm('Запустить импорт фида с записью данных?');

    if (!confirmed) {
      return;
    }

    setRunningMode(mode);
    setError(null);
    setNotice(null);

    try {
      const data =
        mode === 'preview'
          ? await apiRequest<FeedImportRunResponse>(`/feeds/sources/${sourceId}/preview`, accessToken, {
              method: 'POST',
            })
          : await apiRequest<FeedImportRunResponse>(`/feeds/sources/${sourceId}/run`, accessToken, {
              method: 'POST',
            });

      setSelectedRun(data.run);
      setNotice(mode === 'preview' ? 'Preview фида завершён' : 'Run фида завершён');

      if (isListRoute) {
        await Promise.all([loadSources(), loadSourceRuns(sourceId), loadUnits(sourceId)]);
      } else if (editSourceId) {
        await loadSourceForEdit(editSourceId);
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Команда фида не выполнена');
    } finally {
      setRunningMode(null);
    }
  }

  async function openRun(runId: string) {
    if (!accessToken) {
      return;
    }

    setError(null);

    try {
      const data = await apiRequest<FeedImportRunResponse>(`/feeds/runs/${runId}`, accessToken);
      setSelectedRun(data.run);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось открыть отчёт фида');
    }
  }

  function selectSource(sourceId: string) {
    setSelectedSourceId(sourceId);
    setSelectedRun(null);
    setRunsPage(1);
    setUnitsPage(1);
    setUnitStatusFilter('');
    setUnitTypeFilter('');
  }

  function resetUnitFilters() {
    setUnitStatusFilter('');
    setUnitTypeFilter('');
    setUnitsPage(1);
  }

  if (isFormRoute) {
    const editorTitle = isCreateRoute ? 'Новый источник фида' : 'Редактирование фида';
    const isFormDisabled = isLoadingDirectories || isLoadingForm || isSubmitting;
    const isRunning = runningMode !== null;

    return (
      <div className="admin-feeds admin-feeds--editor">
        <header className="page-header">
          <div>
            <p className="eyebrow">Фиды</p>
            <h2>{editorTitle}</h2>
          </div>
          <div className="header-actions">
            {editorSource ? (
              <>
                <AdminButton
                  disabled={!canRun || isRunning}
                  title={canRun ? undefined : 'Нет права feeds:run'}
                  tone="secondary"
                  type="button"
                  onClick={() => void runSourceCommand(editorSource.id, 'preview')}
                >
                  <EyeIcon data-icon="inline-start" />
                  {runningMode === 'preview' ? 'Preview...' : 'Preview'}
                </AdminButton>
                <AdminButton
                  disabled={!canRun || isRunning}
                  title={canRun ? undefined : 'Нет права feeds:run'}
                  tone="primary"
                  type="button"
                  onClick={() => void runSourceCommand(editorSource.id, 'run')}
                >
                  <PlayIcon data-icon="inline-start" />
                  {runningMode === 'run' ? 'Run...' : 'Run'}
                </AdminButton>
              </>
            ) : null}
            <AdminButton disabled={isSubmitting || isRunning} tone="secondary" type="button" onClick={() => navigate('/admin/feeds')}>
              <ArrowLeftIcon data-icon="inline-start" />
              К списку
            </AdminButton>
            <AdminButton
              disabled={isFormDisabled || !canManage || isRunning}
              form="feed-source-form"
              title={canManage ? undefined : 'Нет права feeds:manage'}
              tone="primary"
              type="submit"
            >
              <SaveIcon data-icon="inline-start" />
              {isSubmitting ? 'Сохранение' : 'Сохранить'}
            </AdminButton>
          </div>
        </header>

        {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}
        {notice ? <AdminAlert tone="notice">{notice}</AdminAlert> : null}

        <form id="feed-source-form" className="feed-source-form" onSubmit={(event) => void handleSubmit(event)}>
          <fieldset disabled={isFormDisabled}>
            <AdminPanel className="editor-panel feed-source-editor-panel">
              <section className="feed-form-section">
                <div className="feed-form-section-header">
                  <h3>Источник</h3>
                  <p>Фид связывается с существующим застройщиком и ЖК, новые объекты здесь не создаются.</p>
                </div>

                <div className="form-grid feed-source-form-grid">
                  <div className="field-wide feed-source-kind-field">
                    <span>Способ</span>
                    <div className="feed-source-kind-options" role="radiogroup" aria-label="Способ подключения фида">
                      <label className={form.sourceKind === 'URL' ? 'feed-source-kind-option is-selected' : 'feed-source-kind-option'}>
                        <input
                          checked={form.sourceKind === 'URL'}
                          name="sourceKind"
                          type="radio"
                          value="URL"
                          onChange={() =>
                            setForm((currentForm) => ({
                              ...currentForm,
                              sourceKind: 'URL',
                              xmlFile: null,
                            }))
                          }
                        />
                        URL
                      </label>
                      <label className={form.sourceKind === 'FILE' ? 'feed-source-kind-option is-selected' : 'feed-source-kind-option'}>
                        <input
                          checked={form.sourceKind === 'FILE'}
                          name="sourceKind"
                          type="radio"
                          value="FILE"
                          onChange={() =>
                            setForm((currentForm) => ({
                              ...currentForm,
                              sourceKind: 'FILE',
                              url: '',
                            }))
                          }
                        />
                        XML-файл
                      </label>
                    </div>
                  </div>

                  {form.sourceKind === 'URL' ? (
                    <label className="field-wide">
                      URL
                      <input
                        name="url"
                        placeholder="https://example.com/feed.xml"
                        type="url"
                        value={form.url}
                        onChange={(event) => setForm((currentForm) => ({ ...currentForm, url: event.target.value }))}
                      />
                    </label>
                  ) : (
                    <label className="field-wide">
                      XML-файл
                      <input
                        accept=".xml,application/xml,text/xml"
                        name="xmlFile"
                        type="file"
                        onChange={(event) =>
                          setForm((currentForm) => ({
                            ...currentForm,
                            xmlFile: event.target.files?.[0] ?? null,
                          }))
                        }
                      />
                      {form.xmlFile ? (
                        <span className="feed-source-file-current">{form.xmlFile.name}</span>
                      ) : editorSource?.xmlFile ? (
                        <span className="feed-source-file-current">{editorSource.xmlFile.originalName ?? editorSource.xmlFile.key}</span>
                      ) : null}
                    </label>
                  )}

                  <label>
                    Формат
                    <select
                      name="format"
                      value={form.format}
                      onChange={(event) =>
                        setForm((currentForm) => ({ ...currentForm, format: event.target.value as FeedFormat }))
                      }
                    >
                      {Object.entries(feedFormatLabels).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="feed-source-active">
                    <input
                      checked={form.isActive}
                      name="isActive"
                      type="checkbox"
                      onChange={(event) =>
                        setForm((currentForm) => ({ ...currentForm, isActive: event.target.checked }))
                      }
                    />
                    Активен
                  </label>

                  <label>
                    Застройщик
                    <select
                      name="developerId"
                      value={form.developerId}
                      onChange={(event) =>
                        setForm((currentForm) => {
                          const developerId = event.target.value;
                          const selectedObjectMatchesDeveloper = objects.some(
                            (object) => object.id === currentForm.objectId && object.developer?.id === developerId,
                          );

                          return {
                            ...currentForm,
                            developerId,
                            objectId: selectedObjectMatchesDeveloper ? currentForm.objectId : '',
                          };
                        })
                      }
                    >
                      <option value="">Выберите застройщика</option>
                      {developers.map((developer) => (
                        <option key={developer.id} value={developer.id}>
                          {developer.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label>
                    Связанный ЖК
                    <select
                      disabled={!form.developerId}
                      name="objectId"
                      value={form.objectId}
                      onChange={(event) =>
                        setForm((currentForm) => ({ ...currentForm, objectId: event.target.value }))
                      }
                    >
                      <option value="">Выберите ЖК</option>
                      {filteredObjects.map((object) => (
                        <option key={object.id} value={object.id}>
                          {object.title}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </section>

              {editorSource ? <SourceMeta source={editorSource} previewSummary={editorPreviewSummary} /> : null}
            </AdminPanel>
          </fieldset>
        </form>
      </div>
    );
  }

  return (
    <div className="admin-feeds">
      <header className="page-header">
        <div>
          <p className="eyebrow">Админка</p>
          <h2>Фиды</h2>
        </div>
        <div className="header-actions">
          <AdminButton
            disabled={isLoadingSources}
            tone="secondary"
            type="button"
            onClick={() => void loadSources()}
          >
            <RefreshCwIcon data-icon="inline-start" />
            Обновить
          </AdminButton>
          <AdminButton
            disabled={!canManage}
            title={canManage ? undefined : 'Нет права feeds:manage'}
            tone="primary"
            type="button"
            onClick={() => navigate('/admin/feeds/new')}
          >
            <PlusIcon data-icon="inline-start" />
            Новый источник
          </AdminButton>
          <AdminButton tone="secondary" type="button" onClick={onBack}>
            <ArrowLeftIcon data-icon="inline-start" />
            Назад
          </AdminButton>
        </div>
      </header>

      {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}
      {notice ? <AdminAlert tone="notice">{notice}</AdminAlert> : null}

      <div className="feeds-layout">
        <AdminPanel className="table-panel feed-sources-panel" role="region" aria-label="Источники фидов">
          <div className="table-meta">
            <span>{isLoadingSources ? 'Загрузка источников' : `Всего: ${sourceTotal}`}</span>
            <span>
              Страница {sourcePage} из {sourceTotalPages}
            </span>
          </div>

          <div className="table-scroll">
            <Table className="admin-table feed-sources-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Источник</TableHead>
                  <TableHead>Формат</TableHead>
                  <TableHead>Статус</TableHead>
                  <TableHead>Последний запуск</TableHead>
                  <TableHead>
                    <span className="sr-only">Действия</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoadingSources ? <TableSkeleton columns={5} rows={4} /> : null}

                {!isLoadingSources
                  ? sources.map((source) => (
                      <TableRow
                        key={source.id}
                        aria-selected={selectedSourceId === source.id}
                        className={selectedSourceId === source.id ? 'is-selected' : undefined}
                        data-state={selectedSourceId === source.id ? 'selected' : undefined}
                      >
                        <TableCell>
                          <div className="feed-source-cell">
                            <strong>{source.object.title}</strong>
                            <span>{source.developer.name}</span>
                            <code>{getSourceDisplay(source)}</code>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className={`feed-format-pill feed-format-pill--${source.format.toLowerCase()}`}>
                            {feedFormatLabels[source.format]}
                          </span>
                        </TableCell>
                        <TableCell>
                          <AdminStatusBadge className={source.isActive ? 'feed-source-status--active' : 'feed-source-status--inactive'}>
                            {source.isActive ? 'Активен' : 'Отключён'}
                          </AdminStatusBadge>
                        </TableCell>
                        <TableCell>
                          <div className="feed-run-date-cell">
                            <strong>{source.lastRunAt ? formatDateTime(source.lastRunAt) : 'Не запускался'}</strong>
                            <span>Preview: {source.lastPreviewAt ? formatDateTime(source.lastPreviewAt) : 'нет'}</span>
                          </div>
                        </TableCell>
                        <TableCell className="feed-action-column">
                          <div className="feed-row-actions">
                            <AdminButton tone="text" type="button" onClick={() => selectSource(source.id)}>
                              Выбрать
                            </AdminButton>
                            <AdminButton tone="text" type="button" onClick={() => navigate(`/admin/feeds/${source.id}/edit`)}>
                              Редактировать
                            </AdminButton>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  : null}

                {!isLoadingSources && sources.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5}>
                      <AdminEmptyState title="Источники не найдены" description="Создайте первый источник фида." />
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>

          <div className="pagination">
            <AdminButton
              disabled={sourcePage <= 1}
              tone="secondary"
              type="button"
              onClick={() => setSourcePage((currentPage) => Math.max(1, currentPage - 1))}
            >
              Назад
            </AdminButton>
            <AdminButton
              disabled={sourcePage >= sourceTotalPages}
              tone="secondary"
              type="button"
              onClick={() => setSourcePage((currentPage) => currentPage + 1)}
            >
              Вперёд
            </AdminButton>
          </div>
        </AdminPanel>

        <AdminPanel className="editor-panel feed-source-side-panel" role="region" aria-label="Действия источника">
          {selectedSource ? (
            <>
              <div className="feed-panel-heading">
                <div>
                  <p className="eyebrow">{feedFormatLabels[selectedSource.format]}</p>
                  <h3>{selectedSource.object.title}</h3>
                </div>
                <AdminStatusBadge className={selectedSource.isActive ? 'feed-source-status--active' : 'feed-source-status--inactive'}>
                  {selectedSource.isActive ? 'Active' : 'Off'}
                </AdminStatusBadge>
              </div>

              <SourceMeta source={selectedSource} previewSummary={selectedSourcePreviewSummary} />

              <div className="feed-command-actions">
                <AdminButton
                  disabled={!canRun || runningMode !== null}
                  title={canRun ? undefined : 'Нет права feeds:run'}
                  tone="secondary"
                  type="button"
                  onClick={() => void runSourceCommand(selectedSource.id, 'preview')}
                >
                  <EyeIcon data-icon="inline-start" />
                  {runningMode === 'preview' ? 'Preview...' : 'Preview'}
                </AdminButton>
                <AdminButton
                  disabled={!canRun || runningMode !== null}
                  title={canRun ? undefined : 'Нет права feeds:run'}
                  tone="primary"
                  type="button"
                  onClick={() => void runSourceCommand(selectedSource.id, 'run')}
                >
                  <PlayIcon data-icon="inline-start" />
                  {runningMode === 'run' ? 'Run...' : 'Run'}
                </AdminButton>
                <AdminButton type="button" onClick={() => navigate(`/admin/feeds/${selectedSource.id}/edit`)}>
                  Редактировать
                </AdminButton>
              </div>
            </>
          ) : (
            <AdminEmptyState title="Источник не выбран" description="Выберите строку или создайте новый источник." />
          )}
        </AdminPanel>
      </div>

      <div className="feed-reports-layout">
        <AdminPanel className="table-panel feed-runs-panel" role="region" aria-label="Отчёты фида">
          <div className="table-meta">
            <span>{isLoadingRuns ? 'Загрузка отчётов' : `Отчётов: ${runsTotal}`}</span>
            <span>
              Страница {runsPage} из {runsTotalPages}
            </span>
          </div>

          <div className="table-scroll">
            <Table className="admin-table feed-runs-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Старт</TableHead>
                  <TableHead>Режим</TableHead>
                  <TableHead>Статус</TableHead>
                  <TableHead>Warnings</TableHead>
                  <TableHead>Errors</TableHead>
                  <TableHead>
                    <span className="sr-only">Действия</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoadingRuns ? <TableSkeleton columns={6} rows={3} /> : null}

                {!isLoadingRuns
                  ? runs.map((run) => (
                      <TableRow
                        key={run.id}
                        aria-selected={selectedRun?.id === run.id}
                        className={selectedRun?.id === run.id ? 'is-selected' : undefined}
                        data-state={selectedRun?.id === run.id ? 'selected' : undefined}
                      >
                        <TableCell>
                          <div className="feed-run-date-cell">
                            <strong>{formatDateTime(run.startedAt)}</strong>
                            <span>{formatRunDuration(run)}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className={`import-mode-pill import-mode-pill--${run.mode.toLowerCase()}`}>
                            {importModeLabels[run.mode]}
                          </span>
                        </TableCell>
                        <TableCell>
                          <AdminStatusBadge className={`import-status import-status--${run.status.toLowerCase()}`}>
                            {importStatusLabels[run.status]}
                          </AdminStatusBadge>
                        </TableCell>
                        <TableCell>{formatIssueCount(run.warningsJson, run.summaryJson, 'warningsCount')}</TableCell>
                        <TableCell>{formatIssueCount(run.errorsJson, run.summaryJson, 'errorsCount')}</TableCell>
                        <TableCell className="feed-action-column">
                          <AdminButton tone="text" type="button" onClick={() => void openRun(run.id)}>
                            <FileTextIcon data-icon="inline-start" />
                            Открыть
                          </AdminButton>
                        </TableCell>
                      </TableRow>
                    ))
                  : null}

                {!isLoadingRuns && selectedSource && runs.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6}>
                      <AdminEmptyState title="Отчётов нет" description="Запустите Preview или Run для выбранного источника." />
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>

          <div className="pagination">
            <AdminButton
              disabled={runsPage <= 1}
              tone="secondary"
              type="button"
              onClick={() => setRunsPage((currentPage) => Math.max(1, currentPage - 1))}
            >
              Назад
            </AdminButton>
            <AdminButton
              disabled={runsPage >= runsTotalPages}
              tone="secondary"
              type="button"
              onClick={() => setRunsPage((currentPage) => currentPage + 1)}
            >
              Вперёд
            </AdminButton>
          </div>
        </AdminPanel>

        <AdminPanel className="editor-panel feed-run-detail-panel" role="region" aria-label="Детали отчёта фида">
          {selectedRun ? (
            <>
              <div className="feed-panel-heading">
                <div>
                  <p className="eyebrow">{importModeLabels[selectedRun.mode]}</p>
                  <h3>{importStatusLabels[selectedRun.status]}</h3>
                </div>
                <AdminStatusBadge className={`import-status import-status--${selectedRun.status.toLowerCase()}`}>
                  {selectedRun.status}
                </AdminStatusBadge>
              </div>

              <dl className="details-list feed-details">
                <div>
                  <dt>Старт</dt>
                  <dd>{formatDateTime(selectedRun.startedAt)}</dd>
                </div>
                <div>
                  <dt>Финиш</dt>
                  <dd>{selectedRun.finishedAt ? formatDateTime(selectedRun.finishedAt) : 'Не завершён'}</dd>
                </div>
                <div>
                  <dt>Длительность</dt>
                  <dd>{formatRunDuration(selectedRun)}</dd>
                </div>
              </dl>

              <ReportSummary summary={selectedRunSummary} />
              <ReportIssues title="Warnings" issues={selectedRunWarnings} />
              <ReportIssues title="Errors" issues={selectedRunErrors} />
            </>
          ) : (
            <AdminEmptyState title="Отчёт не выбран" description="Откройте строку отчёта выбранного источника." />
          )}
        </AdminPanel>
      </div>

      <AdminPanel className="table-panel feed-units-panel" role="region" aria-label="Лоты источника">
        <section className="toolbar feed-units-toolbar" aria-label="Фильтры лотов источника">
          <div className="feed-units-toolbar-main">
            <label className="toolbar-field">
              <span>Статус</span>
              <select
                aria-label="Фильтр лотов по статусу"
                value={unitStatusFilter}
                onChange={(event) => {
                  setUnitStatusFilter(event.target.value);
                  setUnitsPage(1);
                }}
              >
                <option value="">Все статусы</option>
                {Object.entries(feedUnitStatusLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            <label className="toolbar-field">
              <span>Тип</span>
              <select
                aria-label="Фильтр лотов по типу"
                value={unitTypeFilter}
                onChange={(event) => {
                  setUnitTypeFilter(event.target.value);
                  setUnitsPage(1);
                }}
              >
                <option value="">Все типы</option>
                {Object.entries(feedUnitTypeLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="feed-units-toolbar-actions">
            <AdminButton disabled={!hasActiveUnitFilters} tone="secondary" type="button" onClick={resetUnitFilters}>
              <RotateCcwIcon data-icon="inline-start" />
              Сбросить
            </AdminButton>
          </div>
        </section>

        <div className="table-meta">
          <span>{isLoadingUnits ? 'Загрузка лотов' : `Лотов: ${unitsTotal}`}</span>
          <span>
            Страница {unitsPage} из {unitsTotalPages}
          </span>
        </div>

        <div className="table-scroll">
          <Table className="admin-table feed-units-table">
            <TableHeader>
              <TableRow>
                <TableHead>Лот</TableHead>
                <TableHead>Статус</TableHead>
                <TableHead>Тип</TableHead>
                <TableHead>Цена</TableHead>
                <TableHead>Площадь</TableHead>
                <TableHead>Комнаты/тип</TableHead>
                <TableHead>Этаж</TableHead>
                <TableHead>Корпус/секция</TableHead>
                <TableHead>Медиа</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoadingUnits ? <TableSkeleton columns={9} rows={4} /> : null}

              {!isLoadingUnits
                ? units.map((unit) => (
                    <TableRow key={unit.id}>
                      <TableCell>
                        <div className="feed-unit-cell">
                          <strong>{unit.title || unit.externalId}</strong>
                          <span>ID {unit.externalId}</span>
                          {unit.address ? <span>{unit.address}</span> : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <AdminStatusBadge className={`feed-unit-status feed-unit-status--${unit.status.toLowerCase()}`}>
                          {feedUnitStatusLabels[unit.status]}
                        </AdminStatusBadge>
                      </TableCell>
                      <TableCell>{feedUnitTypeLabels[unit.type]}</TableCell>
                      <TableCell>{formatMoney(unit.price, unit.currency)}</TableCell>
                      <TableCell>{formatArea(unit.area)}</TableCell>
                      <TableCell>{getUnitRoomsOrType(unit)}</TableCell>
                      <TableCell>{unit.floor ?? 'Не указан'}</TableCell>
                      <TableCell>{formatBuildingSection(unit)}</TableCell>
                      <TableCell>{formatMediaCount(unit.media.length)}</TableCell>
                    </TableRow>
                  ))
                : null}

              {!isLoadingUnits && selectedSource && units.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9}>
                    <AdminEmptyState title="Лоты не найдены" description="Запустите Run или измените фильтры." />
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>

        <div className="pagination">
          <AdminButton
            disabled={unitsPage <= 1}
            tone="secondary"
            type="button"
            onClick={() => setUnitsPage((currentPage) => Math.max(1, currentPage - 1))}
          >
            Назад
          </AdminButton>
          <AdminButton
            disabled={unitsPage >= unitsTotalPages}
            tone="secondary"
            type="button"
            onClick={() => setUnitsPage((currentPage) => currentPage + 1)}
          >
            Вперёд
          </AdminButton>
        </div>
      </AdminPanel>
    </div>
  );
}

function SourceMeta({ source, previewSummary }: { source: FeedSource; previewSummary?: Record<string, unknown> | null }) {
  const previewMetrics = getFeedPreviewMetrics(previewSummary);

  return (
    <dl className="details-list feed-details">
      <div>
        <dt>Застройщик</dt>
        <dd>{source.developer.name}</dd>
      </div>
      <div>
        <dt>ЖК</dt>
        <dd>{source.object.title}</dd>
      </div>
      <div>
        <dt>Источник</dt>
        <dd>{getSourceDisplay(source)}</dd>
      </div>
      <div>
        <dt>Preview</dt>
        <dd>{source.lastPreviewAt ? formatDateTime(source.lastPreviewAt) : 'Не запускался'}</dd>
      </div>
      <div>
        <dt>Лотов к загрузке</dt>
        <dd>{formatOptionalNumber(previewMetrics.unitsCount)}</dd>
      </div>
      <div>
        <dt>Медиа к загрузке</dt>
        <dd>{formatOptionalNumber(previewMetrics.mediaCount)}</dd>
      </div>
      <div>
        <dt>Run</dt>
        <dd>{source.lastRunAt ? formatDateTime(source.lastRunAt) : 'Не запускался'}</dd>
      </div>
      <div>
        <dt>Успешно</dt>
        <dd>{source.lastSuccessAt ? formatDateTime(source.lastSuccessAt) : 'Нет данных'}</dd>
      </div>
    </dl>
  );
}

function TableSkeleton({ columns, rows }: { columns: number; rows: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, index) => (
        <TableRow key={index}>
          <TableCell colSpan={columns}>
            <Skeleton className="feed-table-skeleton" />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

function ReportSummary({ summary }: { summary: Record<string, unknown> | null }) {
  return (
    <section className="report-summary-section">
      <div className="report-section-header">
        <h4>Summary</h4>
        <span>{summary ? Object.keys(summary).length : 0}</span>
      </div>
      {summary ? (
        <dl className="report-summary">
          {Object.entries(summary).map(([key, value]) => (
            <div key={key} className={key.toLowerCase().includes('error') ? 'report-summary-item--danger' : undefined}>
              <dt>{formatSummaryKey(key)}</dt>
              <dd>{formatSummaryValue(value)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="helper-text">Summary отсутствует в отчёте.</p>
      )}
    </section>
  );
}

function ReportIssues({ title, issues }: { title: string; issues: unknown[] }) {
  return (
    <section className="report-issues">
      <div className="report-section-header">
        <h4>{title}</h4>
        <span>{formatNumber(issues.length)}</span>
      </div>
      {issues.length > 0 ? (
        <ul className="report-issue-list">
          {issues.map((issue, index) => {
            const issueView = toIssueView(issue, index);

            return (
              <li key={index} className={`report-issue-card report-issue-card--${issueView.severity}`}>
                <div className="report-issue-heading">
                  <span className="report-issue-code">{issueView.code}</span>
                  <span className="report-issue-severity">{issueView.severity}</span>
                </div>
                <p>{issueView.message}</p>
                {issueView.meta.length > 0 ? (
                  <dl className="report-issue-meta">
                    {issueView.meta.map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                <details className="report-issue-raw">
                  <summary>Исходные данные</summary>
                  <pre>{issueView.raw}</pre>
                </details>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="helper-text">Нет</p>
      )}
    </section>
  );
}

function createFormFromSource(source: FeedSource): SourceFormState {
  return {
    sourceKind: source.sourceKind,
    url: source.url ?? '',
    xmlFile: null,
    format: source.format,
    developerId: source.developerId,
    objectId: source.objectId,
    isActive: source.isActive,
  };
}

function validateSourceForm(form: SourceFormState, existingSource?: FeedSource | null) {
  if (form.sourceKind === 'URL' && !form.url.trim()) {
    return 'Укажите URL фида';
  }

  if (form.sourceKind === 'FILE' && !form.xmlFile && existingSource?.sourceKind !== 'FILE') {
    return 'Выберите XML-файл фида';
  }

  if (!form.developerId) {
    return 'Выберите застройщика';
  }

  if (!form.objectId) {
    return 'Выберите связанный ЖК';
  }

  return null;
}

function createSourceRequestBody(form: SourceFormState) {
  const formData = new FormData();

  formData.append('sourceKind', form.sourceKind);
  formData.append('format', form.format);
  formData.append('developerId', form.developerId);
  formData.append('objectId', form.objectId);
  formData.append('isActive', String(form.isActive));

  if (form.sourceKind === 'URL') {
    formData.append('url', form.url.trim());
  }

  if (form.sourceKind === 'FILE' && form.xmlFile) {
    formData.append('xmlFile', form.xmlFile);
  }

  return formData;
}

function getSourceDisplay(source: FeedSource) {
  if (source.sourceKind === 'FILE') {
    return source.xmlFile?.originalName ?? source.xmlFile?.key ?? 'XML-файл';
  }

  return source.url ?? 'URL не указан';
}

function toJsonArray(value: JsonValue | undefined) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getFeedPreviewMetrics(summary: Record<string, unknown> | null | undefined) {
  const media = isPlainObject(summary?.media) ? summary.media : null;
  const unitsCount = toPreviewMetricNumber(summary?.unitsParsed);
  const mediaCreated = media ? media.created : null;
  const mediaUnique = media ? media.unique : null;
  const mediaCount = toPreviewMetricNumber(mediaCreated) ?? toPreviewMetricNumber(mediaUnique);

  return {
    unitsCount,
    mediaCount,
  };
}

function toPreviewMetricNumber(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }

  return value;
}

function formatDateTime(value: string) {
  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    return 'Не указано';
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatRunDuration(run: FeedImportRun) {
  const summary = isPlainObject(run.summaryJson) ? run.summaryJson : null;
  const durationMs = summary?.durationMs;

  if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0) {
    return formatDurationMs(durationMs);
  }

  if (!run.finishedAt) {
    return run.status === 'PENDING' ? 'В процессе' : 'Не завершён';
  }

  const duration = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();

  if (!Number.isFinite(duration) || duration < 0) {
    return 'Не указано';
  }

  return formatDurationMs(duration);
}

function formatDurationMs(durationMs: number) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));

  if (totalSeconds < 60) {
    return `${totalSeconds} сек.`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return seconds > 0 ? `${minutes} мин. ${seconds} сек.` : `${minutes} мин.`;
}

function formatIssueCount(jsonValue: JsonValue, summaryJson: JsonValue, summaryKey: string) {
  const summary = isPlainObject(summaryJson) ? summaryJson : null;
  const summaryValue = summary?.[summaryKey];

  if (typeof summaryValue === 'number') {
    return formatNumber(summaryValue);
  }

  return formatNumber(toJsonArray(jsonValue).length);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('ru-RU').format(value);
}

function formatOptionalNumber(value: number | null) {
  return value === null ? 'Нет данных' : formatNumber(value);
}

function formatSummaryKey(key: string) {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();
}

function formatSummaryValue(value: unknown) {
  if (typeof value === 'number') {
    return formatNumber(value);
  }

  if (typeof value === 'boolean') {
    return value ? 'Да' : 'Нет';
  }

  if (typeof value === 'string') {
    return value || 'Не указано';
  }

  if (value === null || value === undefined) {
    return '0';
  }

  return stringifyJson(value);
}

function formatMoney(value: string | null, currency: string | null) {
  if (!value) {
    return 'Не указана';
  }

  const numberValue = Number(value);
  const formattedValue = Number.isFinite(numberValue) ? formatNumber(numberValue) : value;
  const currencyLabel = currency === 'RUB' || currency === 'RUR' ? '₽' : currency;

  return currencyLabel ? `${formattedValue} ${currencyLabel}` : formattedValue;
}

function formatArea(value: string | null) {
  if (!value) {
    return 'Не указана';
  }

  const numberValue = Number(value);
  const formattedValue = Number.isFinite(numberValue) ? formatNumber(numberValue) : value;

  return `${formattedValue} м²`;
}

function getUnitRoomsOrType(unit: FeedUnit) {
  if (unit.type === 'RESIDENTIAL') {
    if (unit.rooms !== null) {
      return unit.rooms === 0 ? 'Студия' : `${unit.rooms} комн.`;
    }

    return unit.residentialDetails?.layoutType || 'Не указано';
  }

  return unit.commercialDetails?.commercialType || 'Коммерция';
}

function formatBuildingSection(unit: FeedUnit) {
  const values = [unit.building, unit.section].filter(Boolean);

  return values.length > 0 ? values.join(' / ') : 'Не указаны';
}

function formatMediaCount(count: number) {
  if (count === 0) {
    return 'Нет';
  }

  return formatNumber(count);
}

function toIssueView(issue: unknown, index: number) {
  const raw = stringifyJson(issue);

  if (!isPlainObject(issue)) {
    return {
      code: `item-${index + 1}`,
      message: formatSummaryValue(issue),
      meta: [] as [string, string][],
      raw,
      severity: 'info',
    };
  }

  const severityValue = issue.severity;
  const severity =
    severityValue === 'error' || severityValue === 'warning' || severityValue === 'info'
      ? severityValue
      : 'info';
  const code = typeof issue.code === 'string' && issue.code.trim() ? issue.code : `item-${index + 1}`;
  const message =
    typeof issue.message === 'string' && issue.message.trim() ? issue.message : formatSummaryValue(issue);
  const meta = Object.entries(issue)
    .filter(([key]) => !['severity', 'code', 'message'].includes(key))
    .map(([key, value]) => [formatSummaryKey(key), formatSummaryValue(value)] as [string, string]);

  return {
    code,
    message,
    meta,
    raw,
    severity,
  };
}

function stringifyJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
