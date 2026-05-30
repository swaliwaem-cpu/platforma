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
  SquareIcon,
  Trash2Icon,
  UploadIcon,
} from 'lucide-react';
import type {
  DevelopersResponse,
  FeedFormat,
  FeedImportRun,
  FeedImportRunResponse,
  FeedImportRunsResponse,
  FeedSource,
  FeedSourceAnalysis,
  FeedSourceAnalysisObject,
  FeedSourceAnalysisResponse,
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
import {
  findFeedDeveloperSuggestion,
  findFeedObjectSuggestion,
} from './feedSourceMatching';

type FeedsAdminPageProps = {
  pathname: string;
  navigate: (nextPathname: string) => void;
  onBack: () => void;
};

type SourceFormState = {
  sourceKind: FeedSourceKind;
  url: string;
  xmlFile: File | null;
  format: FeedFormatChoice;
  filterJson: string;
  developerId: string;
  objectId: string;
  mappings: SourceMappingFormState[];
  isActive: boolean;
};

type SourceMappingFormState = {
  sourceKey: string;
  sourceTitle: string;
  filterJson: Record<string, string[]>;
  objectId: string;
};

type FeedCommandMode = 'preview' | 'run';
type FeedFormatChoice = FeedFormat | 'AUTO';
type FeedSourceMetaSummaryMap = Record<string, Record<string, unknown>>;

type FeedRunProgress = {
  stage: string;
  unitsTotal: number;
  unitsProcessed: number;
  unitsRemaining: number;
};

const sourceListPageSize = 20;
const sourceLookupLimit = 100;
const objectDirectoryPageSize = 100;
const runsPageSize = 10;
const unitsPageSize = 20;
const feedRunPollMs = 2000;

const emptySourceForm: SourceFormState = {
  sourceKind: 'URL',
  url: '',
  xmlFile: null,
  format: 'AUTO',
  filterJson: '',
  developerId: '',
  objectId: '',
  mappings: [],
  isActive: true,
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
  const [sourceAnalysis, setSourceAnalysis] = useState<FeedSourceAnalysis | null>(null);
  const [sourceMetaSummaries, setSourceMetaSummaries] = useState<FeedSourceMetaSummaryMap>({});
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
  const [isDeletingSource, setIsDeletingSource] = useState(false);
  const [isAnalyzingSource, setIsAnalyzingSource] = useState(false);
  const [runningMode, setRunningMode] = useState<FeedCommandMode | null>(null);
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null);
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
  const editorSourceMetaSummary = editorSource ? sourceMetaSummaries[editorSource.id] ?? null : null;
  const selectedSourceMetaSummary = selectedSource ? sourceMetaSummaries[selectedSource.id] ?? null : null;
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
      setSourceAnalysis(null);
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

  useEffect(() => {
    if (!accessToken || !selectedRun || selectedRun.status !== 'PENDING') {
      return;
    }

    let isCancelled = false;
    let didRefreshSettledRun = false;

    const pollSelectedRun = async () => {
      try {
        const data = await apiRequest<FeedImportRunResponse>(`/feeds/runs/${selectedRun.id}`, accessToken);

        if (isCancelled) {
          return;
        }

        setSelectedRun(data.run);
        rememberSourceMetaSummary(data.run);

        if (data.run.status !== 'PENDING' && !didRefreshSettledRun) {
          didRefreshSettledRun = true;
          void refreshAfterRunSettled(data.run);
        }
      } catch (caughtError) {
        if (!isCancelled) {
          setError(caughtError instanceof Error ? caughtError.message : 'Не удалось обновить прогресс фида');
        }
      }
    };

    const intervalId = window.setInterval(() => void pollSelectedRun(), feedRunPollMs);
    void pollSelectedRun();

    return () => {
      isCancelled = true;
      window.clearInterval(intervalId);
    };
  }, [accessToken, selectedRun?.id, selectedRun?.status]);

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

  async function loadSourceForEdit(sourceId: string, options: { loadSourceMeta?: boolean } = {}) {
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
      setSourceAnalysis(null);
      if (options.loadSourceMeta ?? true) {
        void loadLatestSourceMetaRun(source.id);
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось открыть источник фида');
    } finally {
      setIsLoadingSources(false);
      setIsLoadingForm(false);
    }
  }

  async function loadLatestSourceMetaRun(sourceId: string) {
    if (!accessToken) {
      return;
    }

    setIsLoadingRuns(true);

    try {
      const params = new URLSearchParams({
        page: '1',
        limit: '20',
      });
      const data = await apiRequest<FeedImportRunsResponse>(`/feeds/sources/${sourceId}/runs?${params.toString()}`, accessToken);

      rememberSourceMetaSummaryFromRuns(sourceId, data.items);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить последние данные фида');
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

      rememberSourceMetaSummaryFromRuns(sourceId, data.items);
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

  async function handleDeleteSource(sourceId: string) {
    if (!accessToken) {
      return;
    }

    const confirmed = window.confirm('Удалить фид? Объекты и лоты останутся без изменений.');

    if (!confirmed) {
      return;
    }

    setIsDeletingSource(true);
    setError(null);
    setNotice(null);

    try {
      await apiRequest<void>(`/feeds/sources/${sourceId}`, accessToken, {
        method: 'DELETE',
      });

      setSources((currentSources) => currentSources.filter((source) => source.id !== sourceId));
      setSelectedSourceId((currentSourceId) => (currentSourceId === sourceId ? null : currentSourceId));
      setSelectedRun(null);
      setRuns([]);
      setUnits([]);
      setSourceAnalysis(null);
      setNotice('Фид удалён');
      navigate('/admin/feeds');
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось удалить фид');
    } finally {
      setIsDeletingSource(false);
    }
  }

  async function analyzeSourceFeed() {
    if (!accessToken) {
      return;
    }

    const validationError = validateSourceAnalysisForm(form);

    if (validationError) {
      setError(validationError);
      setNotice(null);
      return;
    }

    setIsAnalyzingSource(true);
    setError(null);
    setNotice(null);

    try {
      let data: FeedSourceAnalysisResponse | null = null;
      let resolvedAnalysisForm: SourceFormState | null = null;
      let lastAnalysisError: unknown = null;

      for (const analysisAttemptForm of createSourceAnalysisFormAttempts(form)) {
        try {
          data = await apiRequest<FeedSourceAnalysisResponse>('/feeds/analyze', accessToken, {
            method: 'POST',
            body: createSourceAnalysisRequestBody(analysisAttemptForm),
          });
          resolvedAnalysisForm = analysisAttemptForm;
          break;
        } catch (caughtError) {
          lastAnalysisError = caughtError;
        }
      }

      if (!data || !resolvedAnalysisForm) {
        throw lastAnalysisError instanceof Error ? lastAnalysisError : new Error('Не удалось разобрать фид');
      }

      if (!data.analysis) {
        throw new Error('Разбор фида не вернул объекты');
      }

      const analysis = data.analysis;
      const suggestedDeveloperId = findFeedDeveloperSuggestion(analysis, developers, objects);

      setSourceAnalysis(analysis);
      setForm((currentForm) => {
        const developerId = currentForm.developerId || suggestedDeveloperId;
        const initialObjectOptions = developerId
          ? objects.filter((object) => object.developer?.id === developerId)
          : objects;
        const initialMappings = createSourceMappingsFromAnalysis(
          analysis,
          currentForm.mappings,
          initialObjectOptions,
        );
        const mappedDeveloperId = findMappedDeveloperSuggestion(initialMappings, objects);
        const mappings = developerId || !mappedDeveloperId
          ? initialMappings
          : createSourceMappingsFromAnalysis(
              analysis,
              initialMappings,
              objects.filter((object) => object.developer?.id === mappedDeveloperId),
            );

        return {
          ...currentForm,
          sourceKind: resolvedAnalysisForm.sourceKind,
          format: analysis.format,
          developerId: developerId || mappedDeveloperId,
          objectId: mappings.length > 0 ? '' : currentForm.objectId,
          mappings,
        };
      });
      setNotice(`Фид разобран: ${analysis.objects.length} объектов, ${analysis.unitsCount} лотов`);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось разобрать фид');
    } finally {
      setIsAnalyzingSource(false);
    }
  }

  function updateAnalysisMapping(sourceKey: string, objectId: string) {
    setForm((currentForm) => ({
      ...currentForm,
      mappings: currentForm.mappings.map((mapping) =>
        mapping.sourceKey === sourceKey ? { ...mapping, objectId } : mapping,
      ),
    }));
    setError(null);
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
      rememberSourceMetaSummary(data.run);
      setNotice(getFeedCommandNotice(mode, data.run.status));

      if (isListRoute) {
        await Promise.all([loadSources(), loadSourceRuns(sourceId), loadUnits(sourceId)]);
      } else if (editSourceId) {
        if (mode === 'preview') {
          await loadSourceForEdit(editSourceId);
        } else if (data.run.status !== 'PENDING') {
          await loadSourceForEdit(editSourceId, { loadSourceMeta: false });
          setSelectedRun(data.run);
        }
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Команда фида не выполнена');
    } finally {
      setRunningMode(null);
    }
  }

  async function stopSelectedRun() {
    if (!accessToken || !selectedRun || selectedRun.mode !== 'RUN' || selectedRun.status !== 'PENDING') {
      return;
    }

    const confirmed = window.confirm('Остановить загрузку фида?');

    if (!confirmed) {
      return;
    }

    setStoppingRunId(selectedRun.id);
    setError(null);
    setNotice(null);

    try {
      const data = await apiRequest<FeedImportRunResponse>(`/feeds/runs/${selectedRun.id}/stop`, accessToken, {
        method: 'POST',
      });

      setSelectedRun(data.run);
      rememberSourceMetaSummary(data.run);
      setNotice('Загрузка фида остановлена');
      await Promise.all([loadSources(), loadSourceRuns(data.run.sourceId), loadUnits(data.run.sourceId)]);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Загрузка фида не остановлена');
    } finally {
      setStoppingRunId(null);
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
      rememberSourceMetaSummary(data.run);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось открыть отчёт фида');
    }
  }

  async function refreshAfterRunSettled(run: FeedImportRun) {
    rememberSourceMetaSummary(run);

    if (isListRoute) {
      await Promise.all([loadSources(), loadSourceRuns(run.sourceId), loadUnits(run.sourceId)]);
      setSelectedRun(run);
      return;
    }

    if (editSourceId) {
      await loadSourceForEdit(editSourceId, { loadSourceMeta: false });
      setSelectedRun(run);
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

  function rememberSourceMetaSummary(run: FeedImportRun | null | undefined) {
    if (!run) {
      return;
    }

    const summary = getFeedSourceMetaSummaryFromRun(run);

    if (!summary) {
      return;
    }

    setSourceMetaSummaries((currentSummaries) =>
      currentSummaries[run.sourceId] === summary
        ? currentSummaries
        : {
            ...currentSummaries,
            [run.sourceId]: summary,
          },
    );
  }

  function rememberSourceMetaSummaryFromRuns(sourceId: string, sourceRuns: FeedImportRun[]) {
    const summary = getLatestFeedSourceMetaSummary(sourceRuns);

    if (!summary) {
      return;
    }

    setSourceMetaSummaries((currentSummaries) =>
      currentSummaries[sourceId] === summary
        ? currentSummaries
        : {
            ...currentSummaries,
            [sourceId]: summary,
          },
    );
  }

  if (isFormRoute) {
    const editorTitle = isCreateRoute ? 'Новый источник фида' : 'Редактирование фида';
    const isFormDisabled = isLoadingDirectories || isLoadingForm || isSubmitting || isDeletingSource;
    const isRunning = runningMode !== null;
    const hasFilterJson = form.filterJson.trim().length > 0;

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
              </>
            ) : null}
            <AdminButton disabled={isSubmitting || isDeletingSource || isRunning} tone="secondary" type="button" onClick={() => navigate('/admin/feeds')}>
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
            {editorSource ? (
              <AdminButton
                disabled={isFormDisabled || !canManage || isRunning}
                title={canManage ? undefined : 'Нет права feeds:manage'}
                tone="danger"
                type="button"
                onClick={() => void handleDeleteSource(editorSource.id)}
              >
                <Trash2Icon data-icon="inline-start" />
                {isDeletingSource ? 'Удаление' : 'Удалить фид'}
              </AdminButton>
            ) : null}
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
                  <label className="field-wide feed-source-input-field">
                    Источник
                    <div className="feed-source-input-row">
                      <input
                        key="feed-source-input"
                        inputMode="url"
                        name="feedSourceInput"
                        placeholder="https://example.com/feed.xml или https://example.com/xml/"
                        type="text"
                        value={form.url}
                        onChange={(event) => {
                          setSourceAnalysis(null);
                          setForm((currentForm) => ({
                            ...currentForm,
                            sourceKind: 'URL',
                            url: event.target.value,
                            xmlFile: null,
                            mappings: [],
                          }));
                        }}
                      />
                      <label className="feed-source-upload-button" title="Загрузить XML-файл" aria-label="Загрузить XML-файл">
                        <UploadIcon aria-hidden="true" size={18} />
                        <input
                          key="feed-source-file-input"
                          accept=".xml,application/xml,text/xml"
                          className="feed-source-file-input"
                          name="xmlFile"
                          type="file"
                          onChange={(event) => {
                            const xmlFile = event.target.files?.[0] ?? null;

                            if (!xmlFile) {
                              return;
                            }

                            setSourceAnalysis(null);
                            setForm((currentForm) => ({
                              ...currentForm,
                              sourceKind: 'FILE',
                              url: '',
                              xmlFile,
                              mappings: [],
                            }));
                          }}
                        />
                      </label>
                    </div>
                    {getSelectedFeedXmlFileName(form, editorSource) ? (
                      <span className="feed-source-file-current">{getSelectedFeedXmlFileName(form, editorSource)}</span>
                    ) : null}
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

                  <FeedSourceAnalysisPanel
                    analysis={sourceAnalysis}
                    mappingValues={form.mappings}
                    selectedDeveloper={developers.find((developer) => developer.id === form.developerId) ?? null}
                    objectOptions={filteredObjects}
                    isObjectSelectDisabled={!form.developerId}
                    isLoading={isAnalyzingSource}
                    onAnalyze={() => void analyzeSourceFeed()}
                    onMappingChange={updateAnalysisMapping}
                  />

                  {hasFilterJson ? (
                    <details className="field-wide feed-source-filter-json" open>
                      <summary>Фильтр Yandex</summary>
                      <label className="feed-source-filter-json-field">
                        JSON
                        <textarea
                          name="filterJson"
                          placeholder={`{
  "buildingNames": ["Нагатино Ай-Лэнд"],
  "yandexBuildingIds": ["2133018"],
  "yandexHouseIds": ["2923598"],
  "avitoDevelopmentIds": ["8605163"],
  "feedIndexSourceUrls": ["https://example.com/feed.xml"],
  "addressIncludes": ["пр-кт Андропова"]
}`}
                          rows={7}
                          spellCheck={false}
                          value={form.filterJson}
                          onChange={(event) =>
                            setForm((currentForm) => ({ ...currentForm, filterJson: event.target.value }))
                          }
                        />
                      </label>
                      <div className="feed-source-filter-json-footer">
                        <span className="feed-source-file-current">
                          buildingNames, yandexBuildingIds, yandexHouseIds, avitoDevelopmentIds, feedIndexSourceUrls, addressIncludes
                        </span>
                        <AdminButton
                          tone="text"
                          type="button"
                          onClick={() => setForm((currentForm) => ({ ...currentForm, filterJson: '' }))}
                        >
                          Очистить фильтр
                        </AdminButton>
                      </div>
                    </details>
                  ) : null}

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
                            mappings: currentForm.mappings.map((mapping) => {
                              const selectedMappingObjectMatchesDeveloper = objects.some(
                                (object) => object.id === mapping.objectId && object.developer?.id === developerId,
                              );

                              return selectedMappingObjectMatchesDeveloper ? mapping : { ...mapping, objectId: '' };
                            }),
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

              {editorSource ? (
                <>
                  <SourceMeta source={editorSource} metaSummary={editorSourceMetaSummary} />
                </>
              ) : null}
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
        <div className="feeds-primary-column">
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
                    <TableHead>Статус</TableHead>
                    <TableHead>Последний запуск</TableHead>
                    <TableHead>
                      <span className="sr-only">Действия</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoadingSources ? <TableSkeleton columns={4} rows={4} /> : null}

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
                              <strong>{getSourceObjectTitle(source)}</strong>
                              <span>{source.developer.name}</span>
                              <code>{getSourceDisplay(source)}</code>
                            </div>
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

          <SourceRunControlPanel
            canRun={canRun}
            runningMode={runningMode}
            selectedRun={selectedRun}
            source={selectedSource}
            stoppingRunId={stoppingRunId}
            onPreview={() => (selectedSource ? void runSourceCommand(selectedSource.id, 'preview') : undefined)}
            onRun={() => (selectedSource ? void runSourceCommand(selectedSource.id, 'run') : undefined)}
            onStop={() => void stopSelectedRun()}
          />

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
        </div>

        <AdminPanel className="editor-panel feed-source-side-panel" role="region" aria-label="Действия источника">
          {selectedSource ? (
            <>
              <div className="feed-panel-heading">
                <div>
                  <h3>{getSourceObjectTitle(selectedSource)}</h3>
                </div>
                <AdminStatusBadge className={selectedSource.isActive ? 'feed-source-status--active' : 'feed-source-status--inactive'}>
                  {selectedSource.isActive ? 'Active' : 'Off'}
                </AdminStatusBadge>
              </div>

              <SourceMeta source={selectedSource} metaSummary={selectedSourceMetaSummary} />

              <div className="feed-command-actions">
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
                <TableHead>Цена за м²</TableHead>
                <TableHead>Площадь</TableHead>
                <TableHead>Комнаты/тип</TableHead>
                <TableHead>Этаж</TableHead>
                <TableHead>Корпус/секция</TableHead>
                <TableHead>Медиа</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoadingUnits ? <TableSkeleton columns={10} rows={4} /> : null}

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
                      <TableCell>{formatFeedUnitPricePerMeter(unit)}</TableCell>
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
                  <TableCell colSpan={10}>
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

function SourceRunControlPanel({
  source,
  selectedRun,
  canRun,
  runningMode,
  stoppingRunId,
  onPreview,
  onRun,
  onStop,
}: {
  source: FeedSource | null;
  selectedRun: FeedImportRun | null;
  canRun: boolean;
  runningMode: FeedCommandMode | null;
  stoppingRunId: string | null;
  onPreview: () => void;
  onRun: () => void;
  onStop: () => void;
}) {
  const progress = source ? getFeedRunProgress(selectedRun, source.id) : null;
  const canStopRun = Boolean(
    source && selectedRun?.sourceId === source.id && selectedRun.mode === 'RUN' && selectedRun.status === 'PENDING',
  );
  const isCommandDisabled = !source || !canRun || runningMode !== null || canStopRun || stoppingRunId !== null;
  const isStopDisabled = !canRun || !canStopRun || stoppingRunId !== null || runningMode !== null;

  return (
    <AdminPanel className="feed-source-run-panel" role="region" aria-label="Запуск выбранного фида">
      <div className="feed-source-run-header">
        <div>
          <p className="eyebrow">Запуск</p>
          <h3>{source ? getSourceObjectTitle(source) : 'Источник не выбран'}</h3>
        </div>

        <div className="feed-source-run-actions">
          <AdminButton
            disabled={isCommandDisabled}
            title={canRun ? undefined : 'Нет права feeds:run'}
            tone="secondary"
            type="button"
            onClick={onPreview}
          >
            <EyeIcon data-icon="inline-start" />
            {runningMode === 'preview' ? 'Preview...' : 'Preview'}
          </AdminButton>
          <AdminButton
            disabled={isCommandDisabled}
            title={canRun ? undefined : 'Нет права feeds:run'}
            tone="primary"
            type="button"
            onClick={onRun}
          >
            <PlayIcon data-icon="inline-start" />
            {runningMode === 'run' ? 'Run...' : 'Run'}
          </AdminButton>
          <AdminButton
            disabled={isStopDisabled}
            title={canRun ? undefined : 'Нет права feeds:run'}
            tone="danger"
            type="button"
            onClick={onStop}
          >
            <SquareIcon data-icon="inline-start" />
            {stoppingRunId ? 'Stop...' : 'Stop'}
          </AdminButton>
        </div>
      </div>

      {source ? (
        <FeedRunProgressCard run={selectedRun} progress={progress} />
      ) : (
        <AdminEmptyState title="Источник не выбран" description="Выберите строку фида для запуска Preview или Run." />
      )}
    </AdminPanel>
  );
}

function FeedRunProgressCard({ run, progress }: { run: FeedImportRun | null; progress: FeedRunProgress | null }) {
  const progressPercent = progress ? getFeedRunProgressPercent(progress) : 0;
  const progressStageLabel = progress ? getFeedRunProgressStageLabel(progress.stage) : 'Ожидает запуска Run';

  return (
    <section className="feed-run-progress-card" aria-live="polite">
      <div className="feed-run-progress-heading">
        <div>
          <h4>Импорт фида</h4>
          <p>{progressStageLabel}</p>
        </div>
        <strong>{formatNumber(progressPercent)}%</strong>
      </div>

      <div
        aria-label="Прогресс импорта фида"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={progressPercent}
        className="feed-run-progress-track"
        role="progressbar"
      >
        <span className="feed-run-progress-fill" style={{ width: `${progressPercent}%` }} />
      </div>

      <div className="feed-run-progress-stats">
        <div>
          <span>Объекты</span>
          <strong>
            {progress ? `${formatNumber(progress.unitsProcessed)} / ${formatNumber(progress.unitsTotal)}` : 'нет данных'}
          </strong>
        </div>
        <div>
          <span>Осталось</span>
          <strong>{progress ? formatNumber(progress.unitsRemaining) : 'нет данных'}</strong>
        </div>
        <div>
          <span>Осталось мин:</span>
          <strong>{run && progress ? formatRemainingProgressMinutes(run, progress) : 'нет данных'}</strong>
        </div>
      </div>
    </section>
  );
}

function FeedSourceAnalysisPanel({
  analysis,
  mappingValues,
  selectedDeveloper,
  objectOptions,
  isObjectSelectDisabled,
  isLoading,
  onAnalyze,
  onMappingChange,
}: {
  analysis: FeedSourceAnalysis | null;
  mappingValues: SourceMappingFormState[];
  selectedDeveloper: ObjectDeveloper | null;
  objectOptions: RealEstateObjectSummary[];
  isObjectSelectDisabled: boolean;
  isLoading: boolean;
  onAnalyze: () => void;
  onMappingChange: (sourceKey: string, objectId: string) => void;
}) {
  const analysisDeveloperName = analysis?.developerName ?? selectedDeveloper?.name ?? null;

  return (
    <section className="field-wide feed-source-analysis" aria-label="Разбор фида">
      <div className="feed-source-analysis-header">
        <div>
          <strong>Разбор фида</strong>
          <span>
            {analysis
              ? `${analysisDeveloperName ?? 'Застройщик не указан'} · ${formatNumber(analysis.unitsCount)} лотов`
              : 'Застройщик, объекты и количество лотов появятся после разбора'}
          </span>
        </div>
        <AdminButton disabled={isLoading} tone="secondary" type="button" onClick={onAnalyze}>
          <RefreshCwIcon data-icon="inline-start" />
          {isLoading ? 'Разбираем...' : 'Разобрать'}
        </AdminButton>
      </div>

      {analysis ? (
        <>
          <dl className="feed-source-analysis-summary">
            <div>
              <dt>Застройщик</dt>
              <dd>{analysisDeveloperName ?? 'не указан'}</dd>
            </div>
            <div>
              <dt>Объектов</dt>
              <dd>{formatNumber(analysis.objects.length)}</dd>
            </div>
            <div>
              <dt>Лотов</dt>
              <dd>{formatNumber(analysis.unitsCount)}</dd>
            </div>
            <div>
              <dt>Предупреждения</dt>
              <dd>{formatNumber(analysis.warningsCount)}</dd>
            </div>
          </dl>

          <div className="feed-source-analysis-list">
            {analysis.objects.map((feedObject) => {
              const sourceKey = createFeedAnalysisObjectKey(feedObject);
              const mapping = mappingValues.find((currentMapping) => currentMapping.sourceKey === sourceKey);

              return (
                <article className="feed-source-analysis-object" key={sourceKey}>
                  <div className="feed-source-analysis-object-main">
                    <strong>{feedObject.title}</strong>
                    <span>{formatNumber(feedObject.unitsCount)} лотов</span>
                    <code>{formatFeedAnalysisObjectMeta(feedObject)}</code>
                  </div>
                  <label className="feed-source-analysis-mapping">
                    Связанный ЖК
                    <select
                      aria-label={`Связанный ЖК для ${feedObject.title}`}
                      disabled={isObjectSelectDisabled || !feedObject.filterJson}
                      value={mapping?.objectId ?? ''}
                      onChange={(event) => onMappingChange(sourceKey, event.target.value)}
                    >
                      <option value="">Исключить из загрузки</option>
                      {objectOptions.map((object) => (
                        <option key={object.id} value={object.id}>
                          {object.title}
                        </option>
                      ))}
                    </select>
                  </label>
                </article>
              );
            })}
          </div>
        </>
      ) : null}
    </section>
  );
}

function SourceMeta({ source, metaSummary }: { source: FeedSource; metaSummary?: Record<string, unknown> | null }) {
  const previewMetrics = getFeedPreviewMetrics(metaSummary);

  return (
    <dl className="details-list feed-details">
      <div>
        <dt>Застройщик</dt>
        <dd>{source.developer.name}</dd>
      </div>
      <div>
        <dt>ЖК</dt>
        <dd>{getSourceObjectTitle(source)}</dd>
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
        <dt>Новые лоты</dt>
        <dd>{formatOptionalNumber(previewMetrics.unitsCreated)}</dd>
      </div>
      <div>
        <dt>Обновятся</dt>
        <dd>{formatOptionalNumber(previewMetrics.unitsUpdated)}</dd>
      </div>
      <div>
        <dt>В архив</dt>
        <dd>{formatOptionalNumber(previewMetrics.unitsArchived)}</dd>
      </div>
      <div>
        <dt>Медиа к загрузке</dt>
        <dd>{formatOptionalNumber(previewMetrics.mediaCount)}</dd>
      </div>
      <div>
        <dt>Новые медиа</dt>
        <dd>{formatOptionalNumber(previewMetrics.mediaCreated)}</dd>
      </div>
      <div>
        <dt>Медиа уже есть</dt>
        <dd>{formatOptionalNumber(previewMetrics.mediaExisting)}</dd>
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

function createFormFromSource(source: FeedSource): SourceFormState {
  return {
    sourceKind: source.sourceKind,
    url: source.url ?? '',
    xmlFile: null,
    format: source.format,
    filterJson: formatFilterJsonForForm(source.filterJson),
    developerId: source.developerId,
    objectId: source.objectId ?? '',
    mappings: source.mappings.map((mapping) => ({
      sourceKey: mapping.sourceKey,
      sourceTitle: mapping.sourceTitle,
      filterJson: formatMappingFilterJsonForForm(mapping.filterJson),
      objectId: mapping.objectId,
    })),
    isActive: source.isActive,
  };
}

function validateSourceForm(form: SourceFormState, existingSource?: FeedSource | null) {
  const sourceKind = getConcreteFeedSourceKind(form);

  if (isUrlBackedSourceKind(sourceKind) && !form.url.trim()) {
    return 'Укажите URL фида';
  }

  if (sourceKind === 'FILE' && !form.xmlFile && existingSource?.sourceKind !== 'FILE') {
    return 'Выберите XML-файл фида';
  }

  if (form.format === 'AUTO') {
    return 'Сначала запустите разбор фида, чтобы формат определился автоматически';
  }

  if (!form.developerId) {
    return 'Выберите застройщика';
  }

  if (!form.objectId && getSelectedSourceMappings(form).length === 0) {
    return 'Выберите связанный ЖК или сопоставьте хотя бы один объект фида';
  }

  if (form.filterJson.trim()) {
    try {
      const parsedFilter = JSON.parse(form.filterJson);

      if (!isPlainObject(parsedFilter)) {
        return 'Фильтр Yandex должен быть JSON-объектом';
      }
    } catch {
      return 'Фильтр Yandex должен быть валидным JSON';
    }
  }

  return null;
}

function validateSourceAnalysisForm(form: SourceFormState) {
  const sourceKind = getConcreteFeedSourceKind(form);

  if (isUrlBackedSourceKind(sourceKind) && !form.url.trim()) {
    return 'Укажите URL фида';
  }

  if (sourceKind === 'FILE' && !form.xmlFile) {
    return 'Выберите XML-файл фида для разбора';
  }

  return null;
}

function createSourceRequestBody(form: SourceFormState) {
  const formData = new FormData();
  const selectedMappings = getSelectedSourceMappings(form);
  const objectId = selectedMappings.length > 0 ? '' : form.objectId;
  const sourceKind = getConcreteFeedSourceKind(form);

  formData.append('sourceKind', sourceKind);
  formData.append('format', getConcreteFeedFormat(form.format));
  formData.append('filterJson', form.filterJson.trim());
  formData.append('developerId', form.developerId);
  formData.append('objectId', objectId);
  formData.append('mappings', JSON.stringify(selectedMappings));
  formData.append('isActive', String(form.isActive));

  if (isUrlBackedSourceKind(sourceKind)) {
    formData.append('url', form.url.trim());
  }

  if (sourceKind === 'FILE' && form.xmlFile) {
    formData.append('xmlFile', form.xmlFile);
  }

  return formData;
}

function createSourceAnalysisRequestBody(form: SourceFormState) {
  const formData = new FormData();
  const sourceKind = getConcreteFeedSourceKind(form);

  formData.append('sourceKind', sourceKind);
  formData.append('format', 'AUTO');

  if (isUrlBackedSourceKind(sourceKind)) {
    formData.append('url', form.url.trim());
  }

  if (sourceKind === 'FILE' && form.xmlFile) {
    formData.append('xmlFile', form.xmlFile);
  }

  return formData;
}

function createSourceAnalysisFormAttempts(form: SourceFormState): SourceFormState[] {
  const sourceKind = getConcreteFeedSourceKind(form);

  if (sourceKind === 'FILE') {
    return [{ ...form, sourceKind }];
  }

  return [
    { ...form, sourceKind: 'URL' },
    { ...form, sourceKind: 'INDEX_URL' },
  ];
}

function getConcreteFeedSourceKind(form: SourceFormState): FeedSourceKind {
  return form.xmlFile ? 'FILE' : form.sourceKind;
}

function getConcreteFeedFormat(format: FeedFormatChoice): FeedFormat {
  if (format === 'AUTO') {
    throw new Error('Feed format AUTO cannot be saved');
  }

  return format;
}

function isUrlBackedSourceKind(sourceKind: FeedSourceKind) {
  return sourceKind === 'URL' || sourceKind === 'INDEX_URL';
}

function getSelectedFeedXmlFileName(form: SourceFormState, source?: FeedSource | null) {
  if (form.xmlFile) {
    return form.xmlFile.name;
  }

  if (form.sourceKind === 'FILE' && source?.xmlFile) {
    return source.xmlFile.originalName ?? source.xmlFile.key;
  }

  return '';
}

function createSourceMappingsFromAnalysis(
  analysis: FeedSourceAnalysis,
  currentMappings: SourceMappingFormState[],
  objectOptions: RealEstateObjectSummary[],
): SourceMappingFormState[] {
  return analysis.objects
    .filter((feedObject) => feedObject.filterJson)
    .map((feedObject) => {
      const sourceKey = createFeedAnalysisObjectKey(feedObject);
      const currentMapping = currentMappings.find((mapping) => mapping.sourceKey === sourceKey);

      return {
        sourceKey,
        sourceTitle: feedObject.title,
        filterJson: feedObject.filterJson ?? {},
        objectId: findFeedObjectSuggestion(feedObject, objectOptions, currentMapping?.objectId),
      };
    });
}

function findMappedDeveloperSuggestion(
  mappings: SourceMappingFormState[],
  objects: RealEstateObjectSummary[],
) {
  const objectById = new Map<string, RealEstateObjectSummary>();

  for (const object of objects) {
    objectById.set(object.id, object);
  }

  const developerIds = new Set(
    mappings
      .map((mapping) => objectById.get(mapping.objectId)?.developer?.id)
      .filter((developerId): developerId is string => Boolean(developerId)),
  );

  return developerIds.size === 1 ? [...developerIds][0] ?? '' : '';
}

function getSelectedSourceMappings(form: SourceFormState) {
  return form.mappings
    .filter((mapping) => mapping.objectId)
    .map((mapping) => ({
      sourceKey: mapping.sourceKey,
      sourceTitle: mapping.sourceTitle,
      objectId: mapping.objectId,
      filterJson: mapping.filterJson,
      isActive: true,
    }));
}

function formatMappingFilterJsonForForm(value: JsonValue): Record<string, string[]> {
  if (!isPlainObject(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, JsonValue[]] => Array.isArray(entry[1]))
      .map(([key, items]) => [
        key,
        items.map((item) => (typeof item === 'string' ? item : String(item))).filter((item) => item.length > 0),
      ]),
  );
}

function formatFilterJsonForForm(value: JsonValue | null) {
  if (!isPlainObject(value)) {
    return '';
  }

  return JSON.stringify(value, null, 2);
}

function getSourceDisplay(source: FeedSource) {
  if (source.sourceKind === 'FILE') {
    return source.xmlFile?.originalName ?? source.xmlFile?.key ?? 'XML-файл';
  }

  return source.url ?? 'URL не указан';
}

function getSourceObjectTitle(source: FeedSource) {
  if (source.mappings.length > 0) {
    const firstMapping = source.mappings[0];

    return source.mappings.length === 1 && firstMapping
      ? firstMapping.object.title
      : `${source.mappings.length} ЖК в сопоставлении`;
  }

  return source.object?.title ?? 'ЖК не выбран';
}

function createFeedAnalysisObjectKey(feedObject: FeedSourceAnalysisObject) {
  const useExternalIds = shouldUseFeedAnalysisExternalIds(feedObject);
  const rawKey = [
    feedObject.title,
    feedObject.feedIndexSourceUrls.join('|'),
    feedObject.projectNames.join('|'),
    useExternalIds ? feedObject.externalIds.join('|') : '',
    feedObject.buildingNames.join('|'),
    feedObject.yandexBuildingIds.join('|'),
    feedObject.yandexHouseIds.join('|'),
    feedObject.avitoDevelopmentIds.join('|'),
    feedObject.addresses.join('|'),
  ].join(':');

  return `feed-${hashText(rawKey)}`;
}

function hashText(value: string) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash, 31) + value.charCodeAt(index);
  }

  return (hash >>> 0).toString(36);
}

function formatFeedAnalysisObjectMeta(feedObject: FeedSourceAnalysisObject) {
  const useExternalIds = shouldUseFeedAnalysisExternalIds(feedObject);
  const parts = [
    feedObject.feedIndexSourceUrls.length > 0 ? `sheetUrls: ${feedObject.feedIndexSourceUrls.length}` : null,
    feedObject.projectNames.length > 0 ? `projectNames: ${feedObject.projectNames.join(', ')}` : null,
    useExternalIds && feedObject.externalIds.length > 0 ? `externalIds: ${feedObject.externalIds.join(', ')}` : null,
    feedObject.buildingNames.length > 0 ? `buildingNames: ${feedObject.buildingNames.join(', ')}` : null,
    feedObject.yandexBuildingIds.length > 0 ? `buildingIds: ${feedObject.yandexBuildingIds.join(', ')}` : null,
    feedObject.yandexHouseIds.length > 0 ? `houseIds: ${feedObject.yandexHouseIds.join(', ')}` : null,
    feedObject.avitoDevelopmentIds.length > 0 ? `developmentIds: ${feedObject.avitoDevelopmentIds.join(', ')}` : null,
    feedObject.addresses.length > 0 ? `addresses: ${feedObject.addresses.join(' / ')}` : null,
  ].filter((part): part is string => part !== null);

  return parts.join(' · ') || 'нет фильтрующих полей';
}

function shouldUseFeedAnalysisExternalIds(feedObject: FeedSourceAnalysisObject) {
  return (
    feedObject.projectNames.length === 0 &&
    feedObject.feedIndexSourceUrls.length === 0 &&
    feedObject.buildingNames.length === 0 &&
    feedObject.yandexBuildingIds.length === 0 &&
    feedObject.yandexHouseIds.length === 0 &&
    feedObject.avitoDevelopmentIds.length === 0 &&
    feedObject.addresses.length === 0
  );
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
  const unitsCreated = toPreviewMetricNumber(summary?.created);
  const unitsUpdated = toPreviewMetricNumber(summary?.updated);
  const unitsArchived = toPreviewMetricNumber(summary?.archived);
  const mediaCreated = media ? media.created : null;
  const mediaExisting = media ? media.existing : null;
  const mediaUnique = media ? media.unique : null;
  const mediaCount = toPreviewMetricNumber(mediaUnique) ?? toPreviewMetricNumber(mediaCreated);

  return {
    unitsCount,
    unitsCreated,
    unitsUpdated,
    unitsArchived,
    mediaCount,
    mediaCreated: toPreviewMetricNumber(mediaCreated),
    mediaExisting: toPreviewMetricNumber(mediaExisting),
  };
}

function getLatestFeedSourceMetaSummary(sourceRuns: FeedImportRun[]) {
  for (const run of sourceRuns) {
    const summary = getFeedSourceMetaSummaryFromRun(run);

    if (summary) {
      return summary;
    }
  }

  return null;
}

function getFeedSourceMetaSummaryFromRun(run: FeedImportRun) {
  const summary = isPlainObject(run.summaryJson) ? run.summaryJson : null;

  return hasFeedMetaMetrics(summary) ? summary : null;
}

function hasFeedMetaMetrics(summary: Record<string, unknown> | null | undefined) {
  if (!summary) {
    return false;
  }

  const metrics = getFeedPreviewMetrics(summary);

  return Object.values(metrics).some((value) => value !== null);
}

function getFeedRunProgress(run: FeedImportRun | null, sourceId: string) {
  if (!run || run.sourceId !== sourceId || run.mode !== 'RUN') {
    return null;
  }

  const summary = isPlainObject(run.summaryJson) ? run.summaryJson : null;
  const progress = isPlainObject(summary?.progress) ? summary.progress : null;

  if (!progress) {
    return null;
  }

  const unitsTotal = toProgressMetricNumber(progress.unitsTotal);
  const unitsProcessed = toProgressMetricNumber(progress.unitsProcessed);
  const unitsRemaining = toProgressMetricNumber(progress.unitsRemaining);

  if (unitsTotal === null || unitsProcessed === null || unitsRemaining === null) {
    return null;
  }

  return {
    stage: typeof progress.stage === 'string' ? progress.stage : 'PROCESSING_UNITS',
    unitsTotal,
    unitsProcessed,
    unitsRemaining,
  };
}

function getFeedRunProgressPercent(progress: FeedRunProgress) {
  if (progress.unitsTotal <= 0) {
    return 0;
  }

  return clampProgressPercent(Math.round((progress.unitsProcessed / progress.unitsTotal) * 100));
}

function formatRemainingProgressMinutes(run: FeedImportRun, progress: FeedRunProgress) {
  if (progress.unitsRemaining <= 0) {
    return '0';
  }

  if (progress.unitsProcessed <= 0) {
    return 'считается';
  }

  const startedAt = new Date(run.startedAt).getTime();
  const elapsedMs = Date.now() - startedAt;

  if (!Number.isFinite(startedAt) || !Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return 'считается';
  }

  const remainingMs = (elapsedMs / progress.unitsProcessed) * progress.unitsRemaining;
  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));

  return `~${formatNumber(remainingMinutes)}`;
}

function getFeedRunProgressStageLabel(stage: string) {
  if (stage === 'QUEUED') {
    return 'В очереди на импорт';
  }

  if (stage === 'COMPLETED') {
    return 'Импорт завершён';
  }

  if (stage === 'FAILED') {
    return 'Импорт остановлен с ошибкой';
  }

  if (stage === 'STOPPED') {
    return 'Импорт остановлен';
  }

  if (stage === 'ARCHIVING_UNITS') {
    return 'Архивация отсутствующих лотов';
  }

  if (stage === 'REFRESHING_OBJECT') {
    return 'Обновление данных ЖК';
  }

  return 'Обработка лотов и медиа';
}

function toProgressMetricNumber(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }

  return Math.floor(value);
}

function clampProgressPercent(value: number) {
  return Math.min(Math.max(value, 0), 100);
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

function getFeedCommandNotice(mode: FeedCommandMode, status: ImportStatus) {
  if (mode === 'preview') {
    return 'Preview фида завершён';
  }

  return status === 'PENDING' ? 'Run фида запущен' : 'Run фида завершён';
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

function parseNullableNumber(value: string | null) {
  if (!value) {
    return null;
  }

  const parsedValue = Number(value);

  return Number.isFinite(parsedValue) ? parsedValue : null;
}

function getFeedUnitPricePerMeterValue(unit: FeedUnit) {
  const price = parseNullableNumber(unit.price);
  const area = parseNullableNumber(unit.area);

  if (price !== null && area !== null && area > 0) {
    return price / area;
  }

  return parseNullableNumber(unit.pricePerMeter);
}

function formatFeedUnitPricePerMeter(unit: FeedUnit) {
  const pricePerMeter = getFeedUnitPricePerMeterValue(unit);

  return pricePerMeter === null ? 'Не указана' : formatMoney(String(pricePerMeter), unit.currency);
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
