import {
  AlertCircleIcon,
  ArrowLeftIcon,
  Building2Icon,
  CheckCircle2Icon,
  DownloadIcon,
  EyeIcon,
  FileTextIcon,
  Globe2Icon,
  LoaderCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  SparklesIcon,
  Trash2Icon,
  UploadIcon,
  UsersIcon,
} from 'lucide-react';
import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  AdminAlert,
  AdminButton,
  AdminEmptyState,
  AdminPanel,
  AdminStatusBadge,
} from '../admin/AdminUi';
import { ApiRequestError } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '../components/ui/field';
import { Input } from '../components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table';
import {
  acceptTrainingFactSuggestion,
  attachTrainingLinkedObjectPdfs,
  changeTrainingProjectStatus,
  createTrainingFactSuggestionRun,
  createTrainingOfficialUrlSource,
  createTrainingDraftVersion,
  createTrainingProject,
  deleteTrainingCriterion,
  deleteTrainingDocument,
  deleteTrainingFact,
  deleteTrainingOfficialUrlSource,
  deleteTrainingQuestion,
  downloadTrainingDocument,
  getLatestTrainingFactSuggestionRun,
  getTrainingProjectAssignments,
  getTrainingDocumentText,
  getTrainingOfficialUrlSourceText,
  getTrainingProject,
  getTrainingReadiness,
  listTrainingAssignees,
  listTrainingFactSuggestions,
  listTrainingDocuments,
  listTrainingLinkedObjectPdfs,
  listTrainingOfficialUrlSources,
  listTrainingObjects,
  listTrainingProjects,
  publishTrainingVersion,
  replaceTrainingProjectAssignments,
  rejectTrainingFactSuggestion,
  retryTrainingDocument,
  retryTrainingOfficialUrlSource,
  saveTrainingCriterion,
  saveTrainingFact,
  saveTrainingQuestion,
  type TrainingCriterion,
  type TrainingCriterionAnchor,
  type TrainingDocument,
  type TrainingAssignmentCandidate,
  type TrainingAssignmentSummary,
  type TrainingAudienceMode,
  type TrainingFact,
  type TrainingFactSuggestion,
  type TrainingFactSuggestionRun,
  type TrainingOfficialUrlSource,
  type TrainingLinkedObjectPdf,
  type TrainingProject,
  type TrainingQuestion,
  type TrainingQuestionType,
  type TrainingReadiness,
  type TrainingRealEstateObject,
  type TrainingVersion,
  type TrainingWizardStep,
  updateTrainingDocumentText,
  updateTrainingProjectAudience,
  updateTrainingProject,
  updateTrainingVersion,
  uploadTrainingDocument,
} from './trainingAdminApi';
import { QuestionEvaluationContext } from './QuestionEvaluationContext';
import { TrainingReadinessSummary } from './TrainingReadiness';
import {
  TrainingSearchPicker,
  type TrainingSearchPickerOption,
} from './TrainingSearchPicker';
import {
  trainingWizardSteps,
  TrainingWizardNav,
  type TrainingWizardStepView,
} from './TrainingWizardNav';
import {
  runTrainingUploadQueue,
  type TrainingUploadQueueItem,
} from './trainingUploadQueue';
import './trainingAdmin.css';

type TrainingAdminPageProps = {
  pathname: string;
  navigate: (path: string) => void;
  onBack: () => void;
};

type TrainingMasterItem = {
  id: string;
  label: string;
  description?: string;
  status?: string;
  statusTone?: 'neutral' | 'success' | 'warning';
};

type TrainingMasterGroup = {
  id: string;
  label: string;
  summary?: string;
  items: TrainingMasterItem[];
  action?: (placement: 'desktop' | 'mobile') => ReactNode;
};

type ProjectEditorSection = 'project' | 'availability' | 'attempt';
type TrainingDirtyChangeHandler = (itemId: string, dirty: boolean) => void;

const dirtyItemSeparator = '::';
const trainingHistoryIndexKey = '__trainingEditorHistoryIndex';
const unsavedChangesMessage =
  'Есть несохранённые изменения. Покинуть редактор и потерять их?';

const projectStatusLabels = {
  DRAFT: 'Не опубликован',
  OPEN: 'Открыт',
  CLOSED: 'Закрыт',
  ARCHIVED: 'Архив',
} as const;

const versionStatusLabels = {
  DRAFT: 'Рабочая редакция',
  PUBLISHED: 'Опубликована',
  SUPERSEDED: 'Заменена',
} as const;

const documentStatusLabels = {
  PENDING: 'В очереди',
  PROCESSING: 'Извлечение',
  READY: 'Текст готов',
  NEEDS_MANUAL_TEXT: 'Нужен текст',
  FAILED: 'Ошибка',
} as const;

const suggestionStatusLabels = {
  PENDING: 'Требует проверки',
  ACCEPTED: 'Подтверждён',
  REJECTED: 'Отклонён',
  STALE: 'Устарел',
} as const;

const suggestionRunStatusLabels = {
  PENDING: 'в очереди',
  RUNNING: 'анализируем',
  READY: 'готов',
  PARTIAL: 'готов частично',
  FAILED: 'ошибка',
  AMBIGUOUS: 'нужна проверка',
  DISMISSED: 'отменён',
} as const;

export function TrainingAdminPage({
  pathname,
  navigate,
  onBack,
}: TrainingAdminPageProps) {
  const editorMatch = pathname.match(
    /^\/admin\/training\/([0-9a-f-]+)\/edit(?:\/(main|sources|suggestions|assignments|questions|criteria|review))?\/?$/iu,
  );

  if (pathname === '/admin/training/new') {
    return (
      <TrainingProjectCreatePage
        navigate={navigate}
        onBack={() => navigate('/admin/training')}
      />
    );
  }

  if (editorMatch?.[1]) {
    return (
      <TrainingProjectEditorPage
        projectId={editorMatch[1]}
        initialStep={(editorMatch[2] as TrainingWizardStep | undefined) ?? 'main'}
        navigate={navigate}
        onBack={() => navigate('/admin/training')}
      />
    );
  }

  return (
    <TrainingProjectListPage
      navigate={navigate}
      onBack={onBack}
    />
  );
}

function TrainingProjectListPage({
  navigate,
  onBack,
}: {
  navigate: (path: string) => void;
  onBack: () => void;
}) {
  const { accessToken } = useAuth();
  const [projects, setProjects] = useState<TrainingProject[]>([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    if (!accessToken) return;

    setLoading(true);
    setError(null);
    try {
      const response = await listTrainingProjects(accessToken, {
        search: search.trim() || undefined,
        status: status || undefined,
        limit: 100,
      });
      setProjects(response.items);
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setLoading(false);
    }
  }, [accessToken, search, status]);

  useEffect(() => {
    const timeout = setTimeout(() => void loadProjects(), 180);
    return () => clearTimeout(timeout);
  }, [loadProjects]);

  return (
    <main className="training-admin" data-page="training-project-list">
      <TrainingAdminHeader
        eyebrow="Админка · Обучение"
        title="Проекты обучения"
        description="Рабочие редакции, источники, структура экзамена и готовность к публикации."
        onBack={onBack}
        actions={
          <AdminButton
            tone="primary"
            onClick={() => navigate('/admin/training/new')}
          >
            <PlusIcon aria-hidden="true" />
            Создать проект
          </AdminButton>
        }
      />

      <AdminPanel className="training-toolbar">
        <Field>
          <FieldLabel htmlFor="training-search">Поиск</FieldLabel>
          <Input
            id="training-search"
            value={search}
            placeholder="Название, slug или объект"
            onChange={(event) => setSearch(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="training-status-filter">Статус</FieldLabel>
          <select
            id="training-status-filter"
            className="training-control"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">Все статусы</option>
            {Object.entries(projectStatusLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </AdminPanel>

      {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}

      <AdminPanel className="training-table-panel">
        {loading ? (
          <TrainingLoading label="Загружаем проекты" />
        ) : projects.length === 0 ? (
          <AdminEmptyState
            title="Проекты не найдены"
            description="Измените фильтр или создайте первый проект обучения."
          />
        ) : (
          <Table className="admin-table training-project-table">
            <TableHeader>
              <TableRow>
                <TableHead>Проект</TableHead>
                <TableHead>Объект</TableHead>
                <TableHead>Статус</TableHead>
                <TableHead>Версии</TableHead>
                <TableHead>Попытки</TableHead>
                <TableHead aria-label="Действия" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.map((project) => {
                const draft = project.versions?.find(
                  (version) => version.status === 'DRAFT',
                );
                return (
                  <TableRow key={project.id}>
                    <TableCell>
                      <div className="training-table-title">
                        <strong>{project.title}</strong>
                        <span>/{project.slug}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {project.realEstateObject?.title ?? 'Без связи'}
                    </TableCell>
                    <TableCell>
                      <AdminStatusBadge
                        className={`training-status training-status--${project.status.toLowerCase()}`}
                      >
                        {projectStatusLabels[project.status]}
                      </AdminStatusBadge>
                    </TableCell>
                    <TableCell>
                      {draft
                        ? `Рабочая редакция v${draft.versionNumber}`
                        : project.activeVersion
                          ? `v${project.activeVersion.versionNumber} · опубликована`
                          : 'Нет версии'}
                    </TableCell>
                    <TableCell>{project._count?.attempts ?? 0}</TableCell>
                    <TableCell>
                      <AdminButton
                        tone="text"
                        onClick={() =>
                          navigate(`/admin/training/${project.id}/edit`)
                        }
                      >
                        Редактировать
                      </AdminButton>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </AdminPanel>
    </main>
  );
}

function TrainingProjectCreatePage({
  navigate,
  onBack,
}: {
  navigate: (path: string) => void;
  onBack: () => void;
}) {
  const { accessToken } = useAuth();
  const [objects, setObjects] = useState<TrainingRealEstateObject[]>([]);
  const [form, setForm] = useState(() => createEmptyProjectForm());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!accessToken) return;
    void listTrainingObjects(accessToken, { hasPdf: true, page: 1, limit: 20 })
      .then((response) => setObjects(response.items))
      .catch(() => setObjects([]));
  }, [accessToken]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!accessToken) return;

    const nextErrors = validateProjectForm(form);
    setErrors(nextErrors);
    setServerError(null);
    if (Object.keys(nextErrors).length > 0) return;

    setSaving(true);
    try {
      const response = await createTrainingProject(
        accessToken,
        toCreateProjectInput(form),
      );
      navigate(`/admin/training/${response.project.id}/edit/sources`);
    } catch (caughtError) {
      setServerError(getErrorMessage(caughtError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="training-admin training-admin--editor">
      <TrainingAdminHeader
        eyebrow="Новый проект"
        title="Создание проекта обучения"
        description="Сначала сохраните основные данные, затем мастер проведёт по источникам, фактам, вопросам и проверке."
        onBack={onBack}
      />

      <form onSubmit={(event) => void handleSubmit(event)}>
        <AdminPanel className="training-section-panel">
          {serverError ? <AdminAlert tone="error">{serverError}</AdminAlert> : null}
          <ProjectAndSettingsFields
            token={accessToken ?? ''}
            form={form}
            errors={errors}
            objects={objects}
            initialObject={null}
            disabled={false}
            onChange={setForm}
          />
          <div className="training-form-actions">
            <AdminButton type="button" onClick={onBack}>
              Отмена
            </AdminButton>
            <AdminButton tone="primary" type="submit" disabled={saving}>
              {saving ? (
                <LoaderCircleIcon className="training-spin" aria-hidden="true" />
              ) : (
                <SaveIcon aria-hidden="true" />
              )}
              Создать проект и продолжить
            </AdminButton>
          </div>
        </AdminPanel>
      </form>
    </main>
  );
}

function TrainingProjectEditorPage({
  projectId,
  initialStep,
  navigate,
  onBack,
}: {
  projectId: string;
  initialStep: TrainingWizardStep;
  navigate: (path: string) => void;
  onBack: () => void;
}) {
  const { accessToken } = useAuth();
  const [project, setProject] = useState<TrainingProject | null>(null);
  const [objects, setObjects] = useState<TrainingRealEstateObject[]>([]);
  const [activeStep, setActiveStep] = useState<TrainingWizardStep>(initialStep);
  const [visitedSteps, setVisitedSteps] = useState<Set<TrainingWizardStep>>(
    () => new Set([initialStep]),
  );
  const [dirtyItemKeys, setDirtyItemKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [readiness, setReadiness] = useState<TrainingReadiness | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [sourceSummary, setSourceSummary] = useState<{
    total: number;
    ready: number;
  } | null>(null);
  const [suggestionSummary, setSuggestionSummary] = useState<{
    total: number;
    pending: number;
  } | null>(null);
  const [assignmentSummary, setAssignmentSummary] =
    useState<TrainingAssignmentSummary | null>(null);
  const [sourcesRevision, setSourcesRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const ensuredProjectRef = useRef<string | null>(null);
  const ensuringProjectRef = useRef<string | null>(null);
  const restoringHistoryRef = useRef(false);
  const pendingStepFocusRef = useRef<TrainingWizardStep | null>(null);
  const currentProjectRef = useRef(projectId);
  const historyIndexRef = useRef(
    getTrainingHistoryIndex(window.history.state) ?? 0,
  );

  useEffect(() => {
    if (currentProjectRef.current === projectId) return;
    currentProjectRef.current = projectId;
    setProject(null);
    setObjects([]);
    setDirtyItemKeys(new Set());
    setReadiness(null);
    setReadinessError(null);
    setSourceSummary(null);
    setSuggestionSummary(null);
    setAssignmentSummary(null);
    setSourcesRevision(0);
    setVisitedSteps(new Set([initialStep]));
    ensuredProjectRef.current = null;
    ensuringProjectRef.current = null;
  }, [initialStep, projectId]);

  const loadProject = useCallback(async () => {
    if (!accessToken) return;

    setLoading(true);
    setError(null);
    try {
      const [projectResponse, objectResponse, assignmentResponse] =
        await Promise.all([
        getTrainingProject(accessToken, projectId),
        listTrainingObjects(accessToken, {
          hasPdf: true,
          page: 1,
          limit: 20,
        }),
        getTrainingProjectAssignments(accessToken, projectId),
      ]);
      setProject(projectResponse.project);
      setObjects(objectResponse.items);
      setAssignmentSummary(assignmentResponse);
      return true;
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
      return false;
    } finally {
      setLoading(false);
    }
  }, [accessToken, projectId]);

  useEffect(() => {
    void loadProject();
  }, [loadProject]);

  useEffect(() => {
    setActiveStep((current) => {
      if (current !== initialStep) {
        pendingStepFocusRef.current = initialStep;
      }
      return initialStep;
    });
    setVisitedSteps((current) => new Set(current).add(initialStep));
  }, [initialStep]);

  const version = useMemo(() => {
    if (!project) return null;
    return (
      project.versions.find((item) => item.status === 'DRAFT') ??
      project.versions.find((item) => item.id === project.activeVersionId) ??
      project.versions[0] ??
      null
    );
  }, [project]);

  const loadReadiness = useCallback(async () => {
    if (!accessToken || !version) return;
    setReadinessLoading(true);
    setReadinessError(null);
    try {
      const response = await getTrainingReadiness(accessToken, version.id);
      setReadiness(response.readiness);
    } catch (caughtError) {
      setReadiness(null);
      setReadinessError(getErrorMessage(caughtError));
    } finally {
      setReadinessLoading(false);
    }
  }, [accessToken, version]);

  useEffect(() => {
    void loadReadiness();
  }, [loadReadiness]);

  const ensureWorkingRevision = useCallback(async () => {
    if (
      !accessToken ||
      !project ||
      project.status === 'ARCHIVED' ||
      ensuringProjectRef.current === project.id
    ) {
      return;
    }
    ensuringProjectRef.current = project.id;
    setActionPending(true);
    setError(null);
    try {
      await createTrainingDraftVersion(accessToken, project.id);
      const reloaded = await loadProject();
      if (reloaded) {
        ensuredProjectRef.current = project.id;
      }
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      ensuringProjectRef.current = null;
      setActionPending(false);
    }
  }, [accessToken, loadProject, project]);

  useEffect(() => {
    if (project?.versions.some((item) => item.status === 'DRAFT')) {
      ensuredProjectRef.current = project.id;
      return;
    }
    if (
      activeStep === 'assignments' ||
      !project ||
      project.status === 'ARCHIVED' ||
      ensuredProjectRef.current === project.id
    ) {
      return;
    }
    void ensureWorkingRevision();
  }, [activeStep, ensureWorkingRevision, project]);

  const dirtySteps = useMemo(
    () =>
      new Set(
        [...dirtyItemKeys].map(
          (key) => key.split(dirtyItemSeparator, 1)[0] as TrainingWizardStep,
        ),
      ),
    [dirtyItemKeys],
  );
  const hasUnsavedChanges = dirtyItemKeys.size > 0;

  useEffect(() => {
    const existingIndex = getTrainingHistoryIndex(window.history.state);
    if (existingIndex !== null) {
      historyIndexRef.current = existingIndex;
      return;
    }
    window.history.replaceState(
      withTrainingHistoryIndex(window.history.state, historyIndexRef.current),
      '',
    );
  }, []);

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    const handleBeforePopState = (event: Event) => {
      const guardEvent = event as CustomEvent<PopStateEvent>;
      const popStateEvent = guardEvent.detail;
      const previousIndex = historyIndexRef.current;
      const targetIndex =
        getTrainingHistoryIndex(popStateEvent.state) ?? previousIndex - 1;

      if (restoringHistoryRef.current) {
        restoringHistoryRef.current = false;
        historyIndexRef.current = targetIndex;
        return;
      }

      const targetEditor = window.location.pathname.match(
        /^\/admin\/training\/([0-9a-f-]+)\/edit(?:\/|$)/iu,
      );
      if (
        targetEditor?.[1] === projectId ||
        !hasUnsavedChanges ||
        window.confirm(unsavedChangesMessage)
      ) {
        historyIndexRef.current = targetIndex;
        return;
      }

      guardEvent.preventDefault();
      restoringHistoryRef.current = true;
      const restorationDelta = previousIndex - targetIndex;
      window.setTimeout(() => {
        window.history.go(restorationDelta);
      }, 0);
    };

    window.addEventListener(
      'platforma:before-popstate',
      handleBeforePopState,
    );
    return () =>
      window.removeEventListener(
        'platforma:before-popstate',
        handleBeforePopState,
      );
  }, [hasUnsavedChanges, projectId]);

  useEffect(() => {
    const originalPushState = window.history.pushState;
    const guardedPushState: History['pushState'] = function (
      data,
      unused,
      url,
    ) {
      const targetUrl =
        url == null
          ? new URL(window.location.href)
          : new URL(String(url), window.location.href);
      const targetEditor = targetUrl.pathname.match(
        /^\/admin\/training\/([0-9a-f-]+)\/edit(?:\/|$)/iu,
      );

      if (
        targetEditor?.[1] === projectId ||
        !hasUnsavedChanges ||
        window.confirm(unsavedChangesMessage)
      ) {
        const nextIndex = historyIndexRef.current + 1;
        originalPushState.call(
          window.history,
          withTrainingHistoryIndex(data, nextIndex),
          unused,
          url,
        );
        historyIndexRef.current = nextIndex;
      }
    };

    window.history.pushState = guardedPushState;
    return () => {
      if (window.history.pushState === guardedPushState) {
        window.history.pushState = originalPushState;
      }
    };
  }, [hasUnsavedChanges, projectId]);

  const setDirtyItem = useCallback(
    (step: TrainingWizardStep, itemId: string, dirty: boolean) => {
      const key = `${step}${dirtyItemSeparator}${itemId}`;
      setDirtyItemKeys((current) => {
        const next = new Set(current);
        if (dirty) next.add(key);
        else next.delete(key);
        return next;
      });
    },
    [],
  );

  const changeStep = useCallback(
    (step: TrainingWizardStep) => {
      if (step === activeStep) return;
      pendingStepFocusRef.current = step;
      setVisitedSteps((current) => new Set(current).add(step));
      setActiveStep(step);
      navigate(`/admin/training/${projectId}/edit/${step}`);
    },
    [activeStep, navigate, projectId],
  );

  useEffect(() => {
    const step = pendingStepFocusRef.current;
    if (!step || step !== activeStep) return;
    pendingStepFocusRef.current = null;
    focusTrainingWizardStep(step);
  }, [activeStep]);

  const reloadAfterChange = useCallback(async () => {
    await loadProject();
    await loadReadiness();
  }, [loadProject, loadReadiness]);

  const reloadAfterSourceChange = useCallback(async () => {
    await reloadAfterChange();
    setSourcesRevision((current) => current + 1);
  }, [reloadAfterChange]);

  const requestBack = useCallback(() => {
    onBack();
  }, [onBack]);

  if (loading && !project) {
    return (
      <main className="training-admin">
        <TrainingLoading label="Открываем редактор" />
      </main>
    );
  }

  if (!project || !version) {
    return (
      <main className="training-admin">
        <TrainingAdminHeader
          eyebrow="Обучение"
          title="Проект недоступен"
          description={error ?? 'У проекта нет доступной версии.'}
          onBack={onBack}
        />
      </main>
    );
  }

  const needsWorkingRevision =
    activeStep !== 'assignments' &&
    project.status !== 'ARCHIVED' &&
    !project.versions.some((item) => item.status === 'DRAFT') &&
    ensuredProjectRef.current !== project.id;
  if (needsWorkingRevision && error && !actionPending) {
    return (
      <main className="training-admin">
        <TrainingAdminHeader
          eyebrow="Обучение"
          title="Не удалось открыть рабочую редакцию"
          description="Опубликованная версия не изменена. Повторите создание рабочей редакции."
          onBack={requestBack}
          actions={
            <AdminButton
              tone="primary"
              onClick={() => void ensureWorkingRevision()}
            >
              <RefreshCwIcon aria-hidden="true" />
              Повторить
            </AdminButton>
          }
        />
        <AdminAlert tone="error">{error}</AdminAlert>
      </main>
    );
  }
  if (needsWorkingRevision || actionPending) {
    return (
      <main className="training-admin">
        <TrainingLoading label="Открываем рабочую редакцию" />
      </main>
    );
  }

  const readOnly = version.status !== 'DRAFT' || project.status === 'ARCHIVED';
  const issuesByStep = new Set(
    readiness?.issues.map((issue) => issue.step) ?? [],
  );
  const wizardStepViews: TrainingWizardStepView[] = trainingWizardSteps.map(
    (step) => {
      if (step.id === 'main') {
        return {
          ...step,
          summary: readinessError
            ? 'Проверка недоступна'
            : readiness
              ? 'Проект создан'
              : 'Проверяем…',
          state: readinessError
            ? 'attention'
            : readiness
              ? issuesByStep.has(step.id)
                ? 'attention'
                : 'complete'
              : 'pending',
        };
      }
      if (step.id === 'sources') {
        return {
          ...step,
          summary: sourceSummary
            ? sourceSummary.total > 0
              ? `${sourceSummary.ready}/${sourceSummary.total} готово`
              : 'Добавьте материалы'
            : 'Не проверено',
          state: !sourceSummary
            ? 'pending'
            : issuesByStep.has(step.id)
            ? 'attention'
            : sourceSummary.total > 0
              ? 'complete'
              : 'pending',
        };
      }
      if (step.id === 'suggestions') {
        const pending =
          readiness?.facts.pendingSuggestions ?? suggestionSummary?.pending ?? 0;
        return {
          ...step,
          summary: suggestionSummary
            ? suggestionSummary.total > 0
              ? pending > 0
                ? `${pending} требуют решения`
                : `${suggestionSummary.total} обработано`
              : 'Запустите анализ'
            : 'Не проверено',
          state: !suggestionSummary
            ? 'pending'
            : pending > 0 || issuesByStep.has(step.id)
              ? 'attention'
              : suggestionSummary.total > 0
                ? 'complete'
                : 'pending',
        };
      }
      if (step.id === 'assignments') {
        const assignedCount = assignmentSummary?.eligibleTotal ?? 0;
        const assignedOnly =
          assignmentSummary?.audienceMode === 'ASSIGNED_ONLY';
        return {
          ...step,
          summary: assignmentSummary
            ? assignedOnly
              ? assignedCount > 0
                ? `${assignedCount} ${pluralizeItems(
                    assignedCount,
                    'участник',
                    'участника',
                    'участников',
                  )}`
                : 'Никто не назначен'
              : 'Все сотрудники с доступом'
            : 'Не проверено',
          state: !assignmentSummary
            ? 'pending'
            : assignedOnly && assignedCount === 0
              ? 'attention'
              : 'complete',
        };
      }
      if (step.id === 'questions') {
        return {
          ...step,
          summary: readiness
            ? `${readiness.questions.active}/${readiness.questions.required} настроено`
            : readinessError
              ? 'Проверка недоступна'
              : 'Проверяем…',
          state: readinessError
            ? 'attention'
            : readiness
              ? readiness.questions.ready
                ? 'complete'
                : 'attention'
              : 'pending',
        };
      }
      if (step.id === 'criteria') {
        return {
          ...step,
          summary: readiness
            ? `${formatNumber(readiness.criteria.mainPoints)}/${readiness.criteria.mainRequired} + ${formatNumber(readiness.criteria.followUpPoints)}/${readiness.criteria.followUpRequired}`
            : readinessError
              ? 'Проверка недоступна'
              : 'Проверяем…',
          state: readinessError
            ? 'attention'
            : readiness
              ? readiness.criteria.ready
                ? 'complete'
                : 'attention'
              : 'pending',
        };
      }
      return {
        ...step,
        summary: readiness
          ? readiness.readyToPublish
            ? 'Можно публиковать'
            : 'Есть замечания'
          : readinessError
            ? 'Проверка недоступна'
            : 'Проверяем…',
        state: readinessError
          ? 'attention'
          : readiness
            ? readiness.readyToPublish
              ? 'complete'
              : 'attention'
            : 'pending',
      };
    },
  );

  return (
    <main className="training-admin training-admin--editor">
      <TrainingAdminHeader
        eyebrow={`Проект · v${version.versionNumber}`}
        title={project.title}
        description={
          readOnly
            ? 'Архивная или историческая версия доступна только для просмотра.'
            : 'Изменения сохраняются в рабочей редакции и пока не видны сотрудникам.'
        }
        onBack={requestBack}
        actions={
          <div className="training-header-statuses">
            <AdminStatusBadge
              className={`training-status training-status--${project.status.toLowerCase()}`}
            >
              {projectStatusLabels[project.status]}
            </AdminStatusBadge>
            <AdminStatusBadge>
              {versionStatusLabels[version.status]}
            </AdminStatusBadge>
          </div>
        }
      />

      {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}

      <TrainingReadinessSummary
        readiness={readiness}
        loading={readinessLoading}
        error={readinessError}
        stale={hasUnsavedChanges}
      />
      <TrainingWizardNav
        activeStep={activeStep}
        dirtySteps={dirtySteps}
        steps={wizardStepViews}
        onStepChange={changeStep}
      />

      {visitedSteps.has('main') ? (
        <section
          className="training-wizard-panel"
          data-wizard-step="main"
          hidden={activeStep !== 'main'}
        >
          <ProjectMainSection
            token={accessToken ?? ''}
            project={project}
            version={version}
            objects={objects}
            readOnly={readOnly}
            onChanged={reloadAfterChange}
            onDirtyChange={(itemId, dirty) =>
              setDirtyItem('main', itemId, dirty)
            }
          />
        </section>
      ) : null}
      {visitedSteps.has('sources') ? (
        <section
          className="training-wizard-panel"
          data-wizard-step="sources"
          hidden={activeStep !== 'sources'}
        >
          <TrainingMaterialsSection
            token={accessToken ?? ''}
            project={project}
            version={version}
            readOnly={readOnly}
            onSummaryChange={setSourceSummary}
            onChanged={reloadAfterSourceChange}
            onDirtyChange={(itemId, dirty) =>
              setDirtyItem('sources', itemId, dirty)
            }
          />
        </section>
      ) : null}
      {visitedSteps.has('suggestions') ? (
        <section
          className="training-wizard-panel training-wizard-panel--stack"
          data-wizard-step="suggestions"
          hidden={activeStep !== 'suggestions'}
        >
          <FactSuggestionsSection
            token={accessToken ?? ''}
            version={version}
            readOnly={readOnly}
            onSummaryChange={setSuggestionSummary}
            onChanged={reloadAfterChange}
            onDirtyChange={(itemId, dirty) =>
              setDirtyItem('suggestions', itemId, dirty)
            }
          />
          <FactsSection
            token={accessToken ?? ''}
            version={version}
            sourcesRevision={sourcesRevision}
            readOnly={readOnly}
            onChanged={reloadAfterChange}
            onDirtyChange={(itemId, dirty) =>
              setDirtyItem('suggestions', itemId, dirty)
            }
          />
        </section>
      ) : null}
      {visitedSteps.has('assignments') ? (
        <section
          className="training-wizard-panel"
          data-wizard-step="assignments"
          hidden={activeStep !== 'assignments'}
        >
          <TrainingAssignmentsSection
            token={accessToken ?? ''}
            projectId={project.id}
            readOnly={project.status === 'ARCHIVED'}
            onSummaryChange={setAssignmentSummary}
            onDirtyChange={(itemId, dirty) =>
              setDirtyItem('assignments', itemId, dirty)
            }
          />
        </section>
      ) : null}
      {visitedSteps.has('questions') ? (
        <section
          className="training-wizard-panel training-wizard-panel--stack"
          data-wizard-step="questions"
          hidden={activeStep !== 'questions'}
        >
          <QuestionsSection
            title="Главный вопрос"
            description="Для публикации нужен ровно один активный главный вопрос с максимумом 55 баллов."
            type="MAIN"
            token={accessToken ?? ''}
            version={version}
            readOnly={readOnly}
            onChanged={reloadAfterChange}
            onNavigate={changeStep}
            onDirtyChange={(itemId, dirty) =>
              setDirtyItem('questions', itemId, dirty)
            }
          />
          <QuestionsSection
            title="Дополнительные вопросы"
            description="Для публикации нужны 10 активных вопросов с позициями от 1 до 10 и максимумом 15 баллов каждый."
            type="FOLLOW_UP"
            token={accessToken ?? ''}
            version={version}
            readOnly={readOnly}
            onChanged={reloadAfterChange}
            onNavigate={changeStep}
            onDirtyChange={(itemId, dirty) =>
              setDirtyItem('questions', itemId, dirty)
            }
          />
        </section>
      ) : null}
      {visitedSteps.has('criteria') ? (
        <section
          className="training-wizard-panel"
          data-wizard-step="criteria"
          hidden={activeStep !== 'criteria'}
        >
          <CriteriaSection
            token={accessToken ?? ''}
            version={version}
            readOnly={readOnly}
            onChanged={reloadAfterChange}
            onDirtyChange={(itemId, dirty) =>
              setDirtyItem('criteria', itemId, dirty)
            }
          />
        </section>
      ) : null}
      {visitedSteps.has('review') ? (
        <section
          className="training-wizard-panel"
          data-wizard-step="review"
          hidden={activeStep !== 'review'}
        >
          <PublishSection
            token={accessToken ?? ''}
            project={project}
            version={version}
            readiness={readiness}
            readinessLoading={readinessLoading}
            readinessError={readinessError}
            assignmentSummary={assignmentSummary}
            readOnly={readOnly}
            hasUnsavedChanges={hasUnsavedChanges}
            onChanged={reloadAfterChange}
            onNavigate={changeStep}
          />
        </section>
      ) : null}

      <WizardNavigationFooter
        activeStep={activeStep}
        onNavigate={changeStep}
      />
    </main>
  );
}

function ProjectMainSection({
  token,
  project,
  version,
  objects,
  readOnly,
  onChanged,
  onDirtyChange,
}: {
  token: string;
  project: TrainingProject;
  version: TrainingVersion;
  objects: TrainingRealEstateObject[];
  readOnly: boolean;
  onChanged: () => Promise<void>;
  onDirtyChange: TrainingDirtyChangeHandler;
}) {
  const [form, setForm] = useState(() => projectToForm(project, version));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectedSection, setSelectedSection] =
    useState<ProjectEditorSection>('project');
  const [dirtySections, setDirtySections] = useState<Set<ProjectEditorSection>>(
    () => new Set(),
  );

  useEffect(() => {
    if (dirtySections.size === 0) {
      setForm(projectToForm(project, version));
    }
  }, [dirtySections.size, project, version]);

  const markSectionDirty = (section: ProjectEditorSection) => {
    setDirtySections((current) => new Set(current).add(section));
    onDirtyChange(section, true);
  };

  async function save(event: FormEvent) {
    event.preventDefault();
    const nextErrors = validateProjectForm(form);
    setErrors(nextErrors);
    setServerError(null);
    setNotice(null);
    if (Object.keys(nextErrors).length > 0 || readOnly) {
      setSelectedSection(projectErrorSection(nextErrors));
      return;
    }

    setSaving(true);
    try {
      const input = toCreateProjectInput(form);
      await updateTrainingProject(token, project.id, {
        title: input.title,
        slug: input.slug,
        description: input.description,
        realEstateObjectId: input.realEstateObjectId,
        sortOrder: input.sortOrder,
        availableFrom: input.availableFrom,
        deadlineAt: input.deadlineAt,
      });
      await updateTrainingVersion(token, version.id, input.draft);
      setNotice('Основные данные и настройки рабочей редакции сохранены.');
      for (const section of ['project', 'availability', 'attempt'] as const) {
        onDirtyChange(section, false);
      }
      setDirtySections(new Set());
      await onChanged();
    } catch (caughtError) {
      setServerError(getErrorMessage(caughtError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void save(event)}>
      <AdminPanel className="training-section-panel">
        <SectionHeading
          title="Основное"
          description="Карточка проекта, связь с объектом, окно доступности и правила попытки."
        />
        {serverError ? <AdminAlert tone="error">{serverError}</AdminAlert> : null}
        {notice ? <AdminAlert tone="notice">{notice}</AdminAlert> : null}
        <TrainingMasterDetail
          ariaLabel="Разделы основных настроек"
          groups={[
            {
              id: 'main',
              label: 'Основное',
              items: [
                {
                  id: 'project',
                  label: 'Карточка проекта',
                  description: form.title || 'Название и описание',
                  status: form.slug || 'Без slug',
                },
                {
                  id: 'availability',
                  label: 'Доступность',
                  description:
                    form.availableFrom || form.deadlineAt
                      ? 'Окно прохождения задано'
                      : 'Без ограничения по датам',
                },
                {
                  id: 'attempt',
                  label: 'Настройки попытки',
                  description: `${form.passScore || '0'} баллов · ${form.attemptLimit || '0'} попытки`,
                  status: form.allowRetakeAfterPass ? 'Повтор включён' : 'Без повтора',
                },
              ],
            },
          ]}
          selectedId={selectedSection}
          onSelect={(id) => setSelectedSection(id as ProjectEditorSection)}
        >
          {(['project', 'availability', 'attempt'] as const).map((section) => (
            <TrainingDetailPanel
              key={section}
              id={section}
              selectedId={selectedSection}
              label={
                section === 'project'
                  ? 'Карточка проекта'
                  : section === 'availability'
                    ? 'Доступность'
                    : 'Настройки попытки'
              }
            >
              <div onChangeCapture={() => markSectionDirty(section)}>
                <TrainingDetailHeading
                  title={
                    section === 'project'
                      ? 'Карточка проекта'
                      : section === 'availability'
                        ? 'Доступность'
                        : 'Настройки попытки'
                  }
                  description={
                    section === 'project'
                      ? 'Название, описание, связь с объектом и порядок показа.'
                      : section === 'availability'
                        ? 'Необязательное окно, в котором сотрудник может пройти обучение.'
                        : 'Баллы, лимиты времени и правила повторного прохождения.'
                  }
                />
                <fieldset disabled={readOnly} className="training-fieldset">
                  <ProjectAndSettingsFields
                    token={token}
                    section={section}
                    form={form}
                    errors={errors}
                    objects={objects}
                    initialObject={project.realEstateObject}
                    disabled={readOnly}
                    onChange={setForm}
                  />
                </fieldset>
              </div>
            </TrainingDetailPanel>
          ))}
        </TrainingMasterDetail>
        {!readOnly ? (
          <div className="training-form-actions">
            <AdminButton tone="primary" type="submit" disabled={saving}>
              {saving ? (
                <LoaderCircleIcon className="training-spin" aria-hidden="true" />
              ) : (
                <SaveIcon aria-hidden="true" />
              )}
              Сохранить
            </AdminButton>
          </div>
        ) : null}
      </AdminPanel>
    </form>
  );
}

function TrainingLinkedObjectPicker({
  token,
  initialOptions,
  initialSelectedObject,
  selectedId,
  disabled,
  onSelectedIdChange,
}: {
  token: string;
  initialOptions: TrainingRealEstateObject[];
  initialSelectedObject: TrainingRealEstateObject | null;
  selectedId: string;
  disabled: boolean;
  onSelectedIdChange: (id: string) => void;
}) {
  const [objects, setObjects] =
    useState<TrainingRealEstateObject[]>(initialOptions);
  const [selectedObjects, setSelectedObjects] = useState<
    TrainingRealEstateObject[]
  >(() =>
    initialSelectedObject && initialSelectedObject.id === selectedId
      ? [initialSelectedObject]
      : [],
  );
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(
    initialOptions.length >= 20 ? 2 : 1,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequenceRef = useRef(0);
  const firstSearchRef = useRef(true);

  useEffect(() => {
    setObjects(initialOptions);
  }, [initialOptions]);

  useEffect(() => {
    if (!selectedId) {
      setSelectedObjects([]);
      return;
    }
    const current = selectedObjects.find((object) => object.id === selectedId);
    if (current) return;
    const option =
      objects.find((object) => object.id === selectedId) ??
      (initialSelectedObject?.id === selectedId ? initialSelectedObject : null);
    if (option) setSelectedObjects([option]);
  }, [initialSelectedObject, objects, selectedId, selectedObjects]);

  const loadObjects = useCallback(
    async (nextPage: number, append: boolean) => {
      if (!token) return;
      const requestSequence = requestSequenceRef.current + 1;
      requestSequenceRef.current = requestSequence;
      setLoading(true);
      setError(null);
      try {
        const response = await listTrainingObjects(token, {
          search: query.trim() || undefined,
          hasPdf: true,
          page: nextPage,
          limit: 20,
        });
        if (requestSequenceRef.current !== requestSequence) return;
        setObjects((current) =>
          append
            ? mergeTrainingObjects(current, response.items)
            : response.items,
        );
        setPage(response.page);
        setTotalPages(response.totalPages);
      } catch (caughtError) {
        if (requestSequenceRef.current === requestSequence) {
          setError(getErrorMessage(caughtError));
        }
      } finally {
        if (requestSequenceRef.current === requestSequence) {
          setLoading(false);
        }
      }
    },
    [query, token],
  );

  useEffect(() => {
    if (firstSearchRef.current && !query) {
      firstSearchRef.current = false;
      return;
    }
    const timeout = window.setTimeout(() => void loadObjects(1, false), 220);
    return () => window.clearTimeout(timeout);
  }, [loadObjects, query]);

  const pickerOptions = objects.map(toLinkedObjectPickerOption);
  const selectedPickerOptions = selectedObjects.map(
    toLinkedObjectPickerOption,
  );

  return (
    <TrainingSearchPicker
      id="training-project-object"
      label="Связанный ЖК"
      placeholder="Найти ЖК с PDF"
      emptyLabel="ЖК с доступными PDF не найдены."
      options={pickerOptions}
      selectedOptions={selectedPickerOptions}
      query={query}
      disabled={disabled}
      loading={loading}
      error={error}
      hasMore={page < totalPages}
      onQueryChange={setQuery}
      onLoadMore={() => void loadObjects(page + 1, true)}
      onRetry={() => void loadObjects(1, false)}
      onSelectedOptionsChange={(next) => {
        const selected = next[0];
        if (!selected) {
          setSelectedObjects([]);
          onSelectedIdChange('');
          return;
        }
        const object = objects.find((item) => item.id === selected.id);
        if (!object) return;
        setSelectedObjects([object]);
        onSelectedIdChange(object.id);
      }}
    />
  );
}

function ProjectAndSettingsFields({
  token,
  section,
  form,
  errors,
  objects,
  initialObject,
  disabled,
  onChange,
}: {
  token: string;
  section?: ProjectEditorSection;
  form: ProjectFormState;
  errors: Record<string, string>;
  objects: TrainingRealEstateObject[];
  initialObject: TrainingRealEstateObject | null;
  disabled: boolean;
  onChange: (value: ProjectFormState) => void;
}) {
  const update = <K extends keyof ProjectFormState>(
    key: K,
    value: ProjectFormState[K],
  ) => onChange({ ...form, [key]: value });
  const showProject = !section || section === 'project';
  const showAvailability = !section || section === 'availability';
  const showAttempt = !section || section === 'attempt';

  return (
    <FieldGroup className="training-fields">
      {showProject ? (
        <div className="training-form-grid">
          <TrainingTextField
            id="training-project-title"
            label="Название"
            value={form.title}
            error={errors.title}
            maxLength={240}
            onChange={(value) => update('title', value)}
          />
          <TrainingTextField
            id="training-project-slug"
            label="Slug"
            value={form.slug}
            error={errors.slug}
            maxLength={160}
            placeholder="residential-project"
            onChange={(value) => update('slug', value)}
          />
          <Field className="training-field-wide" data-invalid={Boolean(errors.description)}>
            <FieldLabel htmlFor="training-project-description">Описание</FieldLabel>
            <textarea
              id="training-project-description"
              className="training-control training-textarea"
              value={form.description}
              maxLength={2000}
              aria-invalid={Boolean(errors.description)}
              onChange={(event) => update('description', event.target.value)}
            />
            <FieldError>{errors.description}</FieldError>
          </Field>
          <Field>
            <TrainingLinkedObjectPicker
              token={token}
              initialOptions={objects}
              initialSelectedObject={initialObject}
              selectedId={form.realEstateObjectId}
              disabled={disabled}
              onSelectedIdChange={(value) =>
                update('realEstateObjectId', value)
              }
            />
            <FieldDescription>
              PDF выбранного ЖК можно явно добавить на шаге «Источники».
              Сам выбор ничего не импортирует.
            </FieldDescription>
          </Field>
          <TrainingNumberField
            id="training-project-sort"
            label="Позиция в списке проектов"
            value={form.sortOrder}
            min={0}
            error={errors.sortOrder}
            description="Меньшее число показывает проект выше; при равенстве проекты сортируются по названию."
            onChange={(value) => update('sortOrder', value)}
          />
        </div>
      ) : null}

      {showAvailability ? (
        <div className="training-form-grid">
          <TrainingTextField
            id="training-project-start"
            label="Доступен с"
            type="datetime-local"
            value={form.availableFrom}
            error={errors.availability}
            onChange={(value) => update('availableFrom', value)}
          />
          <TrainingTextField
            id="training-project-deadline"
            label="Дедлайн"
            type="datetime-local"
            value={form.deadlineAt}
            error={errors.availability}
            onChange={(value) => update('deadlineAt', value)}
          />
        </div>
      ) : null}

      {showAttempt ? (
        <div className={!section ? 'training-subsection' : undefined}>
          {!section ? (
            <div>
              <h3>Настройки попытки</h3>
              <p>Ограничения проверяются и при сохранении, и перед публикацией.</p>
            </div>
          ) : null}
          <div className="training-form-grid training-form-grid--settings">
            <TrainingNumberField
              id="training-pass-score"
              label="Проходной балл"
              value={form.passScore}
              min={0}
              max={100}
              error={errors.passScore}
              onChange={(value) => update('passScore', value)}
            />
            <TrainingNumberField
              id="training-attempt-limit"
              label="Лимит попыток"
              value={form.attemptLimit}
              min={1}
              error={errors.attemptLimit}
              onChange={(value) => update('attemptLimit', value)}
            />
            <TrainingNumberField
              id="training-cooldown"
              label="Пауза, минут"
              value={form.cooldownMinutes}
              min={60}
              max={1440}
              error={errors.cooldownMinutes}
              onChange={(value) => update('cooldownMinutes', value)}
            />
            <TrainingNumberField
              id="training-time-limit"
              label="Таймер, секунд"
              value={form.totalTimeLimitSeconds}
              min={300}
              max={420}
              error={errors.totalTimeLimitSeconds}
              onChange={(value) => update('totalTimeLimitSeconds', value)}
            />
            <TrainingNumberField
              id="training-grace"
              label="Grace-период, секунд"
              value={form.finishGraceSeconds}
              min={0}
              error={errors.finishGraceSeconds}
              onChange={(value) => update('finishGraceSeconds', value)}
            />
            <TrainingTextField
              id="training-warnings"
              label="Предупреждения, секунд"
              value={form.warningSeconds}
              error={errors.warningSeconds}
              placeholder="60, 20"
              onChange={(value) => update('warningSeconds', value)}
            />
            <TrainingCheckboxRow
              id="training-retake"
              className="training-field-wide"
              checked={form.allowRetakeAfterPass}
              label="Разрешить повторную попытку после прохождения"
              description="Сотрудник сможет начать новую попытку после успешного прохождения."
              onChange={(checked) => update('allowRetakeAfterPass', checked)}
            />
          </div>
        </div>
      ) : null}
    </FieldGroup>
  );
}

function QuestionsSection({
  title,
  description,
  type,
  token,
  version,
  readOnly,
  onChanged,
  onNavigate,
  onDirtyChange,
}: {
  title: string;
  description: string;
  type: TrainingQuestionType;
  token: string;
  version: TrainingVersion;
  readOnly: boolean;
  onChanged: () => Promise<void>;
  onNavigate: (step: TrainingWizardStep) => void;
  onDirtyChange: TrainingDirtyChangeHandler;
}) {
  const questions = version.questions
    .filter((question) => question.type === type)
    .sort((left, right) => left.position - right.position);
  const [adding, setAdding] = useState(false);
  const newQuestionId = `new-question-${type.toLowerCase()}`;
  const questionIds = [
    ...questions.map((question) => question.id),
    ...(adding ? [newQuestionId] : []),
  ];
  const questionSelectionKey = questionIds.join('|');
  const [selectedId, setSelectedId] = useState(
    () => questions[0]?.id ?? newQuestionId,
  );

  useEffect(() => {
    if (!questionIds.includes(selectedId)) {
      setSelectedId(questionIds[0] ?? '');
    }
  }, [questionSelectionKey, selectedId]);

  const addQuestion = () => {
    setAdding(true);
    setSelectedId(newQuestionId);
  };
  const addButtonId = `training-add-question-${type.toLowerCase()}`;
  const cancelNewQuestion = () => {
    onDirtyChange(newQuestionId, false);
    setAdding(false);
    focusTrainingControl(addButtonId);
  };

  useEffect(() => {
    if (adding && selectedId === newQuestionId) {
      focusTrainingDetailPanel(newQuestionId);
    }
  }, [adding, newQuestionId, selectedId]);

  const masterItems: TrainingMasterItem[] = [
    ...questions.map((question) => ({
      id: question.id,
      label:
        question.type === 'MAIN'
          ? 'Главный вопрос'
          : `Вопрос ${question.position}`,
      description: question.text || 'Текст не указан',
      status: question.isActive ? 'Активен' : 'Выключен',
      statusTone: question.isActive ? ('success' as const) : ('neutral' as const),
    })),
    ...(adding
      ? [
          {
            id: newQuestionId,
            label: 'Новый вопрос',
            description: 'Вопрос ещё не сохранён',
            status: 'Новый',
            statusTone: 'warning' as const,
          },
        ]
      : []),
  ];

  return (
    <AdminPanel className="training-section-panel">
      <SectionHeading
        title={title}
        description={description}
      />
      {questions.length === 0 && !adding ? (
        <AdminEmptyState
          title="Вопросы не добавлены"
          description="Добавьте вопросы, чтобы подготовить версию к публикации."
        />
      ) : null}
      {questionIds.length > 0 ? (
        <TrainingMasterDetail
          ariaLabel={`Список: ${title}`}
          groups={[
            {
              id: type,
              label: title,
              summary: `${questions.length} ${pluralizeItems(questions.length, 'вопрос', 'вопроса', 'вопросов')}`,
              items: masterItems,
              action:
                !readOnly && !adding ? (
                  (placement) => (
                    <TrainingMasterAddButton
                      id={`${addButtonId}-${placement}`}
                      focusKey={addButtonId}
                      label={
                        type === 'MAIN'
                          ? 'Добавить главный вопрос'
                          : 'Добавить дополнительный вопрос'
                      }
                      onClick={addQuestion}
                    />
                  )
                ) : undefined,
            },
          ]}
          selectedId={selectedId}
          onSelect={setSelectedId}
        >
          {questions.map((question) => (
            <TrainingDetailPanel
              key={question.id}
              id={question.id}
              selectedId={selectedId}
              label={
                question.type === 'MAIN'
                  ? 'Главный вопрос'
                  : `Вопрос ${question.position}`
              }
            >
              <QuestionCard
                token={token}
                versionId={version.id}
                version={version}
                question={question}
                editorId={question.id}
                readOnly={readOnly}
                onChanged={onChanged}
                onNavigate={onNavigate}
                onDirtyChange={onDirtyChange}
              />
            </TrainingDetailPanel>
          ))}
          {adding ? (
            <TrainingDetailPanel
              id={newQuestionId}
              selectedId={selectedId}
              label="Новый вопрос"
            >
              <QuestionCard
                token={token}
                versionId={version.id}
                version={version}
                question={{
                  id: '',
                  type,
                  text: '',
                  position: type === 'MAIN' ? 1 : nextPosition(questions),
                  isActive: true,
                  maxScore: type === 'MAIN' ? 55 : 15,
                  topicCodesJson: [],
                }}
                editorId={newQuestionId}
                readOnly={false}
                onNavigate={onNavigate}
                onChanged={async (savedId) => {
                  await onChanged();
                  setAdding(false);
                  if (savedId) setSelectedId(savedId);
                }}
                onCancel={cancelNewQuestion}
                onDirtyChange={onDirtyChange}
              />
            </TrainingDetailPanel>
          ) : null}
        </TrainingMasterDetail>
      ) : !readOnly ? (
        <div className="training-empty-action">
          <AdminButton id={addButtonId} tone="primary" onClick={addQuestion}>
            <PlusIcon aria-hidden="true" />
            Добавить вопрос
          </AdminButton>
        </div>
      ) : null}
    </AdminPanel>
  );
}

function QuestionCard({
  token,
  versionId,
  version,
  question,
  editorId,
  readOnly,
  onChanged,
  onCancel,
  onNavigate,
  onDirtyChange,
}: {
  token: string;
  versionId: string;
  version: TrainingVersion;
  question: TrainingQuestion;
  editorId: string;
  readOnly: boolean;
  onChanged: (savedId?: string) => Promise<void>;
  onCancel?: () => void;
  onNavigate: (step: TrainingWizardStep) => void;
  onDirtyChange: TrainingDirtyChangeHandler;
}) {
  const [text, setText] = useState(question.text);
  const [position, setPosition] = useState(String(question.position));
  const [isActive, setIsActive] = useState(question.isActive);
  const [topicCodes, setTopicCodes] = useState(
    asStringList(question.topicCodesJson).join(', '),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!text.trim()) {
      setError('Введите текст вопроса.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const response = await saveTrainingQuestion(token, versionId, {
        id: question.id || undefined,
        type: question.type,
        text: text.trim(),
        position: Number(position),
        isActive,
        maxScore: question.type === 'MAIN' ? 55 : 15,
        topicCodes: splitList(topicCodes),
      });
      onDirtyChange(editorId, false);
      await onChanged(response.question.id);
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!question.id || !window.confirm('Удалить вопрос из рабочей редакции?')) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await deleteTrainingQuestion(token, versionId, question.id);
      onDirtyChange(editorId, false);
      await onChanged();
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <article
      className="training-edit-card"
      onChangeCapture={() => onDirtyChange(editorId, true)}
    >
      <div className="training-edit-card-heading">
        <div>
          <strong>
            {question.type === 'MAIN' ? 'Главный вопрос' : `Вопрос ${position}`}
          </strong>
          <span>Максимум: {question.type === 'MAIN' ? 55 : 15} баллов</span>
        </div>
        <TrainingCheckboxRow
          id={`question-active-${editorId}`}
          checked={isActive}
          label="Активен"
          compact
          disabled={readOnly || saving}
          onChange={setIsActive}
        />
      </div>
      {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}
      <fieldset disabled={readOnly || saving} className="training-fieldset">
        <div className="training-form-grid">
          <Field className="training-field-wide">
            <FieldLabel htmlFor={`question-text-${editorId}`}>
              Текст вопроса
            </FieldLabel>
            <textarea
              id={`question-text-${editorId}`}
              className="training-control training-textarea"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </Field>
          <TrainingTextField
            id={`question-position-${editorId}`}
            label="Позиция"
            type="number"
            value={position}
            min={question.type === 'MAIN' ? 1 : 1}
            max={question.type === 'MAIN' ? 1 : 10}
            onChange={setPosition}
          />
          <TrainingTextField
            id={`question-topics-${editorId}`}
            label="Коды тем"
            value={topicCodes}
            placeholder="location, product"
            onChange={setTopicCodes}
          />
        </div>
      </fieldset>
      <QuestionEvaluationContext
        instanceId={editorId}
        question={{ ...question, isActive, text, position: Number(position) }}
        facts={version.facts}
        criteria={version.criteria}
        onOpenFacts={() => onNavigate('suggestions')}
        onOpenCriteria={() => onNavigate('criteria')}
      />
      {!readOnly ? (
        <div className="training-card-actions">
          {question.id ? (
            <AdminButton tone="danger" disabled={saving} onClick={() => void remove()}>
              <Trash2Icon aria-hidden="true" />
              Удалить
            </AdminButton>
          ) : (
            <AdminButton disabled={saving} onClick={onCancel}>
              Отмена
            </AdminButton>
          )}
          <AdminButton tone="primary" disabled={saving} onClick={() => void save()}>
            <SaveIcon aria-hidden="true" />
            Сохранить
          </AdminButton>
        </div>
      ) : null}
    </article>
  );
}

function FactSuggestionsSection({
  token,
  version,
  readOnly,
  onSummaryChange,
  onChanged,
  onDirtyChange,
}: {
  token: string;
  version: TrainingVersion;
  readOnly: boolean;
  onSummaryChange: (summary: { total: number; pending: number }) => void;
  onChanged: () => Promise<void>;
  onDirtyChange: TrainingDirtyChangeHandler;
}) {
  const [suggestions, setSuggestions] = useState<TrainingFactSuggestion[]>([]);
  const [latestRun, setLatestRun] = useState<TrainingFactSuggestionRun | null>(
    null,
  );
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const syncedRunRef = useRef('');

  const loadSuggestions = useCallback(async () => {
    try {
      const [suggestionResponse, runResponse] = await Promise.all([
        listTrainingFactSuggestions(token, version.id),
        getLatestTrainingFactSuggestionRun(token, version.id),
      ]);
      setSuggestions(suggestionResponse.items);
      setLatestRun(runResponse.run);
      setLoadError(null);
      setSelectedId((current) => {
        if (suggestionResponse.items.some((item) => item.id === current)) {
          return current;
        }
        return (
          suggestionResponse.items.find((item) => item.status === 'PENDING')?.id ??
          suggestionResponse.items[0]?.id ??
          ''
        );
      });
    } catch (caughtError) {
      setLoadError(getErrorMessage(caughtError));
    } finally {
      setLoading(false);
    }
  }, [token, version.id]);

  useEffect(() => {
    void loadSuggestions();
  }, [loadSuggestions]);

  useEffect(() => {
    if (loading || loadError) return;
    const pendingCount = suggestions.filter(
      (suggestion) => suggestion.status === 'PENDING',
    ).length;
    onSummaryChange({ total: suggestions.length, pending: pendingCount });
  }, [loadError, loading, onSummaryChange, suggestions]);

  useEffect(() => {
    if (!latestRun || !['PENDING', 'RUNNING'].includes(latestRun.status)) {
      return;
    }
    const interval = setInterval(() => void loadSuggestions(), 2_500);
    return () => clearInterval(interval);
  }, [latestRun, loadSuggestions]);

  useEffect(() => {
    if (!latestRun || ['PENDING', 'RUNNING'].includes(latestRun.status)) {
      return;
    }
    const syncKey = [
      latestRun.id,
      latestRun.status,
      latestRun.updatedAt ?? '',
      latestRun.counts.pending,
    ].join(':');
    if (syncedRunRef.current === syncKey) return;
    syncedRunRef.current = syncKey;
    void onChanged();
  }, [latestRun, onChanged]);

  async function startSuggestionRun() {
    if (unresolvedCount > 0) {
      setError(
        `Сначала обработайте ${unresolvedCount} ${pluralizeItems(
          unresolvedCount,
          'предложение',
          'предложения',
          'предложений',
        )}.`,
      );
      return;
    }
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const [documentResponse, urlResponse] = await Promise.all([
        listTrainingDocuments(token, version.id),
        listTrainingOfficialUrlSources(token, version.id),
      ]);
      const sourceIds = [
        ...documentResponse.items
          .filter((item) => item.extractionStatus === 'READY')
          .map((item) => ({ kind: 'DOCUMENT' as const, id: item.id })),
        ...urlResponse.items
          .filter((item) => item.extractionStatus === 'READY')
          .map((item) => ({ kind: 'OFFICIAL_URL' as const, id: item.id })),
      ];
      if (sourceIds.length === 0) {
        setError(
          'Сначала дождитесь готовности хотя бы одного файла или официальной ссылки.',
        );
        return;
      }
      const response = await createTrainingFactSuggestionRun(
        token,
        version.id,
        sourceIds,
      );
      setLatestRun(response.run);
      setNotice('Материалы поставлены в очередь на анализ.');
      await loadSuggestions();
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setPending(false);
    }
  }

  const runActive =
    pending ||
    Boolean(latestRun && ['PENDING', 'RUNNING'].includes(latestRun.status));
  const unresolvedCount = suggestions.filter(
    (suggestion) => suggestion.status === 'PENDING',
  ).length;
  const runButtonLabel = loading
    ? 'Проверяем предложения…'
    : loadError
      ? 'Проверка предложений недоступна'
      : runActive
        ? 'Анализируем материалы…'
        : unresolvedCount > 0
          ? `Сначала обработайте предложения: ${unresolvedCount}`
          : 'Предложить факты из материалов';
  const masterItems: TrainingMasterItem[] = suggestions.map((suggestion) => ({
    id: suggestion.id,
    label: suggestion.suggestedCode || 'Предложенный факт',
    description: suggestion.statement,
    status: suggestionStatusLabels[suggestion.status],
    statusTone:
      suggestion.status === 'ACCEPTED'
        ? 'success'
        : suggestion.status === 'PENDING'
          ? 'warning'
          : 'neutral',
  }));

  return (
    <AdminPanel className="training-section-panel">
      <SectionHeading
        title="Предложенные факты"
        description="Система предлагает формулировки по готовым источникам. Ни один факт не участвует в оценке без явного подтверждения администратором."
        actions={
          !readOnly ? (
            <AdminButton
              tone="primary"
              disabled={
                loading || Boolean(loadError) || runActive || unresolvedCount > 0
              }
              onClick={() => void startSuggestionRun()}
            >
              {loading || runActive ? (
                <LoaderCircleIcon className="training-spin" aria-hidden="true" />
              ) : (
                <SparklesIcon aria-hidden="true" />
              )}
              {runButtonLabel}
            </AdminButton>
          ) : null
        }
      />
      {latestRun ? (
        <div className="training-suggestion-run" role="status" aria-live="polite">
          <span>
            Последний анализ: {suggestionRunStatusLabels[latestRun.status]}
          </span>
          <strong>
            {latestRun.counts.total} всего · {latestRun.counts.pending} требуют
            решения
          </strong>
          {latestRun.errorMessage ? <small>{latestRun.errorMessage}</small> : null}
        </div>
      ) : null}
      {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}
      {loadError ? (
        <>
          <AdminAlert tone="error">{loadError}</AdminAlert>
          <div className="training-form-actions">
            <AdminButton onClick={() => void loadSuggestions()}>
              <RefreshCwIcon aria-hidden="true" />
              Повторить загрузку
            </AdminButton>
          </div>
        </>
      ) : null}
      {notice ? <AdminAlert tone="notice">{notice}</AdminAlert> : null}
      {loading ? (
        <TrainingLoading label="Загружаем предложения" />
      ) : suggestions.length === 0 ? (
        <AdminEmptyState
          title="Предложений пока нет"
          description="Добавьте готовые источники и запустите анализ. Факты также можно создать вручную ниже."
        />
      ) : (
        <TrainingMasterDetail
          ariaLabel="Предложенные факты"
          groups={[
            {
              id: 'suggestions',
              label: 'Результат анализа',
              summary: `${suggestions.filter((item) => item.status === 'PENDING').length} требуют проверки`,
              items: masterItems,
            },
          ]}
          selectedId={selectedId}
          onSelect={setSelectedId}
        >
          {suggestions.map((suggestion) => (
            <TrainingDetailPanel
              key={suggestion.id}
              id={suggestion.id}
              selectedId={selectedId}
              label={suggestion.suggestedCode}
            >
              <FactSuggestionCard
                token={token}
                version={version}
                suggestion={suggestion}
                readOnly={readOnly}
                onDirtyChange={onDirtyChange}
                onChanged={async () => {
                  await loadSuggestions();
                  await onChanged();
                }}
              />
            </TrainingDetailPanel>
          ))}
        </TrainingMasterDetail>
      )}
    </AdminPanel>
  );
}

function FactSuggestionCard({
  token,
  version,
  suggestion,
  readOnly,
  onChanged,
  onDirtyChange,
}: {
  token: string;
  version: TrainingVersion;
  suggestion: TrainingFactSuggestion;
  readOnly: boolean;
  onChanged: () => Promise<void>;
  onDirtyChange: TrainingDirtyChangeHandler;
}) {
  const [code, setCode] = useState(suggestion.suggestedCode);
  const [topicCode, setTopicCode] = useState(suggestion.topicCode);
  const [statement, setStatement] = useState(suggestion.statement);
  const [aliases, setAliases] = useState(suggestion.acceptedAliases.join('\n'));
  const [importance, setImportance] = useState(String(suggestion.importance));
  const [questionIds, setQuestionIds] = useState<Set<string>>(() => new Set());
  const [rejectReason, setRejectReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = !readOnly && suggestion.status === 'PENDING';
  const availableQuestionIds = useMemo(
    () => new Set(version.questions.map((question) => question.id)),
    [version.questions],
  );

  useEffect(() => {
    setQuestionIds((current) =>
      pruneMissingQuestionIds(current, availableQuestionIds),
    );
  }, [availableQuestionIds]);

  function toggleQuestion(questionId: string) {
    setQuestionIds((current) => {
      const next = new Set(current);
      if (next.has(questionId)) next.delete(questionId);
      else next.add(questionId);
      return next;
    });
  }

  async function accept() {
    if (!code.trim() || !topicCode.trim() || !statement.trim()) {
      setError('Заполните код, тему и формулировку факта.');
      return;
    }
    if (questionIds.size === 0) {
      setError('Свяжите предложенный факт минимум с одним вопросом.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await acceptTrainingFactSuggestion(token, version.id, suggestion.id, {
        code: code.trim(),
        topicCode: topicCode.trim(),
        statement: statement.trim(),
        acceptedAliases: splitLines(aliases),
        importance: Number(importance),
        questionIds: [...questionIds],
      });
      onDirtyChange(suggestion.id, false);
      await onChanged();
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setPending(false);
    }
  }

  async function reject() {
    if (!rejectReason.trim()) {
      setError('Укажите причину отклонения.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await rejectTrainingFactSuggestion(
        token,
        version.id,
        suggestion.id,
        rejectReason.trim(),
      );
      onDirtyChange(suggestion.id, false);
      await onChanged();
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setPending(false);
    }
  }

  return (
    <article
      className="training-edit-card training-suggestion-card"
      onChangeCapture={() => onDirtyChange(suggestion.id, true)}
    >
      <div className="training-edit-card-heading">
        <div>
          <strong>{suggestion.suggestedCode}</strong>
          <span>{suggestion.topicCode}</span>
        </div>
        <AdminStatusBadge
          className={
            suggestion.status === 'ACCEPTED'
              ? 'training-status--ready'
              : suggestion.status === 'PENDING'
                ? 'training-status--warning'
                : undefined
          }
        >
          {suggestionStatusLabels[suggestion.status]}
        </AdminStatusBadge>
      </div>
      {suggestion.sourceQuote ? (
        <blockquote className="training-source-quote">
          <span>Фрагмент источника</span>
          <p>{suggestion.sourceQuote}</p>
        </blockquote>
      ) : null}
      {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}
      <fieldset disabled={!editable || pending} className="training-fieldset">
        <div className="training-form-grid">
          <TrainingTextField
            id={`suggestion-code-${suggestion.id}`}
            label="Код"
            value={code}
            onChange={setCode}
          />
          <TrainingTextField
            id={`suggestion-topic-${suggestion.id}`}
            label="Код темы"
            value={topicCode}
            onChange={setTopicCode}
          />
          <Field className="training-field-wide">
            <FieldLabel htmlFor={`suggestion-statement-${suggestion.id}`}>
              Проверенная формулировка
            </FieldLabel>
            <textarea
              id={`suggestion-statement-${suggestion.id}`}
              className="training-control training-textarea"
              value={statement}
              onChange={(event) => setStatement(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`suggestion-aliases-${suggestion.id}`}>
              Допустимые варианты
            </FieldLabel>
            <textarea
              id={`suggestion-aliases-${suggestion.id}`}
              className="training-control training-textarea training-textarea--compact"
              value={aliases}
              onChange={(event) => setAliases(event.target.value)}
            />
          </Field>
          <TrainingNumberField
            id={`suggestion-importance-${suggestion.id}`}
            label="Важность"
            min={1}
            value={importance}
            onChange={setImportance}
          />
          <fieldset className="training-linked-questions training-field-wide">
            <legend>Связать с вопросами</legend>
            <p className="training-choice-summary">
              Выбрано {questionIds.size} из {version.questions.length}
            </p>
            <div className="training-choice-list">
              {[...version.questions]
                .sort((left, right) => {
                  if (left.type !== right.type) return left.type === 'MAIN' ? -1 : 1;
                  return left.position - right.position;
                })
                .map((question) => (
                  <label
                    key={question.id}
                    className={
                      questionIds.has(question.id)
                        ? 'training-choice-row is-checked'
                        : 'training-choice-row'
                    }
                  >
                    <input
                      className="training-checkbox-control"
                      type="checkbox"
                      checked={questionIds.has(question.id)}
                      onChange={() => toggleQuestion(question.id)}
                    />
                    <span className="training-choice-copy">
                      <strong>
                        {question.type === 'MAIN'
                          ? 'Главный вопрос'
                          : `Дополнительный вопрос ${question.position}`}
                      </strong>
                      <span>{question.text}</span>
                    </span>
                  </label>
                ))}
            </div>
          </fieldset>
          {editable ? (
            <Field className="training-field-wide">
              <FieldLabel htmlFor={`suggestion-reason-${suggestion.id}`}>
                Причина отклонения
              </FieldLabel>
              <textarea
                id={`suggestion-reason-${suggestion.id}`}
                className="training-control training-textarea training-textarea--compact"
                value={rejectReason}
                placeholder="Обязательно только при отклонении"
                onChange={(event) => setRejectReason(event.target.value)}
              />
            </Field>
          ) : null}
        </div>
      </fieldset>
      {editable ? (
        <div className="training-card-actions training-suggestion-actions">
          {questionIds.size === 0 ? (
            <p className="training-action-hint">
              Свяжите предложенный факт минимум с одним вопросом.
            </p>
          ) : null}
          <AdminButton
            tone="danger"
            disabled={pending || !rejectReason.trim()}
            onClick={() => void reject()}
          >
            Отклонить
          </AdminButton>
          <AdminButton
            tone="primary"
            disabled={pending || questionIds.size === 0}
            onClick={() => void accept()}
          >
            <CheckCircle2Icon aria-hidden="true" />
            Подтвердить факт
          </AdminButton>
        </div>
      ) : null}
    </article>
  );
}

function FactsSection({
  token,
  version,
  sourcesRevision,
  readOnly,
  onChanged,
  onDirtyChange,
}: {
  token: string;
  version: TrainingVersion;
  sourcesRevision: number;
  readOnly: boolean;
  onChanged: () => Promise<void>;
  onDirtyChange: TrainingDirtyChangeHandler;
}) {
  const [documents, setDocuments] = useState<TrainingDocument[]>([]);
  const [urlSources, setUrlSources] = useState<TrainingOfficialUrlSource[]>([]);
  const [adding, setAdding] = useState(false);
  const newFactId = 'new-fact';
  const factIds = [
    ...version.facts.map((fact) => fact.id),
    ...(adding ? [newFactId] : []),
  ];
  const factSelectionKey = factIds.join('|');
  const [selectedId, setSelectedId] = useState(
    () => version.facts[0]?.id ?? newFactId,
  );

  const loadFactSources = useCallback(async () => {
    try {
      const [documentResponse, urlResponse] = await Promise.all([
      listTrainingDocuments(token, version.id),
      listTrainingOfficialUrlSources(token, version.id),
      ]);
      setDocuments(documentResponse.items);
      setUrlSources(urlResponse.items);
    } catch {
      setDocuments([]);
      setUrlSources([]);
    }
  }, [token, version.id]);

  useEffect(() => {
    void loadFactSources();
  }, [loadFactSources, sourcesRevision]);

  useEffect(() => {
    if (!factIds.includes(selectedId)) {
      setSelectedId(factIds[0] ?? '');
    }
  }, [factSelectionKey, selectedId]);

  const addFact = () => {
    setAdding(true);
    setSelectedId(newFactId);
  };
  const addButtonId = 'training-add-fact';
  const cancelNewFact = () => {
    onDirtyChange(newFactId, false);
    setAdding(false);
    focusTrainingControl(addButtonId);
  };

  useEffect(() => {
    if (adding && selectedId === newFactId) {
      focusTrainingDetailPanel(newFactId);
    }
  }, [adding, selectedId]);

  const masterItems: TrainingMasterItem[] = [
    ...version.facts.map((fact) => ({
      id: fact.id,
      label: fact.code,
      description: fact.statement,
      status: fact.isApproved ? 'Подтверждён' : 'Нужна проверка',
      statusTone: fact.isApproved ? ('success' as const) : ('warning' as const),
    })),
    ...(adding
      ? [
          {
            id: newFactId,
            label: 'Новый факт',
            description: 'Факт ещё не сохранён',
            status: 'Новый',
            statusTone: 'warning' as const,
          },
        ]
      : []),
  ];

  return (
    <AdminPanel className="training-section-panel">
      <SectionHeading
        title="Структурированные факты"
        description="Только подтверждённые администратором факты участвуют в оценивании. Извлечённый текст сам по себе никогда не становится фактом."
      />
      <AdminAlert tone="notice">
        Извлечённый текст — рабочий материал. Проверьте формулировку, источник и
        включите «Факт подтверждён» вручную.
      </AdminAlert>
      {version.facts.length === 0 && !adding ? (
        <AdminEmptyState
          title="Факты не добавлены"
          description="Создайте хотя бы один подтверждённый структурированный факт."
        />
      ) : null}
      {factIds.length > 0 ? (
        <TrainingMasterDetail
          ariaLabel="Список структурированных фактов"
          groups={[
            {
              id: 'facts',
              label: 'Факты',
              summary: `${version.facts.length} ${pluralizeItems(version.facts.length, 'факт', 'факта', 'фактов')}`,
              items: masterItems,
              action:
                !readOnly && !adding ? (
                  (placement) => (
                    <TrainingMasterAddButton
                      id={`${addButtonId}-${placement}`}
                      focusKey={addButtonId}
                      label="Добавить факт"
                      onClick={addFact}
                    />
                  )
                ) : undefined,
            },
          ]}
          selectedId={selectedId}
          onSelect={setSelectedId}
        >
          {version.facts.map((fact) => (
            <TrainingDetailPanel
              key={fact.id}
              id={fact.id}
              selectedId={selectedId}
              label={fact.code}
            >
              <FactCard
                token={token}
                version={version}
                fact={fact}
                documents={documents}
                urlSources={urlSources}
                editorId={fact.id}
                readOnly={readOnly}
                onChanged={onChanged}
                onDirtyChange={onDirtyChange}
              />
            </TrainingDetailPanel>
          ))}
          {adding ? (
            <TrainingDetailPanel
              id={newFactId}
              selectedId={selectedId}
              label="Новый факт"
            >
              <FactCard
                token={token}
                version={version}
                fact={null}
                documents={documents}
                urlSources={urlSources}
                editorId={newFactId}
                readOnly={false}
                onChanged={async (savedId) => {
                  await onChanged();
                  setAdding(false);
                  if (savedId) setSelectedId(savedId);
                }}
                onCancel={cancelNewFact}
                onDirtyChange={onDirtyChange}
              />
            </TrainingDetailPanel>
          ) : null}
        </TrainingMasterDetail>
      ) : !readOnly ? (
        <div className="training-empty-action">
          <AdminButton id={addButtonId} tone="primary" onClick={addFact}>
            <PlusIcon aria-hidden="true" />
            Добавить факт
          </AdminButton>
        </div>
      ) : null}
    </AdminPanel>
  );
}

function FactCard({
  token,
  version,
  fact,
  documents,
  urlSources,
  editorId,
  readOnly,
  onChanged,
  onCancel,
  onDirtyChange,
}: {
  token: string;
  version: TrainingVersion;
  fact: TrainingFact | null;
  documents: TrainingDocument[];
  urlSources: TrainingOfficialUrlSource[];
  editorId: string;
  readOnly: boolean;
  onChanged: (savedId?: string) => Promise<void>;
  onCancel?: () => void;
  onDirtyChange: TrainingDirtyChangeHandler;
}) {
  const [code, setCode] = useState(fact?.code ?? '');
  const [topicCode, setTopicCode] = useState(fact?.topicCode ?? '');
  const [statement, setStatement] = useState(fact?.statement ?? '');
  const [aliases, setAliases] = useState(
    asStringList(fact?.acceptedAliasesJson).join('\n'),
  );
  const [importance, setImportance] = useState(String(fact?.importance ?? 1));
  const [sourceDocumentId, setSourceDocumentId] = useState(
    fact?.sourceDocumentId ?? '',
  );
  const [sourceOfficialUrlId, setSourceOfficialUrlId] = useState(
    fact?.sourceOfficialUrlId ?? '',
  );
  const [sourceLocator, setSourceLocator] = useState(
    fact?.sourceLocatorJson ? JSON.stringify(fact.sourceLocatorJson, null, 2) : '',
  );
  const [isApproved, setIsApproved] = useState(fact?.isApproved ?? false);
  const [questionIds, setQuestionIds] = useState(
    new Set(fact?.questionLinks.map((link) => link.questionId) ?? []),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const availableQuestionIds = useMemo(
    () => new Set(version.questions.map((question) => question.id)),
    [version.questions],
  );

  useEffect(() => {
    setQuestionIds((current) =>
      pruneMissingQuestionIds(current, availableQuestionIds),
    );
  }, [availableQuestionIds]);

  function toggleQuestion(questionId: string) {
    setQuestionIds((current) => {
      const next = new Set(current);
      if (next.has(questionId)) next.delete(questionId);
      else next.add(questionId);
      return next;
    });
  }

  async function save() {
    if (!code.trim() || !topicCode.trim() || !statement.trim()) {
      setError('Заполните код, тему и формулировку факта.');
      return;
    }

    let locator: unknown = null;
    if (sourceLocator.trim()) {
      try {
        locator = JSON.parse(sourceLocator);
      } catch {
        setError('Локатор источника должен быть корректным JSON.');
        return;
      }
    }

    setSaving(true);
    setError(null);
    try {
      const response = await saveTrainingFact(token, version.id, {
        id: fact?.id,
        code: code.trim(),
        topicCode: topicCode.trim(),
        statement: statement.trim(),
        acceptedAliases: splitLines(aliases),
        importance: Number(importance),
        sourceDocumentId: sourceDocumentId || null,
        sourceOfficialUrlId: sourceOfficialUrlId || null,
        sourceLocator: locator,
        isApproved,
        questionIds: [...questionIds],
      });
      onDirtyChange(editorId, false);
      await onChanged(response.fact.id);
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!fact || !window.confirm('Удалить факт из рабочей редакции?')) return;
    setSaving(true);
    try {
      await deleteTrainingFact(token, version.id, fact.id);
      onDirtyChange(editorId, false);
      await onChanged();
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <article
      className="training-edit-card"
      onChangeCapture={() => onDirtyChange(editorId, true)}
    >
      <div className="training-edit-card-heading">
        <div>
          <strong>{fact ? fact.code : 'Новый факт'}</strong>
          <span>{topicCode || 'Тема не указана'}</span>
        </div>
        <AdminStatusBadge
          className={isApproved ? 'training-status--ready' : 'training-status--warning'}
        >
          {isApproved ? 'Подтверждён' : 'Не подтверждён'}
        </AdminStatusBadge>
      </div>
      {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}
      <fieldset disabled={readOnly || saving} className="training-fieldset">
        <div className="training-form-grid">
          <TrainingTextField
            id={`fact-code-${editorId}`}
            label="Код"
            value={code}
            maxLength={120}
            onChange={setCode}
          />
          <TrainingTextField
            id={`fact-topic-${editorId}`}
            label="Код темы"
            value={topicCode}
            maxLength={120}
            onChange={setTopicCode}
          />
          <Field className="training-field-wide">
            <FieldLabel htmlFor={`fact-statement-${editorId}`}>
              Проверенная формулировка
            </FieldLabel>
            <textarea
              id={`fact-statement-${editorId}`}
              className="training-control training-textarea"
              value={statement}
              onChange={(event) => setStatement(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`fact-aliases-${editorId}`}>
              Допустимые варианты
            </FieldLabel>
            <textarea
              id={`fact-aliases-${editorId}`}
              className="training-control training-textarea training-textarea--compact"
              value={aliases}
              placeholder="Один вариант на строку"
              onChange={(event) => setAliases(event.target.value)}
            />
          </Field>
          <TrainingTextField
            id={`fact-importance-${editorId}`}
            label="Важность"
            type="number"
            min={1}
            value={importance}
            onChange={setImportance}
          />
          <Field>
            <FieldLabel htmlFor={`fact-document-${editorId}`}>
              Документ-источник
            </FieldLabel>
            <select
              id={`fact-document-${editorId}`}
              className="training-control"
              value={sourceDocumentId}
              onChange={(event) => {
                setSourceDocumentId(event.target.value);
                if (event.target.value) setSourceOfficialUrlId('');
              }}
            >
              <option value="">Без документа</option>
              {documents.map((document) => (
                <option key={document.id} value={document.id}>
                  {document.file.originalName ?? document.documentType}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`fact-url-source-${editorId}`}>
              Официальная страница-источник
            </FieldLabel>
            <select
              id={`fact-url-source-${editorId}`}
              className="training-control"
              value={sourceOfficialUrlId}
              onChange={(event) => {
                setSourceOfficialUrlId(event.target.value);
                if (event.target.value) setSourceDocumentId('');
              }}
            >
              <option value="">Без официальной ссылки</option>
              {urlSources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.confirmedOfficialHost} · {source.normalizedUrl}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`fact-locator-${editorId}`}>
              Локатор источника
            </FieldLabel>
            <textarea
              id={`fact-locator-${editorId}`}
              className="training-control training-textarea training-code-input"
              value={sourceLocator}
              placeholder='{"page": 3}'
              onChange={(event) => setSourceLocator(event.target.value)}
            />
          </Field>
          <fieldset className="training-linked-questions training-field-wide">
            <legend>Связанные вопросы</legend>
            <p className="training-choice-summary">
              Выбрано {questionIds.size} из {version.questions.length}
            </p>
            <div className="training-choice-list">
              {[...version.questions]
                .sort((left, right) => {
                  if (left.type !== right.type) return left.type === 'MAIN' ? -1 : 1;
                  return left.position - right.position;
                })
                .map((question) => (
                  <label
                    key={question.id}
                    className={
                      questionIds.has(question.id)
                        ? 'training-choice-row is-checked'
                        : 'training-choice-row'
                    }
                  >
                    <input
                      className="training-checkbox-control"
                      type="checkbox"
                      checked={questionIds.has(question.id)}
                      onChange={() => toggleQuestion(question.id)}
                    />
                    <span className="training-choice-copy">
                      <strong>
                        {question.type === 'MAIN'
                          ? 'Главный вопрос'
                          : `Дополнительный вопрос ${question.position}`}
                      </strong>
                      <span>{question.text}</span>
                      {!question.isActive ? (
                        <small>Выключен и не участвует в выборе вопросов</small>
                      ) : null}
                    </span>
                  </label>
                ))}
            </div>
          </fieldset>
          <TrainingCheckboxRow
            id={`fact-approved-${editorId}`}
            className="training-field-wide training-approval"
            checked={isApproved}
            label="Факт проверен и подтверждён администратором"
            description="Только после этого факт может участвовать в оценивании."
            onChange={setIsApproved}
          />
        </div>
      </fieldset>
      {!readOnly ? (
        <div className="training-card-actions">
          {fact ? (
            <AdminButton tone="danger" disabled={saving} onClick={() => void remove()}>
              <Trash2Icon aria-hidden="true" />
              Удалить
            </AdminButton>
          ) : (
            <AdminButton disabled={saving} onClick={onCancel}>
              Отмена
            </AdminButton>
          )}
          <AdminButton tone="primary" disabled={saving} onClick={() => void save()}>
            <SaveIcon aria-hidden="true" />
            Сохранить
          </AdminButton>
        </div>
      ) : null}
    </article>
  );
}

function CriteriaSection({
  token,
  version,
  readOnly,
  onChanged,
  onDirtyChange,
}: {
  token: string;
  version: TrainingVersion;
  readOnly: boolean;
  onChanged: () => Promise<void>;
  onDirtyChange: TrainingDirtyChangeHandler;
}) {
  const [addingTypes, setAddingTypes] = useState<Set<TrainingQuestionType>>(
    () => new Set(),
  );
  const criteriaByType = useMemo(
    () =>
      Object.fromEntries(
        (['MAIN', 'FOLLOW_UP'] as const).map((type) => [
          type,
          version.criteria
            .filter((item) => item.questionType === type)
            .sort((left, right) => left.sortOrder - right.sortOrder),
        ]),
      ) as Record<TrainingQuestionType, TrainingCriterion[]>,
    [version.criteria],
  );
  const newCriterionId = (type: TrainingQuestionType) =>
    `new-criterion-${type.toLowerCase()}`;
  const criterionIds = [
    ...criteriaByType.MAIN.map((criterion) => criterion.id),
    ...(addingTypes.has('MAIN') ? [newCriterionId('MAIN')] : []),
    ...criteriaByType.FOLLOW_UP.map((criterion) => criterion.id),
    ...(addingTypes.has('FOLLOW_UP') ? [newCriterionId('FOLLOW_UP')] : []),
  ];
  const criterionSelectionKey = criterionIds.join('|');
  const [selectedId, setSelectedId] = useState(
    () => version.criteria[0]?.id ?? '',
  );

  useEffect(() => {
    if (!criterionIds.includes(selectedId)) {
      setSelectedId(criterionIds[0] ?? '');
    }
  }, [criterionSelectionKey, selectedId]);

  const addCriterion = (type: TrainingQuestionType) => {
    setAddingTypes((current) => new Set(current).add(type));
    setSelectedId(newCriterionId(type));
  };
  const cancelCriterion = (type: TrainingQuestionType) => {
    onDirtyChange(newCriterionId(type), false);
    setAddingTypes((current) => {
      const next = new Set(current);
      next.delete(type);
      return next;
    });
    focusTrainingControl(`training-add-criterion-${type.toLowerCase()}`);
  };

  useEffect(() => {
    if (selectedId.startsWith('new-criterion-')) {
      focusTrainingDetailPanel(selectedId);
    }
  }, [addingTypes, selectedId]);

  const masterGroups: TrainingMasterGroup[] = (
    ['MAIN', 'FOLLOW_UP'] as const
  ).map((type) => {
    const criteria = criteriaByType[type];
    const total = criteria.reduce(
      (sum, item) => sum + Number(item.maxPoints),
      0,
    );
    const expected = type === 'MAIN' ? 55 : 15;
    return {
      id: type,
      label: type === 'MAIN' ? 'Главный вопрос' : 'Дополнительный вопрос',
      summary: `${criteria.length} ${pluralizeItems(criteria.length, 'критерий', 'критерия', 'критериев')} · ${formatNumber(total)} / ${expected}`,
      items: [
        ...criteria.map((criterion) => ({
          id: criterion.id,
          label: criterion.title || criterion.code,
          description: criterion.code,
          status: `${formatNumber(Number(criterion.maxPoints))} б.`,
          statusTone: 'neutral' as const,
        })),
        ...(addingTypes.has(type)
          ? [
              {
                id: newCriterionId(type),
                label: 'Новый критерий',
                description: 'Критерий ещё не сохранён',
                status: 'Новый',
                statusTone: 'warning' as const,
              },
            ]
          : []),
      ],
      action:
        !readOnly && !addingTypes.has(type) ? (
          (placement) => (
            <TrainingMasterAddButton
              id={`training-add-criterion-${type.toLowerCase()}-${placement}`}
              focusKey={`training-add-criterion-${type.toLowerCase()}`}
              label={`Добавить критерий: ${
                type === 'MAIN' ? 'главный вопрос' : 'дополнительный вопрос'
              }`}
              onClick={() => addCriterion(type)}
            />
          )
        ) : undefined,
    };
  });

  return (
    <AdminPanel className="training-section-panel">
      <SectionHeading
        title="Критерии оценки"
        description="Сумма критериев главного вопроса должна быть 55, дополнительного — 15."
      />
      {criterionIds.length > 0 ? (
        <TrainingMasterDetail
          ariaLabel="Критерии оценки по типам вопросов"
          groups={masterGroups}
          selectedId={selectedId}
          onSelect={setSelectedId}
        >
          {(['MAIN', 'FOLLOW_UP'] as const).flatMap((type) => [
            ...criteriaByType[type].map((criterion) => (
              <TrainingDetailPanel
                key={criterion.id}
                id={criterion.id}
                selectedId={selectedId}
                label={criterion.title || criterion.code}
              >
                <CriterionCard
                  token={token}
                  versionId={version.id}
                  criterion={criterion}
                  editorId={criterion.id}
                  readOnly={readOnly}
                  onChanged={onChanged}
                  onDirtyChange={onDirtyChange}
                />
              </TrainingDetailPanel>
            )),
            ...(addingTypes.has(type)
              ? [
                  <TrainingDetailPanel
                    key={newCriterionId(type)}
                    id={newCriterionId(type)}
                    selectedId={selectedId}
                    label="Новый критерий"
                  >
                    <CriterionCard
                      token={token}
                      versionId={version.id}
                      criterion={{
                        id: '',
                        questionType: type,
                        code: '',
                        title: '',
                        maxPoints: 0,
                        description: '',
                        anchorsJson: [],
                        sortOrder: nextCriterionPosition(criteriaByType[type]),
                      }}
                      editorId={newCriterionId(type)}
                      readOnly={false}
                      onChanged={async (savedId) => {
                        await onChanged();
                        cancelCriterion(type);
                        if (savedId) setSelectedId(savedId);
                      }}
                      onCancel={() => cancelCriterion(type)}
                      onDirtyChange={onDirtyChange}
                    />
                  </TrainingDetailPanel>,
                ]
              : []),
          ])}
        </TrainingMasterDetail>
      ) : (
        <div className="training-criteria-empty">
          <AdminEmptyState
            title="Критерии не добавлены"
            description="Добавьте критерии отдельно для главного и дополнительных вопросов."
          />
          {!readOnly ? (
            <div className="training-empty-action">
              <AdminButton
                id="training-add-criterion-main"
                onClick={() => addCriterion('MAIN')}
              >
                <PlusIcon aria-hidden="true" />
                Для главного вопроса
              </AdminButton>
              <AdminButton
                id="training-add-criterion-follow_up"
                onClick={() => addCriterion('FOLLOW_UP')}
              >
                <PlusIcon aria-hidden="true" />
                Для дополнительного
              </AdminButton>
            </div>
          ) : null}
        </div>
      )}
    </AdminPanel>
  );
}

function CriterionCard({
  token,
  versionId,
  criterion,
  editorId,
  readOnly,
  onChanged,
  onCancel,
  onDirtyChange,
}: {
  token: string;
  versionId: string;
  criterion: TrainingCriterion;
  editorId: string;
  readOnly: boolean;
  onChanged: (savedId?: string) => Promise<void>;
  onCancel?: () => void;
  onDirtyChange: TrainingDirtyChangeHandler;
}) {
  const [code, setCode] = useState(criterion.code);
  const [title, setTitle] = useState(criterion.title);
  const [maxPoints, setMaxPoints] = useState(String(criterion.maxPoints));
  const [description, setDescription] = useState(criterion.description ?? '');
  const [anchors, setAnchors] = useState(
    formatCriterionAnchors(criterion.anchorsJson),
  );
  const [sortOrder, setSortOrder] = useState(String(criterion.sortOrder));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!code.trim() || !title.trim() || Number(maxPoints) <= 0) {
      setError('Заполните код, название и положительный максимум.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const response = await saveTrainingCriterion(token, versionId, {
        id: criterion.id || undefined,
        questionType: criterion.questionType,
        code: code.trim(),
        title: title.trim(),
        maxPoints: Number(maxPoints),
        description: description.trim() || null,
        anchors: parseCriterionAnchors(anchors, Number(maxPoints)),
        sortOrder: Number(sortOrder),
      });
      onDirtyChange(editorId, false);
      await onChanged(response.criterion.id);
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!criterion.id || !window.confirm('Удалить критерий из рабочей редакции?')) {
      return;
    }
    setSaving(true);
    try {
      await deleteTrainingCriterion(token, versionId, criterion.id);
      onDirtyChange(editorId, false);
      await onChanged();
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <article
      className="training-edit-card training-edit-card--criterion"
      onChangeCapture={() => onDirtyChange(editorId, true)}
    >
      <div className="training-edit-card-heading">
        <div>
          <strong>{title || code || 'Новый критерий'}</strong>
          <span>
            {criterion.questionType === 'MAIN'
              ? 'Главный вопрос'
              : 'Дополнительный вопрос'}
          </span>
        </div>
        <AdminStatusBadge>{maxPoints || '0'} баллов</AdminStatusBadge>
      </div>
      {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}
      <fieldset disabled={readOnly || saving} className="training-fieldset">
        <div className="training-form-grid">
          <TrainingTextField
            id={`criterion-code-${editorId}`}
            label="Код"
            value={code}
            onChange={setCode}
          />
          <TrainingTextField
            id={`criterion-order-${editorId}`}
            label="Позиция в списке критериев"
            type="number"
            min={0}
            value={sortOrder}
            description="Меньшее число показывает критерий выше внутри своей группы."
            onChange={setSortOrder}
          />
          <TrainingTextField
            id={`criterion-title-${editorId}`}
            label="Название"
            className="training-field-wide"
            value={title}
            onChange={setTitle}
          />
          <TrainingTextField
            id={`criterion-max-${editorId}`}
            label="Максимум баллов"
            type="number"
            min={0.01}
            step="0.01"
            value={maxPoints}
            onChange={setMaxPoints}
          />
          <Field>
            <FieldLabel
              htmlFor={`criterion-description-${editorId}`}
            >
              Описание
            </FieldLabel>
            <textarea
              id={`criterion-description-${editorId}`}
              className="training-control training-textarea training-textarea--compact"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <Field className="training-field-wide">
            <FieldLabel
              htmlFor={`criterion-anchors-${editorId}`}
            >
              Якоря оценки
            </FieldLabel>
            <textarea
              id={`criterion-anchors-${editorId}`}
              className="training-control training-textarea training-textarea--compact"
              value={anchors}
              placeholder="full | 10 | Полный и точный ответ"
              onChange={(event) => setAnchors(event.target.value)}
            />
            <FieldDescription>
              Один якорь на строку: ID | баллы | описание.
            </FieldDescription>
          </Field>
        </div>
      </fieldset>
      {!readOnly ? (
        <div className="training-card-actions">
          {criterion.id ? (
            <AdminButton tone="danger" disabled={saving} onClick={() => void remove()}>
              <Trash2Icon aria-hidden="true" />
              Удалить
            </AdminButton>
          ) : (
            <AdminButton disabled={saving} onClick={onCancel}>
              Отмена
            </AdminButton>
          )}
          <AdminButton tone="primary" disabled={saving} onClick={() => void save()}>
            <SaveIcon aria-hidden="true" />
            Сохранить
          </AdminButton>
        </div>
      ) : null}
    </article>
  );
}

type SelectedTrainingSource =
  | { kind: 'DOCUMENT'; source: TrainingDocument }
  | { kind: 'OFFICIAL_URL'; source: TrainingOfficialUrlSource };

function TrainingMaterialsSection({
  token,
  project,
  version,
  readOnly,
  onSummaryChange,
  onChanged,
  onDirtyChange,
}: {
  token: string;
  project: TrainingProject;
  version: TrainingVersion;
  readOnly: boolean;
  onSummaryChange: (summary: { total: number; ready: number }) => void;
  onChanged: () => Promise<void>;
  onDirtyChange: TrainingDirtyChangeHandler;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [documents, setDocuments] = useState<TrainingDocument[]>([]);
  const [urlSources, setUrlSources] = useState<TrainingOfficialUrlSource[]>([]);
  const [linkedObject, setLinkedObject] =
    useState<TrainingRealEstateObject | null>(project.realEstateObject);
  const [linkedPdfs, setLinkedPdfs] = useState<TrainingLinkedObjectPdf[]>([]);
  const [selectedLinkedPdfIds, setSelectedLinkedPdfIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [selected, setSelected] = useState<SelectedTrainingSource | null>(null);
  const [extractedText, setExtractedText] = useState('');
  const [metadata, setMetadata] = useState<unknown>(null);
  const [uploadQueue, setUploadQueue] = useState<TrainingUploadQueueItem[]>([]);
  const [urlInput, setUrlInput] = useState('');
  const [officialHostConfirmed, setOfficialHostConfirmed] = useState(false);
  const [addingUrl, setAddingUrl] = useState(false);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [urlPending, setUrlPending] = useState(false);
  const [linkedPdfPending, setLinkedPdfPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [linkedPdfError, setLinkedPdfError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedTextDirty, setSelectedTextDirty] = useState(false);
  const linkedObjectSelectionRef = useRef<string | null>(null);
  const officialHost = getHttpsHost(urlInput);

  const loadSources = useCallback(async () => {
    const [documentResult, urlResult, linkedPdfResult] =
      await Promise.allSettled([
        listTrainingDocuments(token, version.id),
        listTrainingOfficialUrlSources(token, version.id),
        listTrainingLinkedObjectPdfs(token, version.id),
      ]);

    if (documentResult.status === 'fulfilled') {
      setDocuments(documentResult.value.items);
    }
    if (urlResult.status === 'fulfilled') {
      setUrlSources(urlResult.value.items);
    }
    if (
      documentResult.status === 'fulfilled' &&
      urlResult.status === 'fulfilled'
    ) {
      setLoadError(null);
    } else {
      const caughtError =
        documentResult.status === 'rejected'
          ? documentResult.reason
          : urlResult.status === 'rejected'
            ? urlResult.reason
            : null;
      setLoadError(getErrorMessage(caughtError));
    }

    if (linkedPdfResult.status === 'fulfilled') {
      const response = linkedPdfResult.value;
      setLinkedObject(response.realEstateObject);
      setLinkedPdfs(response.items);
      setLinkedPdfError(null);
      const nextObjectId = response.realEstateObject?.id ?? 'none';
      setSelectedLinkedPdfIds((current) => {
        if (linkedObjectSelectionRef.current !== nextObjectId) {
          linkedObjectSelectionRef.current = nextObjectId;
          return new Set(
            response.items
            .filter(
              (item) =>
                  item.eligible &&
                  item.recommendedByDefault &&
                  !item.alreadyAttached,
            )
              .map((item) => item.objectFileId),
          );
        }
        const available = new Set(
          response.items
            .filter((item) => item.eligible && !item.alreadyAttached)
            .map((item) => item.objectFileId),
        );
        return new Set([...current].filter((id) => available.has(id)));
      });
    } else {
      setLinkedPdfError(getErrorMessage(linkedPdfResult.reason));
    }
    setLoading(false);
  }, [project.realEstateObjectId, token, version.id]);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  useEffect(() => {
    if (loading) return;
    const sources = [...documents, ...urlSources];
    onSummaryChange({
      total: sources.length,
      ready: sources.filter((source) => source.extractionStatus === 'READY').length,
    });
  }, [documents, loadError, loading, onSummaryChange, urlSources]);

  useEffect(() => {
    if (
      ![...documents, ...urlSources].some((source) =>
        ['PENDING', 'PROCESSING'].includes(source.extractionStatus),
      )
    ) {
      return;
    }
    const interval = setInterval(() => void loadSources(), 2_500);
    return () => clearInterval(interval);
  }, [documents, loadSources, urlSources]);

  useEffect(() => {
    if (!selected || selected.kind !== 'OFFICIAL_URL') return;
    const latest = urlSources.find(
      (source) => source.id === selected.source.id,
    );
    if (!latest || latest.updatedAt === selected.source.updatedAt) return;

    if (latest.extractionStatus !== 'READY') {
      setSelected({ kind: 'OFFICIAL_URL', source: latest });
      setExtractedText('');
      setMetadata(null);
      return;
    }

    let cancelled = false;
    void getTrainingOfficialUrlSourceText(token, version.id, latest.id)
      .then((response) => {
        if (cancelled) return;
        setSelected({ kind: 'OFFICIAL_URL', source: response.source });
        setExtractedText(response.extractedText);
        setMetadata(response.extractionMetadata);
        setError(null);
      })
      .catch((caughtError) => {
        if (!cancelled) setError(getErrorMessage(caughtError));
      });
    return () => {
      cancelled = true;
    };
  }, [selected, token, urlSources, version.id]);

  function clearSelectedTextDirty() {
    if (selected?.kind === 'DOCUMENT') {
      onDirtyChange(`document:${selected.source.id}`, false);
    }
    setSelectedTextDirty(false);
  }

  function canLeaveSelected(nextSourceId?: string) {
    if (!selectedTextDirty || selected?.kind !== 'DOCUMENT') {
      return true;
    }
    if (selected.source.id === nextSourceId) return false;
    if (
      !window.confirm(
        'Есть несохранённые изменения текста документа. Закрыть их без сохранения?',
      )
    ) {
      return false;
    }
    clearSelectedTextDirty();
    return true;
  }

  function cancelOfficialUrl() {
    setUrlInput('');
    setOfficialHostConfirmed(false);
    setAddingUrl(false);
    onDirtyChange('official-url:new', false);
    focusTrainingControl('training-add-official-url');
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;
    if (files.length > 20) {
      setError('За один раз можно выбрать не более 20 файлов.');
      return;
    }

    const queue = files.map((file, index) => ({
      id: `${file.name}-${file.size}-${file.lastModified}-${index}`,
      file,
      status: 'QUEUED' as const,
      error: null,
    }));
    await processUploadQueue(queue);
  }

  async function processUploadQueue(queue: TrainingUploadQueueItem[]) {
    setUploadQueue(queue);
    setUploading(true);
    setError(null);
    setNotice(null);
    const result = await runTrainingUploadQueue(
      queue,
      (file) => uploadTrainingDocument(token, version.id, file),
      setUploadQueue,
      2,
    );
    const succeeded = result.filter((item) => item.status === 'SUCCEEDED').length;
    const failed = result.filter((item) => item.status === 'FAILED');
    setUploadQueue(failed);
    setNotice(
      failed.length === 0
        ? `${succeeded} ${pluralizeItems(succeeded, 'файл загружен', 'файла загружены', 'файлов загружено')} и поставлено в очередь.`
        : `Загружено ${succeeded} из ${result.length}. Ошибки показаны ниже.`,
    );
    setUploading(false);
    await loadSources();
    await onChanged();
  }

  async function retryFailedUploads() {
    const failed = uploadQueue
      .filter((item) => item.status === 'FAILED')
      .map((item) => ({ ...item, status: 'QUEUED' as const, error: null }));
    if (failed.length === 0) return;
    await processUploadQueue(failed);
  }

  async function addOfficialUrl() {
    if (!officialHost || !officialHostConfirmed) {
      setError(
        officialHost
          ? 'Подтвердите, что это официальный сайт проекта.'
          : 'Введите корректную публичную HTTPS-ссылку.',
      );
      return;
    }
    setUrlPending(true);
    setError(null);
    try {
      await createTrainingOfficialUrlSource(token, version.id, {
        url: urlInput.trim(),
        confirmedOfficialHost: officialHost,
      });
      setUrlInput('');
      setOfficialHostConfirmed(false);
      setAddingUrl(false);
      onDirtyChange('official-url:new', false);
      setNotice('Официальная ссылка добавлена и поставлена в очередь на обработку.');
      await loadSources();
      await onChanged();
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setUrlPending(false);
    }
  }

  async function attachLinkedPdfs() {
    const objectFileIds = [...selectedLinkedPdfIds];
    if (objectFileIds.length === 0) {
      setError('Выберите хотя бы один PDF связанного ЖК.');
      return;
    }
    setLinkedPdfPending(true);
    setError(null);
    setNotice(null);
    try {
      const response = await attachTrainingLinkedObjectPdfs(
        token,
        version.id,
        objectFileIds,
      );
      setSelectedLinkedPdfIds(new Set());
      setNotice(
        response.createdCount > 0
          ? `${response.createdCount} ${pluralizeItems(
              response.createdCount,
              'PDF добавлен',
              'PDF добавлены',
              'PDF добавлено',
            )} и поставлено в очередь.`
          : 'Выбранные PDF уже добавлены в источники.',
      );
      await loadSources();
      await onChanged();
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setLinkedPdfPending(false);
    }
  }

  async function previewDocument(document: TrainingDocument) {
    if (!canLeaveSelected(document.id)) return;
    setError(null);
    try {
      const response = await getTrainingDocumentText(token, version.id, document.id);
      setSelected({ kind: 'DOCUMENT', source: response.document });
      setExtractedText(response.extractedText);
      setMetadata(response.extractionMetadata);
      setSelectedTextDirty(false);
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    }
  }

  async function previewUrl(source: TrainingOfficialUrlSource) {
    if (!canLeaveSelected(source.id)) return;
    setError(null);
    try {
      const response = await getTrainingOfficialUrlSourceText(
        token,
        version.id,
        source.id,
      );
      setSelected({ kind: 'OFFICIAL_URL', source: response.source });
      setExtractedText(response.extractedText);
      setMetadata(response.extractionMetadata);
      setSelectedTextDirty(false);
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    }
  }

  async function saveText() {
    if (!selected || selected.kind !== 'DOCUMENT') return;
    setError(null);
    try {
      await updateTrainingDocumentText(
        token,
        version.id,
        selected.source.id,
        extractedText,
      );
      setNotice('Рабочий текст документа сохранён.');
      clearSelectedTextDirty();
      await loadSources();
      await onChanged();
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    }
  }

  async function retryDocument(document: TrainingDocument) {
    setError(null);
    try {
      await retryTrainingDocument(token, version.id, document.id);
      await loadSources();
      await onChanged();
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    }
  }

  async function retryUrl(source: TrainingOfficialUrlSource) {
    setError(null);
    try {
      const response = await retryTrainingOfficialUrlSource(
        token,
        version.id,
        source.id,
      );
      if (selected?.kind === 'OFFICIAL_URL' && selected.source.id === source.id) {
        setSelected({ kind: 'OFFICIAL_URL', source: response.source });
        setExtractedText('');
        setMetadata(null);
      }
      await loadSources();
      await onChanged();
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    }
  }

  async function removeDocument(document: TrainingDocument) {
    if (!window.confirm(`Удалить «${document.file.originalName ?? 'документ'}»?`)) {
      return;
    }
    setError(null);
    try {
      await deleteTrainingDocument(token, version.id, document.id);
      if (selected?.source.id === document.id) {
        clearSelectedTextDirty();
        setSelected(null);
      }
      await loadSources();
      await onChanged();
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    }
  }

  async function removeUrl(source: TrainingOfficialUrlSource) {
    if (!window.confirm(`Удалить официальный источник «${source.normalizedUrl}»?`)) {
      return;
    }
    setError(null);
    try {
      await deleteTrainingOfficialUrlSource(token, version.id, source.id);
      if (selected?.source.id === source.id) {
        clearSelectedTextDirty();
        setSelected(null);
      }
      await loadSources();
      await onChanged();
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    }
  }

  async function download(document: TrainingDocument) {
    setError(null);
    try {
      const response = await downloadTrainingDocument(token, version.id, document.id);
      const url = URL.createObjectURL(response.blob);
      const link = window.document.createElement('a');
      link.href = url;
      link.download =
        response.filename ??
        document.file.originalName ??
        `document.${document.documentType.toLowerCase()}`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    }
  }

  return (
    <AdminPanel className="training-section-panel">
      <SectionHeading
        title="Источники"
        description="Загрузите несколько файлов или добавьте официальные HTTPS-страницы проекта. Извлечённый текст не участвует в оценке без подтверждённых фактов."
        actions={
          !readOnly ? (
            <>
              <input
                ref={fileInputRef}
                className="training-hidden-input"
                type="file"
                tabIndex={-1}
                multiple
                accept=".pdf,.docx,.pptx,.xlsx"
                onChange={(event) => void upload(event)}
              />
              <AdminButton
                id="training-add-official-url"
                disabled={uploading || addingUrl}
                onClick={() => {
                  setAddingUrl(true);
                  focusTrainingControl('training-official-url');
                }}
              >
                <Globe2Icon aria-hidden="true" />
                Добавить ссылку
              </AdminButton>
              <AdminButton
                tone="primary"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploading ? (
                  <LoaderCircleIcon className="training-spin" aria-hidden="true" />
                ) : (
                  <UploadIcon aria-hidden="true" />
                )}
                Выбрать файлы
              </AdminButton>
            </>
          ) : null
        }
      />
      <AdminAlert tone="notice">
        PDF, DOCX, PPTX и XLSX — до 50 МБ каждый и не более 20 файлов за
        выбор. Ссылки должны вести на официальный публичный HTTPS-сайт проекта.
      </AdminAlert>
      {loadError ? <AdminAlert tone="error">{loadError}</AdminAlert> : null}
      {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}
      {notice ? <AdminAlert tone="notice">{notice}</AdminAlert> : null}

      <section className="training-linked-pdf-panel">
        <div className="training-linked-pdf-heading">
          <div>
            <span className="training-linked-pdf-icon" aria-hidden="true">
              <Building2Icon />
            </span>
            <div>
              <h3>PDF связанного ЖК</h3>
              <p>
                {linkedObject
                  ? `${linkedObject.title}. Выберите конкретные файлы — импорт не запускается автоматически.`
                  : 'Сначала выберите связанный ЖК в «Основных данных».'}
              </p>
            </div>
          </div>
          {linkedObject ? (
            <AdminStatusBadge>
              {linkedPdfs.length}{' '}
              {pluralizeItems(linkedPdfs.length, 'PDF', 'PDF', 'PDF')}
            </AdminStatusBadge>
          ) : null}
        </div>

        {linkedPdfError ? (
          <div className="training-linked-pdf-state" role="alert">
            <span>{linkedPdfError}</span>
            <AdminButton tone="text" onClick={() => void loadSources()}>
              <RefreshCwIcon aria-hidden="true" />
              Повторить
            </AdminButton>
          </div>
        ) : !linkedObject ? (
          <div className="training-linked-pdf-state">
            Выбор ЖК сам по себе не добавляет материалы и не запускает AI.
          </div>
        ) : linkedPdfs.length === 0 ? (
          <div className="training-linked-pdf-state">
            У этого ЖК нет доступных PDF.
          </div>
        ) : (
          <>
            <div className="training-linked-pdf-list">
              {linkedPdfs.map((pdf) => {
                const checked =
                  pdf.alreadyAttached ||
                  selectedLinkedPdfIds.has(pdf.objectFileId);
                const title =
                  pdf.title ?? pdf.file.originalName ?? 'PDF без названия';
                return (
                  <TrainingCheckboxRow
                    key={pdf.objectFileId}
                    id={`linked-pdf-${trainingDomSuffix(pdf.objectFileId)}`}
                    checked={checked}
                    disabled={
                      readOnly ||
                      !pdf.eligible ||
                      pdf.alreadyAttached ||
                      linkedPdfPending
                    }
                    label={title}
                    description={`${linkedPdfTypeLabel(pdf.type)} · ${formatBytes(
                      pdf.file.sizeBytes,
                    )}${
                      !pdf.eligible
                        ? ` · недоступен: ${
                            pdf.eligibilityError ??
                            'файл не прошёл проверку'
                          }`
                        : pdf.alreadyAttached
                        ? ' · уже добавлен'
                        : pdf.recommendedByDefault
                          ? ' · выбран по умолчанию'
                          : ' · выберите вручную'
                    }`}
                    onChange={(nextChecked) =>
                      setSelectedLinkedPdfIds((current) => {
                        const next = new Set(current);
                        if (nextChecked) next.add(pdf.objectFileId);
                        else next.delete(pdf.objectFileId);
                        return next;
                      })
                    }
                  />
                );
              })}
            </div>
            {!readOnly ? (
              <div className="training-linked-pdf-actions">
                <p>
                  Презентации и документы отмечены заранее. Планировки
                  добавляются только вручную.
                </p>
                <AdminButton
                  tone="primary"
                  disabled={
                    linkedPdfPending || selectedLinkedPdfIds.size === 0
                  }
                  onClick={() => void attachLinkedPdfs()}
                >
                  {linkedPdfPending ? (
                    <LoaderCircleIcon
                      className="training-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <PlusIcon aria-hidden="true" />
                  )}
                  Добавить выбранные PDF
                </AdminButton>
              </div>
            ) : null}
          </>
        )}
      </section>

      {addingUrl ? (
        <section className="training-url-source-form">
          <div>
            <h3>Официальная страница проекта</h3>
            <p>
              Система сохранит снимок текста. Обновление источника запускается
              администратором вручную.
            </p>
          </div>
          <FieldGroup>
            <TrainingTextField
              id="training-official-url"
              label="HTTPS-ссылка"
              type="url"
              value={urlInput}
              placeholder="https://developer.ru/projects/example"
              onChange={(value) => {
                setUrlInput(value);
                setOfficialHostConfirmed(false);
                onDirtyChange('official-url:new', value.trim().length > 0);
              }}
            />
            <TrainingCheckboxRow
              id="training-official-host-confirmation"
              checked={officialHostConfirmed}
              disabled={!officialHost}
              label={
                officialHost
                  ? `Подтверждаю официальный домен: ${officialHost}`
                  : 'Введите HTTPS-ссылку, чтобы проверить домен'
              }
              description="Добавляйте только страницы застройщика или официальный сайт проекта."
              onChange={(checked) => {
                setOfficialHostConfirmed(checked);
                onDirtyChange(
                  'official-url:new',
                  checked || urlInput.trim().length > 0,
                );
              }}
            />
          </FieldGroup>
          <div className="training-card-actions">
            <AdminButton onClick={cancelOfficialUrl}>Отмена</AdminButton>
            <AdminButton
              tone="primary"
              disabled={urlPending || !officialHost || !officialHostConfirmed}
              onClick={() => void addOfficialUrl()}
            >
              {urlPending ? (
                <LoaderCircleIcon className="training-spin" aria-hidden="true" />
              ) : (
                <Globe2Icon aria-hidden="true" />
              )}
              Добавить источник
            </AdminButton>
          </div>
        </section>
      ) : null}

      {uploadQueue.length > 0 ? (
        <section className="training-upload-queue" aria-live="polite">
          <div className="training-upload-queue-heading">
            <h3>Очередь загрузки</h3>
            {!uploading &&
            uploadQueue.some((item) => item.status === 'FAILED') ? (
              <AdminButton tone="text" onClick={() => void retryFailedUploads()}>
                <RefreshCwIcon aria-hidden="true" />
                Повторить ошибки
              </AdminButton>
            ) : null}
          </div>
          <ul>
            {uploadQueue.map((item) => (
              <li key={item.id}>
                <span>
                  <strong>{item.file.name}</strong>
                  <small>{formatBytes(String(item.file.size))}</small>
                </span>
                <AdminStatusBadge
                  className={
                    item.status === 'FAILED'
                      ? 'training-document-status--failed'
                      : item.status === 'SUCCEEDED'
                        ? 'training-document-status--ready'
                        : 'training-document-status--processing'
                  }
                >
                  {item.status === 'QUEUED'
                    ? 'В очереди'
                    : item.status === 'UPLOADING'
                      ? 'Загрузка'
                      : item.status === 'SUCCEEDED'
                        ? 'Загружен'
                        : 'Ошибка'}
                </AdminStatusBadge>
                {item.error ? <small>{item.error}</small> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {loading ? (
        <TrainingLoading label="Загружаем источники" />
      ) : documents.length === 0 && urlSources.length === 0 ? (
        <AdminEmptyState
          title="Источники не добавлены"
          description="Загрузите файлы или добавьте официальную страницу проекта."
        />
      ) : (
        <div className="training-document-list">
          {documents.map((document) => (
            <article key={document.id} className="training-document-row">
              <div className="training-document-icon">
                <FileTextIcon aria-hidden="true" />
              </div>
              <div className="training-document-info">
                <strong>{document.file.originalName ?? document.documentType}</strong>
                <span>
                  {document.originKind === 'LINKED_OBJECT_PDF'
                    ? `ЖК · ${
                        document.originMetadata?.objectTitle ?? 'связанный объект'
                      }`
                    : 'Загружен вручную'}{' '}
                  · {document.documentType} ·{' '}
                  {formatBytes(document.file.sizeBytes)} ·{' '}
                  {document.extractedCharacterCount.toLocaleString('ru-RU')} знаков
                </span>
                {document.errorMessage ? (
                  <span className="training-document-error">
                    {document.errorMessage}
                  </span>
                ) : null}
              </div>
              <SourceStatus status={document.extractionStatus} />
              <div className="training-document-actions">
                <AdminButton tone="text" onClick={() => void previewDocument(document)}>
                  <EyeIcon aria-hidden="true" />
                  Текст
                </AdminButton>
                <AdminButton tone="text" onClick={() => void download(document)}>
                  <DownloadIcon aria-hidden="true" />
                  Файл
                </AdminButton>
                {!readOnly &&
                ['FAILED', 'NEEDS_MANUAL_TEXT', 'READY'].includes(
                  document.extractionStatus,
                ) ? (
                  <AdminButton
                    tone="text"
                    onClick={() => void retryDocument(document)}
                  >
                    <RefreshCwIcon aria-hidden="true" />
                    Повторить
                  </AdminButton>
                ) : null}
                {!readOnly &&
                !['PENDING', 'PROCESSING'].includes(document.extractionStatus) ? (
                  <AdminButton
                    tone="text"
                    onClick={() => void removeDocument(document)}
                  >
                    <Trash2Icon aria-hidden="true" />
                    Удалить
                  </AdminButton>
                ) : null}
              </div>
            </article>
          ))}
          {urlSources.map((source) => (
            <article key={source.id} className="training-document-row">
              <div className="training-document-icon">
                <Globe2Icon aria-hidden="true" />
              </div>
              <div className="training-document-info">
                <strong>{source.confirmedOfficialHost}</strong>
                <span className="training-source-url">{source.normalizedUrl}</span>
                <span>
                  Официальная ссылка ·{' '}
                  {source.extractedCharacterCount.toLocaleString('ru-RU')} знаков
                  {source.fetchedAt
                    ? ` · обновлено ${new Date(source.fetchedAt).toLocaleDateString('ru-RU')}`
                    : ''}
                </span>
                {source.errorMessage ? (
                  <span className="training-document-error">
                    {source.errorMessage}
                  </span>
                ) : null}
              </div>
              <SourceStatus status={source.extractionStatus} />
              <div className="training-document-actions">
                <AdminButton tone="text" asChild>
                  <a
                    href={source.normalizedUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    <Globe2Icon aria-hidden="true" />
                    Открыть
                  </a>
                </AdminButton>
                <AdminButton tone="text" onClick={() => void previewUrl(source)}>
                  <EyeIcon aria-hidden="true" />
                  Текст
                </AdminButton>
                {!readOnly ? (
                  <AdminButton tone="text" onClick={() => void retryUrl(source)}>
                    <RefreshCwIcon aria-hidden="true" />
                    Обновить
                  </AdminButton>
                ) : null}
                {!readOnly &&
                !['PENDING', 'PROCESSING'].includes(source.extractionStatus) ? (
                  <AdminButton tone="text" onClick={() => void removeUrl(source)}>
                    <Trash2Icon aria-hidden="true" />
                    Удалить
                  </AdminButton>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}

      {selected ? (
        <section className="training-document-preview">
          <div className="training-document-preview-heading">
            <div>
              <h3>
                {selected.kind === 'DOCUMENT'
                  ? selected.source.file.originalName ?? 'Текст документа'
                  : selected.source.normalizedUrl}
              </h3>
              <p>
                {selected.kind === 'DOCUMENT'
                  ? 'Проверьте текст. Для сканов без текстового слоя внесите текст вручную.'
                  : 'Это сохранённый снимок официальной страницы. Для обновления запустите повторную обработку.'}
              </p>
            </div>
            <AdminButton
              tone="text"
              onClick={() => {
                if (!canLeaveSelected()) return;
                setSelected(null);
              }}
            >
              Закрыть
            </AdminButton>
          </div>
          <textarea
            className="training-control training-document-text"
            value={extractedText}
            readOnly={readOnly || selected.kind === 'OFFICIAL_URL'}
            aria-label="Извлечённый текст источника"
            onChange={(event) => {
              setExtractedText(event.target.value);
              if (selected.kind === 'DOCUMENT') {
                setSelectedTextDirty(true);
                onDirtyChange(`document:${selected.source.id}`, true);
              }
            }}
          />
          <details>
            <summary>Технические локаторы извлечения</summary>
            <pre>{JSON.stringify(metadata, null, 2)}</pre>
          </details>
          {!readOnly && selected.kind === 'DOCUMENT' ? (
            <div className="training-form-actions">
              <AdminButton tone="primary" onClick={() => void saveText()}>
                <SaveIcon aria-hidden="true" />
                Сохранить рабочий текст
              </AdminButton>
            </div>
          ) : null}
        </section>
      ) : null}
    </AdminPanel>
  );
}

function SourceStatus({
  status,
}: {
  status: TrainingDocument['extractionStatus'];
}) {
  return (
    <AdminStatusBadge
      className={`training-document-status training-document-status--${status.toLowerCase()}`}
    >
      {status === 'PROCESSING' ? (
        <LoaderCircleIcon className="training-spin" aria-hidden="true" />
      ) : null}
      {documentStatusLabels[status]}
    </AdminStatusBadge>
  );
}

function TrainingAssignmentsSection({
  token,
  projectId,
  readOnly,
  onSummaryChange,
  onDirtyChange,
}: {
  token: string;
  projectId: string;
  readOnly: boolean;
  onSummaryChange: (summary: TrainingAssignmentSummary | null) => void;
  onDirtyChange: TrainingDirtyChangeHandler;
}) {
  const [summary, setSummary] = useState<TrainingAssignmentSummary | null>(null);
  const [audienceMode, setAudienceMode] =
    useState<TrainingAudienceMode>('ASSIGNED_ONLY');
  const [candidates, setCandidates] = useState<TrainingAssignmentCandidate[]>([]);
  const [selectedCandidates, setSelectedCandidates] = useState<
    TrainingAssignmentCandidate[]
  >([]);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [searchLoading, setSearchLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const searchSequenceRef = useRef(0);
  const firstSearchRef = useRef(true);

  const loadAssignments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [assignmentResponse, candidateResponse] = await Promise.all([
        getTrainingProjectAssignments(token, projectId),
        listTrainingAssignees(token, { page: 1, limit: 20 }),
      ]);
      const selected = assignmentResponse.items.map((assignment) => ({
        id: assignment.userId,
        name: assignment.name,
        email: assignment.email,
        status: assignment.status,
        eligible: assignment.eligible,
        telegramConnected: assignment.telegramConnected,
      }));
      setSummary(assignmentResponse);
      setAudienceMode(assignmentResponse.audienceMode);
      setSelectedCandidates(selected);
      setCandidates(
        mergeTrainingCandidates(candidateResponse.items, selected),
      );
      setPage(candidateResponse.page);
      setTotalPages(candidateResponse.totalPages);
      onSummaryChange(assignmentResponse);
      onDirtyChange('selection', false);
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
      onSummaryChange(null);
    } finally {
      setLoading(false);
    }
  }, [onDirtyChange, onSummaryChange, projectId, token]);

  useEffect(() => {
    void loadAssignments();
  }, [loadAssignments]);

  const loadCandidates = useCallback(
    async (nextPage: number, append: boolean) => {
      const sequence = searchSequenceRef.current + 1;
      searchSequenceRef.current = sequence;
      setSearchLoading(true);
      setError(null);
      try {
        const response = await listTrainingAssignees(token, {
          search: query.trim() || undefined,
          page: nextPage,
          limit: 20,
        });
        if (searchSequenceRef.current !== sequence) return;
        setCandidates((current) =>
          mergeTrainingCandidates(
            append ? current : [],
            response.items,
            selectedCandidates,
          ),
        );
        setPage(response.page);
        setTotalPages(response.totalPages);
      } catch (caughtError) {
        if (searchSequenceRef.current === sequence) {
          setError(getErrorMessage(caughtError));
        }
      } finally {
        if (searchSequenceRef.current === sequence) {
          setSearchLoading(false);
        }
      }
    },
    [query, selectedCandidates, token],
  );

  useEffect(() => {
    if (firstSearchRef.current && !query) {
      firstSearchRef.current = false;
      return;
    }
    const timeout = window.setTimeout(() => void loadCandidates(1, false), 220);
    return () => window.clearTimeout(timeout);
  }, [loadCandidates, query]);

  const selectedIds = selectedCandidates.map((candidate) => candidate.id);
  const originalIds = summary?.items.map((item) => item.userId) ?? [];
  const dirty =
    Boolean(summary) &&
    (audienceMode !== summary?.audienceMode ||
      !sameStringSet(selectedIds, originalIds));

  function updateSelected(next: TrainingSearchPickerOption[]) {
    const nextCandidates = next.flatMap((option) => {
      const candidate =
        candidates.find((item) => item.id === option.id) ??
        selectedCandidates.find((item) => item.id === option.id);
      return candidate ? [candidate] : [];
    });
    setSelectedCandidates(nextCandidates);
    onDirtyChange(
      'selection',
      Boolean(summary) &&
        (audienceMode !== summary?.audienceMode ||
          !sameStringSet(
            nextCandidates.map((candidate) => candidate.id),
            originalIds,
          )),
    );
  }

  function updateAudienceMode(nextMode: TrainingAudienceMode) {
    setAudienceMode(nextMode);
    onDirtyChange(
      'selection',
      Boolean(summary) &&
        (nextMode !== summary?.audienceMode ||
          !sameStringSet(selectedIds, originalIds)),
    );
  }

  async function saveAssignments() {
    if (!summary || !dirty) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      let nextSummary = summary;
      if (audienceMode !== nextSummary.audienceMode) {
        nextSummary = await updateTrainingProjectAudience(token, projectId, {
          audienceMode,
          expectedRevision: nextSummary.audienceRevision,
        });
      }
      if (
        !sameStringSet(
          selectedCandidates.map((candidate) => candidate.id),
          nextSummary.items.map((item) => item.userId),
        )
      ) {
        nextSummary = await replaceTrainingProjectAssignments(token, projectId, {
          userIds: selectedCandidates.map((candidate) => candidate.id),
          expectedRevision: nextSummary.audienceRevision,
        });
      }
      setSummary(nextSummary);
      setAudienceMode(nextSummary.audienceMode);
      setSelectedCandidates(
        nextSummary.items.map((assignment) => ({
          id: assignment.userId,
          name: assignment.name,
          email: assignment.email,
          status: assignment.status,
          eligible: assignment.eligible,
          telegramConnected: assignment.telegramConnected,
        })),
      );
      onSummaryChange(nextSummary);
      onDirtyChange('selection', false);
      setNotice('Участники и режим доступа сохранены.');
    } catch (caughtError) {
      if (caughtError instanceof ApiRequestError && caughtError.status === 409) {
        setError(
          'Список участников изменил другой администратор. Данные обновлены — повторите выбор.',
        );
        await loadAssignments();
      } else {
        setError(getErrorMessage(caughtError));
      }
    } finally {
      setSaving(false);
    }
  }

  if (loading && !summary) {
    return (
      <AdminPanel className="training-section-panel">
        <TrainingLoading label="Загружаем участников" />
      </AdminPanel>
    );
  }

  return (
    <AdminPanel className="training-section-panel">
      <SectionHeading
        title="Участники аттестации"
        description="Назначьте один или несколько аккаунтов. Доступ проверяется и в платформе, и при старте через Telegram."
      />
      {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}
      {notice ? <AdminAlert tone="notice">{notice}</AdminAlert> : null}

      <fieldset className="training-audience-modes" disabled={readOnly || saving}>
        <legend>Кто увидит проект</legend>
        <TrainingCheckboxRow
          id="training-audience-assigned"
          type="radio"
          name="training-audience-mode"
          checked={audienceMode === 'ASSIGNED_ONLY'}
          label="Только назначенные аккаунты"
          description="Новые проекты используют этот режим. Пустой список означает «никому»."
          onChange={() => updateAudienceMode('ASSIGNED_ONLY')}
        />
        <TrainingCheckboxRow
          id="training-audience-all"
          type="radio"
          name="training-audience-mode"
          checked={audienceMode === 'ALL_ELIGIBLE'}
          label="Все сотрудники с правом обучения"
          description="Совместимый режим для существующих общих проектов."
          onChange={() => updateAudienceMode('ALL_ELIGIBLE')}
        />
      </fieldset>

      <div className="training-assignment-picker">
        <TrainingSearchPicker
          id="training-assignee-search"
          label="Аккаунты для аттестации"
          placeholder="Имя или email"
          emptyLabel="Подходящие активные аккаунты не найдены."
          multiple
          disabled={readOnly || saving}
          options={candidates.map(toAssigneePickerOption)}
          selectedOptions={selectedCandidates.map(toAssigneePickerOption)}
          query={query}
          loading={searchLoading}
          error={error}
          hasMore={page < totalPages}
          onQueryChange={setQuery}
          onSelectedOptionsChange={updateSelected}
          onLoadMore={() => void loadCandidates(page + 1, true)}
          onRetry={() => void loadCandidates(1, false)}
        />
        <p className="training-assignment-help">
          {selectedCandidates.length > 0
            ? `${selectedCandidates.length} ${pluralizeItems(
                selectedCandidates.length,
                'аккаунт назначен',
                'аккаунта назначены',
                'аккаунтов назначено',
              )}.`
            : 'Пока никто не назначен.'}{' '}
          Telegram не обязателен для назначения.
        </p>
      </div>

      {selectedCandidates.length > 0 ? (
        <ul className="training-assignment-list" aria-label="Назначенные аккаунты">
          {selectedCandidates.map((candidate) => (
            <li key={candidate.id}>
              <span className="training-assignment-avatar" aria-hidden="true">
                <UsersIcon />
              </span>
              <span>
                <strong>{candidate.name ?? candidate.email}</strong>
                <small>{candidate.email}</small>
              </span>
              <AdminStatusBadge
                className={
                  candidate.telegramConnected
                    ? 'training-assignment-telegram is-connected'
                    : 'training-assignment-telegram'
                }
              >
                {candidate.telegramConnected
                  ? 'Telegram подключён'
                  : 'Без Telegram'}
              </AdminStatusBadge>
              {!readOnly ? (
                <AdminButton
                  tone="text"
                  aria-label={`Убрать ${candidate.name ?? candidate.email}`}
                  disabled={saving}
                  onClick={() =>
                    updateSelected(
                      selectedCandidates
                        .filter((item) => item.id !== candidate.id)
                        .map(toAssigneePickerOption),
                    )
                  }
                >
                  Убрать
                </AdminButton>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {!readOnly ? (
        <div className="training-form-actions">
          <AdminButton
            tone="primary"
            disabled={saving || !dirty}
            onClick={() => void saveAssignments()}
          >
            {saving ? (
              <LoaderCircleIcon className="training-spin" aria-hidden="true" />
            ) : (
              <SaveIcon aria-hidden="true" />
            )}
            Сохранить участников
          </AdminButton>
        </div>
      ) : null}
    </AdminPanel>
  );
}

function PublishSection({
  token,
  project,
  version,
  readiness,
  readinessLoading,
  readinessError,
  assignmentSummary,
  readOnly,
  hasUnsavedChanges,
  onChanged,
  onNavigate,
}: {
  token: string;
  project: TrainingProject;
  version: TrainingVersion;
  readiness: TrainingReadiness | null;
  readinessLoading: boolean;
  readinessError: string | null;
  assignmentSummary: TrainingAssignmentSummary | null;
  readOnly: boolean;
  hasUnsavedChanges: boolean;
  onChanged: () => Promise<void>;
  onNavigate: (step: TrainingWizardStep) => void;
}) {
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const assignedOnly = assignmentSummary?.audienceMode === 'ASSIGNED_ONLY';
  const canOpenProject =
    Boolean(assignmentSummary) &&
    (!assignedOnly || (assignmentSummary?.eligibleTotal ?? 0) > 0);
  const validation = readiness
    ? readiness.issues.map((issue) => ({
        section: issue.step,
        message: issue.message,
      }))
    : collectPublicationErrors(project, version);
  const readinessUnavailable = !readiness
    ? {
        section: 'review' as const,
        message: readinessLoading
          ? 'Дождитесь завершения серверной проверки готовности.'
          : readinessError
            ? 'Не удалось проверить готовность на сервере. Повторите попытку перед публикацией.'
            : 'Серверная проверка готовности ещё не выполнена.',
      }
    : null;
  const allErrors = [
    ...validation,
    ...(readinessUnavailable ? [readinessUnavailable] : []),
    ...serverErrors.map((message) => ({ section: 'review' as const, message })),
    ...(hasUnsavedChanges
      ? [
          {
            section: 'review' as const,
            message:
              'Есть несохранённые изменения. Сохраните их перед публикацией.',
          },
        ]
      : []),
  ];

  async function publish() {
    setPending(true);
    setServerErrors([]);
    setNotice(null);
    try {
      await publishTrainingVersion(token, version.id);
      setNotice('Версия опубликована и назначена активной.');
      await onChanged();
    } catch (caughtError) {
      if (caughtError instanceof ApiRequestError && caughtError.errors.length > 0) {
        setServerErrors(caughtError.errors.map(translatePublicationError));
      } else {
        setServerErrors([getErrorMessage(caughtError)]);
      }
    } finally {
      setPending(false);
    }
  }

  async function changeStatus(action: 'open' | 'close' | 'archive') {
    if (action === 'archive' && !window.confirm('Архивировать проект? Это действие необратимо.')) {
      return;
    }
    setPending(true);
    setServerErrors([]);
    try {
      await changeTrainingProjectStatus(token, project.id, action);
      await onChanged();
    } catch (caughtError) {
      setServerErrors([getErrorMessage(caughtError)]);
    } finally {
      setPending(false);
    }
  }

  return (
    <AdminPanel className="training-section-panel">
      <SectionHeading
        title="Проверка и публикация"
        description="Проверка использует текущую рабочую редакцию. После публикации сотрудники увидят новую версию, а история сохранится."
      />
      {notice ? <AdminAlert tone="notice">{notice}</AdminAlert> : null}

      <div className="training-publish-layout">
        <section className="training-validation-panel">
          <div className="training-validation-heading">
            {allErrors.length === 0 ? (
              <CheckCircle2Icon aria-hidden="true" />
            ) : (
              <AlertCircleIcon aria-hidden="true" />
            )}
            <div>
              <h3>
                {allErrors.length === 0
                  ? 'Версия готова'
                  : `Найдено ошибок: ${allErrors.length}`}
              </h3>
              <p>
                {allErrors.length === 0
                  ? 'Все обязательные условия выполнены.'
                  : 'Откройте соответствующий раздел и исправьте данные.'}
              </p>
            </div>
          </div>
          {allErrors.length > 0 ? (
            <ul className="training-validation-list">
              {allErrors.map((item, index) => (
                <li key={`${item.section}-${index}`}>
                  <button type="button" onClick={() => onNavigate(item.section)}>
                    {item.message}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {!readOnly ? (
            <AdminButton
              tone="primary"
              disabled={pending || allErrors.length > 0}
              onClick={() => void publish()}
            >
              {pending ? (
                <LoaderCircleIcon className="training-spin" aria-hidden="true" />
              ) : (
                <CheckCircle2Icon aria-hidden="true" />
              )}
              Опубликовать версию
            </AdminButton>
          ) : null}
        </section>

        <section className="training-preview-card">
          <p className="eyebrow">Предпросмотр</p>
          <h3>{project.title}</h3>
          <p>{project.description || 'Описание не заполнено.'}</p>
          <dl>
            <div>
              <dt>Главный вопрос</dt>
              <dd>
                {version.questions.find(
                  (question) => question.type === 'MAIN' && question.isActive,
                )?.text ?? 'Не добавлен'}
              </dd>
            </div>
            <div>
              <dt>Дополнительных вопросов</dt>
              <dd>
                {
                  version.questions.filter(
                    (question) =>
                      question.type === 'FOLLOW_UP' && question.isActive,
                  ).length
                }
              </dd>
            </div>
            <div>
              <dt>Подтверждённых фактов</dt>
              <dd>{version.facts.filter((fact) => fact.isApproved).length}</dd>
            </div>
            <div>
              <dt>Проходной балл</dt>
              <dd>{version.passScore} / 100</dd>
            </div>
            <div>
              <dt>Доступ</dt>
              <dd>
                {assignmentSummary
                  ? assignedOnly
                    ? `${assignmentSummary.eligibleTotal} назначено`
                    : 'Все сотрудники с доступом'
                  : 'Не удалось проверить'}
              </dd>
            </div>
          </dl>
        </section>
      </div>

      {version.status === 'PUBLISHED' && project.status !== 'ARCHIVED' ? (
        <section className="training-lifecycle">
          <div>
            <h3>Доступ сотрудникам</h3>
            <p>
              {assignedOnly && !canOpenProject
                ? 'Для открытия назначьте хотя бы один подходящий аккаунт.'
                : 'Управление состоянием опубликованного проекта.'}
            </p>
          </div>
          <div className="training-card-actions">
            {project.status !== 'OPEN' ? (
              <AdminButton
                tone="success"
                disabled={pending || !canOpenProject}
                onClick={() => void changeStatus('open')}
              >
                Открыть
              </AdminButton>
            ) : (
              <AdminButton
                disabled={pending}
                onClick={() => void changeStatus('close')}
              >
                Закрыть
              </AdminButton>
            )}
            <AdminButton
              tone="danger"
              disabled={pending}
              onClick={() => void changeStatus('archive')}
            >
              Архивировать
            </AdminButton>
          </div>
        </section>
      ) : null}
    </AdminPanel>
  );
}

function WizardNavigationFooter({
  activeStep,
  onNavigate,
}: {
  activeStep: TrainingWizardStep;
  onNavigate: (step: TrainingWizardStep) => void;
}) {
  const currentIndex = trainingWizardSteps.findIndex(
    (step) => step.id === activeStep,
  );
  const previous = trainingWizardSteps[currentIndex - 1];
  const next = trainingWizardSteps[currentIndex + 1];

  return (
    <div className="training-wizard-footer" aria-label="Навигация по этапам">
      {previous ? (
        <AdminButton onClick={() => onNavigate(previous.id)}>
          <ArrowLeftIcon aria-hidden="true" />
          {previous.label}
        </AdminButton>
      ) : (
        <span />
      )}
      {next ? (
        <AdminButton tone="primary" onClick={() => onNavigate(next.id)}>
          Далее: {next.label}
        </AdminButton>
      ) : null}
    </div>
  );
}

function TrainingAdminHeader({
  eyebrow,
  title,
  description,
  onBack,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  onBack: () => void;
  actions?: ReactNode;
}) {
  return (
    <header className="training-admin-header">
      <div className="training-admin-heading">
        <button type="button" className="training-back-button" onClick={onBack}>
          <ArrowLeftIcon aria-hidden="true" />
          Назад
        </button>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {actions ? <div className="training-header-actions">{actions}</div> : null}
    </header>
  );
}

function TrainingMasterDetail({
  ariaLabel,
  groups,
  selectedId,
  onSelect,
  children,
}: {
  ariaLabel: string;
  groups: TrainingMasterGroup[];
  selectedId: string;
  onSelect: (id: string) => void;
  children: ReactNode;
}) {
  const items = groups.flatMap((group) => group.items);

  return (
    <div
      className="training-master-detail"
      data-training-master-detail
    >
      <div className="training-master-mobile">
        <label>
          <span>{`Выбранный элемент: ${ariaLabel}`}</span>
          <select
            className="training-control"
            value={selectedId}
            disabled={items.length === 0}
            onChange={(event) => onSelect(event.target.value)}
          >
            {groups.map((group) => (
              <optgroup key={group.id} label={group.label}>
                {group.items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        {groups.some((group) => group.action) ? (
          <div
            className="training-master-mobile-actions"
            aria-label={`Добавление: ${ariaLabel}`}
          >
            {groups.map((group) =>
              group.action ? (
                <div key={group.id} className="training-master-mobile-action">
                  <span>{group.label}</span>
                  {group.action('mobile')}
                </div>
              ) : null,
            )}
          </div>
        ) : null}
      </div>

      <nav className="training-master-pane" aria-label={ariaLabel}>
        {groups.map((group) => (
          <section key={group.id} className="training-master-group">
            <div className="training-master-group-heading">
              <div>
                <h3>{group.label}</h3>
                {group.summary ? <p>{group.summary}</p> : null}
              </div>
              {group.action?.('desktop')}
            </div>
            {group.items.length > 0 ? (
              <ul className="training-master-list">
                {group.items.map((item) => {
                  const selected = item.id === selectedId;
                  return (
                    <li key={item.id}>
                      <button
                        id={trainingMasterButtonId(item.id)}
                        type="button"
                        className={
                          selected
                            ? 'training-master-item is-active'
                            : 'training-master-item'
                        }
                        aria-current={selected ? 'true' : undefined}
                        aria-controls={trainingDetailPanelId(item.id)}
                        data-editor-item-id={item.id}
                        onClick={() => onSelect(item.id)}
                      >
                        <span className="training-master-item-copy">
                          <strong>{item.label}</strong>
                          {item.description ? <span>{item.description}</span> : null}
                        </span>
                        {item.status ? (
                          <span
                            className={`training-master-status training-master-status--${item.statusTone ?? 'neutral'}`}
                          >
                            {item.status}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="training-master-empty">Пока нет элементов</p>
            )}
          </section>
        ))}
      </nav>

      <div className="training-detail-pane">{children}</div>
    </div>
  );
}

function TrainingMasterAddButton({
  id,
  focusKey,
  label,
  onClick,
}: {
  id: string;
  focusKey: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      id={id}
      data-training-focus-key={focusKey}
      type="button"
      className="training-master-add"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <PlusIcon aria-hidden="true" />
    </button>
  );
}

function TrainingDetailPanel({
  id,
  selectedId,
  label,
  children,
}: {
  id: string;
  selectedId: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <section
      id={trainingDetailPanelId(id)}
      aria-labelledby={trainingMasterButtonId(id)}
      data-editor-panel-label={label}
      data-editor-panel-id={id}
      tabIndex={-1}
      hidden={id !== selectedId}
    >
      {children}
    </section>
  );
}

function TrainingDetailHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="training-detail-heading">
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}

function TrainingCheckboxRow({
  id,
  type = 'checkbox',
  name,
  label,
  description,
  checked,
  disabled = false,
  compact = false,
  className,
  onChange,
}: {
  id: string;
  type?: 'checkbox' | 'radio';
  name?: string;
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  compact?: boolean;
  className?: string;
  onChange: (checked: boolean) => void;
}) {
  const classes = [
    'training-checkbox-row',
    compact ? 'training-checkbox-row--compact' : '',
    checked ? 'is-checked' : '',
    disabled ? 'is-disabled' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <label className={classes} data-checked={checked ? 'true' : 'false'}>
      <input
        id={id}
        className="training-checkbox-control"
        type={type}
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="training-checkbox-copy">
        <strong>{label}</strong>
        {description ? <span>{description}</span> : null}
      </span>
    </label>
  );
}

function SectionHeading({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="training-section-heading">
      <div>
        <h2 tabIndex={-1}>{title}</h2>
        <p>{description}</p>
      </div>
      {actions ? <div className="training-section-actions">{actions}</div> : null}
    </div>
  );
}

function TrainingTextField({
  id,
  label,
  value,
  error,
  description,
  className,
  onChange,
  ...inputProps
}: {
  id: string;
  label: string;
  value: string;
  error?: string;
  description?: string;
  className?: string;
  onChange: (value: string) => void;
} & Omit<React.ComponentProps<typeof Input>, 'id' | 'value' | 'onChange'>) {
  return (
    <Field className={className} data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={value}
        aria-invalid={Boolean(error)}
        onChange={(event) => onChange(event.target.value)}
        {...inputProps}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError>{error}</FieldError>
    </Field>
  );
}

function TrainingNumberField({
  id,
  label,
  value,
  error,
  description,
  onChange,
  ...inputProps
}: {
  id: string;
  label: string;
  value: string;
  error?: string;
  description?: string;
  onChange: (value: string) => void;
} & Omit<React.ComponentProps<typeof Input>, 'id' | 'type' | 'value' | 'onChange'>) {
  return (
    <TrainingTextField
      id={id}
      label={label}
      type="number"
      value={value}
      error={error}
      description={description}
      onChange={onChange}
      {...inputProps}
    />
  );
}

function TrainingLoading({ label }: { label: string }) {
  return (
    <div className="training-loading" role="status">
      <LoaderCircleIcon className="training-spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

type ProjectFormState = {
  title: string;
  slug: string;
  description: string;
  realEstateObjectId: string;
  sortOrder: string;
  availableFrom: string;
  deadlineAt: string;
  passScore: string;
  attemptLimit: string;
  cooldownMinutes: string;
  totalTimeLimitSeconds: string;
  finishGraceSeconds: string;
  warningSeconds: string;
  allowRetakeAfterPass: boolean;
};

function createEmptyProjectForm(): ProjectFormState {
  return {
    title: '',
    slug: '',
    description: '',
    realEstateObjectId: '',
    sortOrder: '0',
    availableFrom: '',
    deadlineAt: '',
    passScore: '75',
    attemptLimit: '3',
    cooldownMinutes: '60',
    totalTimeLimitSeconds: '420',
    finishGraceSeconds: '90',
    warningSeconds: '60, 20',
    allowRetakeAfterPass: false,
  };
}

function projectToForm(
  project: TrainingProject,
  version: TrainingVersion,
): ProjectFormState {
  return {
    title: project.title,
    slug: project.slug,
    description: project.description ?? '',
    realEstateObjectId: project.realEstateObjectId ?? '',
    sortOrder: String(project.sortOrder),
    availableFrom: toDateTimeInput(project.availableFrom),
    deadlineAt: toDateTimeInput(project.deadlineAt),
    passScore: String(version.passScore),
    attemptLimit: String(version.attemptLimit),
    cooldownMinutes: String(version.cooldownMinutes),
    totalTimeLimitSeconds: String(version.totalTimeLimitSeconds),
    finishGraceSeconds: String(version.finishGraceSeconds),
    warningSeconds: asNumberList(version.warningSecondsJson).join(', '),
    allowRetakeAfterPass: version.allowRetakeAfterPass,
  };
}

function validateProjectForm(form: ProjectFormState) {
  const errors: Record<string, string> = {};
  if (!form.title.trim()) errors.title = 'Введите название проекта.';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(form.slug.trim())) {
    errors.slug = 'Используйте строчные латинские буквы, цифры и дефисы.';
  }
  if (!isIntegerInRange(form.sortOrder, 0)) {
    errors.sortOrder = 'Позиция должна быть целым числом от 0.';
  }
  if (Boolean(form.availableFrom) !== Boolean(form.deadlineAt)) {
    errors.availability = 'Укажите обе даты или оставьте обе пустыми.';
  } else if (form.availableFrom && form.deadlineAt) {
    const duration =
      new Date(form.deadlineAt).getTime() - new Date(form.availableFrom).getTime();
    const day = 24 * 60 * 60 * 1000;
    if (!Number.isFinite(duration) || duration < day || duration > 7 * day) {
      errors.availability = 'Окно доступности должно составлять от 1 до 7 дней.';
    }
  }
  if (!isIntegerInRange(form.passScore, 0, 100)) {
    errors.passScore = 'Допустимо целое значение от 0 до 100.';
  }
  if (!isIntegerInRange(form.attemptLimit, 1)) {
    errors.attemptLimit = 'Минимум одна попытка.';
  }
  if (!isIntegerInRange(form.cooldownMinutes, 60, 1440)) {
    errors.cooldownMinutes = 'Допустимо от 60 до 1440 минут.';
  }
  if (!isIntegerInRange(form.totalTimeLimitSeconds, 300, 420)) {
    errors.totalTimeLimitSeconds = 'Допустимо от 300 до 420 секунд.';
  }
  if (!isIntegerInRange(form.finishGraceSeconds, 0)) {
    errors.finishGraceSeconds = 'Введите целое неотрицательное значение.';
  }

  const warnings = parseNumberList(form.warningSeconds);
  const timer = Number(form.totalTimeLimitSeconds);
  if (
    warnings.length === 0 ||
    warnings.some((item) => !Number.isInteger(item) || item <= 0 || item >= timer) ||
    new Set(warnings).size !== warnings.length ||
    warnings.some((item, index) => index > 0 && warnings[index - 1]! <= item)
  ) {
    errors.warningSeconds =
      'Укажите уникальные целые значения по убыванию, меньше таймера.';
  }

  return errors;
}

function toCreateProjectInput(form: ProjectFormState) {
  return {
    title: form.title.trim(),
    slug: form.slug.trim(),
    description: form.description.trim() || null,
    realEstateObjectId: form.realEstateObjectId || null,
    sortOrder: Number(form.sortOrder),
    availableFrom: form.availableFrom ? new Date(form.availableFrom).toISOString() : null,
    deadlineAt: form.deadlineAt ? new Date(form.deadlineAt).toISOString() : null,
    draft: {
      passScore: Number(form.passScore),
      attemptLimit: Number(form.attemptLimit),
      cooldownMinutes: Number(form.cooldownMinutes),
      totalTimeLimitSeconds: Number(form.totalTimeLimitSeconds),
      finishGraceSeconds: Number(form.finishGraceSeconds),
      warningSeconds: parseNumberList(form.warningSeconds),
      allowRetakeAfterPass: form.allowRetakeAfterPass,
    },
  };
}

function collectPublicationErrors(project: TrainingProject, version: TrainingVersion) {
  const errors: Array<{ section: TrainingWizardStep; message: string }> = [];
  const main = version.questions.filter(
    (question) => question.type === 'MAIN' && question.isActive,
  );
  const followUps = version.questions.filter(
    (question) => question.type === 'FOLLOW_UP' && question.isActive,
  );
  if (main.length !== 1) {
    errors.push({
      section: 'questions',
      message: 'Нужен ровно один активный главный вопрос.',
    });
  }
  if (followUps.length !== 10) {
    errors.push({
      section: 'questions',
      message: 'Нужно ровно 10 активных дополнительных вопросов.',
    });
  }
  const followUpPositions = new Set(followUps.map((question) => question.position));
  if (
    followUps.length === 10 &&
    Array.from({ length: 10 }, (_, index) => index + 1).some(
      (position) => !followUpPositions.has(position),
    )
  ) {
    errors.push({
      section: 'questions',
      message: 'Позиции дополнительных вопросов должны покрывать диапазон 1–10.',
    });
  }
  if (version.facts.length === 0) {
    errors.push({
      section: 'suggestions',
      message: 'Добавьте структурированные факты.',
    });
  } else if (version.facts.some((fact) => !fact.isApproved)) {
    errors.push({
      section: 'suggestions',
      message: 'Все факты должны быть подтверждены администратором.',
    });
  }
  for (const [type, expected] of [
    ['MAIN', 55],
    ['FOLLOW_UP', 15],
  ] as const) {
    const criteria = version.criteria.filter(
      (criterion) => criterion.questionType === type,
    );
    const total = criteria.reduce(
      (sum, criterion) => sum + Number(criterion.maxPoints),
      0,
    );
    if (criteria.length === 0 || Math.abs(total - expected) > 0.000001) {
      errors.push({
        section: 'criteria',
        message: `Сумма критериев ${
          type === 'MAIN' ? 'главного' : 'дополнительного'
        } вопроса должна быть ${expected}.`,
      });
    }
  }
  if (project.status === 'ARCHIVED') {
    errors.push({
      section: 'main',
      message: 'Архивный проект нельзя опубликовать.',
    });
  }
  if (Boolean(project.availableFrom) !== Boolean(project.deadlineAt)) {
    errors.push({
      section: 'main',
      message: 'Окно доступности требует обе даты.',
    });
  }
  return errors;
}

function translatePublicationError(message: string) {
  const translations: Array<[RegExp, string]> = [
    [/exactly 1 active main question/iu, 'Нужен ровно один активный главный вопрос.'],
    [/exactly 10 active follow-up questions/iu, 'Нужно ровно 10 активных дополнительных вопросов.'],
    [/Every fact must be approved/iu, 'Все факты должны быть подтверждены администратором.'],
    [/Main criteria maximum must equal 55/iu, 'Сумма критериев главного вопроса должна быть 55.'],
    [/Follow-up criteria maximum must equal 15/iu, 'Сумма критериев дополнительного вопроса должна быть 15.'],
  ];

  return translations.find(([pattern]) => pattern.test(message))?.[1] ?? message;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Запрос не выполнен';
}

function mergeTrainingObjects(
  current: TrainingRealEstateObject[],
  incoming: TrainingRealEstateObject[],
) {
  const objectsById = new Map(
    current.map((object) => [object.id, object] as const),
  );
  for (const object of incoming) {
    objectsById.set(object.id, object);
  }
  return [...objectsById.values()];
}

function toLinkedObjectPickerOption(
  object: TrainingRealEstateObject,
): TrainingSearchPickerOption {
  const pdfCount = object.eligiblePdfCount ?? object.pdfCount ?? 0;
  return {
    id: object.id,
    label: object.title,
    description: object.slug,
    meta: `${pdfCount} ${pluralizeItems(pdfCount, 'PDF', 'PDF', 'PDF')}`,
  };
}

function mergeTrainingCandidates(
  ...candidateGroups: TrainingAssignmentCandidate[][]
) {
  const candidatesById = new Map<string, TrainingAssignmentCandidate>();
  for (const candidates of candidateGroups) {
    for (const candidate of candidates) {
      candidatesById.set(candidate.id, candidate);
    }
  }
  return [...candidatesById.values()];
}

function toAssigneePickerOption(
  candidate: TrainingAssignmentCandidate,
): TrainingSearchPickerOption {
  return {
    id: candidate.id,
    label: candidate.name?.trim() || candidate.email,
    description:
      candidate.name?.trim() && candidate.name.trim() !== candidate.email
        ? candidate.email
        : undefined,
    meta:
      candidate.eligible === false
        ? 'Больше нет права на обучение'
        : candidate.telegramConnected
          ? 'Telegram подключён'
          : 'Без Telegram',
    disabled: candidate.eligible === false || candidate.status !== 'ACTIVE',
  };
}

function sameStringSet(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((item) => rightSet.has(item));
}

function linkedPdfTypeLabel(type: TrainingLinkedObjectPdf['type']) {
  const labels: Record<TrainingLinkedObjectPdf['type'], string> = {
    PRESENTATION: 'Презентация',
    DOCUMENT: 'Документ',
    FLOOR_PLAN: 'Планировка',
    OTHER: 'Другой файл',
  };
  return labels[type];
}

function projectErrorSection(
  errors: Record<string, string>,
): ProjectEditorSection {
  if (errors.availability) return 'availability';
  if (
    [
      'passScore',
      'attemptLimit',
      'cooldownMinutes',
      'totalTimeLimitSeconds',
      'finishGraceSeconds',
      'warningSeconds',
    ].some((key) => errors[key])
  ) {
    return 'attempt';
  }
  return 'project';
}

function trainingDomSuffix(value: string) {
  return value.replace(/[^A-Za-z0-9_-]+/gu, '-');
}

function trainingMasterButtonId(id: string) {
  return `training-master-button-${trainingDomSuffix(id)}`;
}

function trainingDetailPanelId(id: string) {
  return `training-detail-panel-${trainingDomSuffix(id)}`;
}

function pruneMissingQuestionIds(
  selectedIds: Set<string>,
  availableIds: Set<string>,
) {
  let changed = false;
  const next = new Set<string>();
  for (const questionId of selectedIds) {
    if (availableIds.has(questionId)) {
      next.add(questionId);
    } else {
      changed = true;
    }
  }
  return changed ? next : selectedIds;
}

function getTrainingHistoryIndex(state: unknown) {
  if (typeof state !== 'object' || state === null) return null;
  const value = (state as Record<string, unknown>)[trainingHistoryIndexKey];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function withTrainingHistoryIndex(state: unknown, index: number) {
  if (
    typeof state === 'object' &&
    state !== null &&
    !Array.isArray(state)
  ) {
    return {
      ...(state as Record<string, unknown>),
      [trainingHistoryIndexKey]: index,
    };
  }
  return {
    [trainingHistoryIndexKey]: index,
    originalState: state,
  };
}

function focusTrainingControl(id: string) {
  window.requestAnimationFrame(() => {
    const directTarget = window.document.getElementById(id);
    const keyedTargets = [
      ...window.document.querySelectorAll<HTMLElement>(
        '[data-training-focus-key]',
      ),
    ].filter((element) => element.dataset.trainingFocusKey === id);
    const candidates = [
      ...(directTarget ? [directTarget] : []),
      ...keyedTargets,
    ];
    const visibleTarget = candidates.find(
      (element) =>
        !element.hidden &&
        element.getClientRects().length > 0 &&
        window.getComputedStyle(element).visibility !== 'hidden',
    );
    (visibleTarget ?? candidates[0])?.focus();
  });
}

function focusTrainingDetailPanel(id: string) {
  focusTrainingControl(trainingDetailPanelId(id));
}

function focusTrainingWizardStep(step: TrainingWizardStep) {
  window.requestAnimationFrame(() => {
    const panel = window.document.querySelector<HTMLElement>(
      `[data-wizard-step="${step}"]`,
    );
    (panel?.querySelector<HTMLElement>('h2') ?? panel)?.focus();
  });
}

function pluralizeItems(
  value: number,
  singular: string,
  few: string,
  many: string,
) {
  const absolute = Math.abs(value) % 100;
  const last = absolute % 10;
  if (absolute > 10 && absolute < 20) return many;
  if (last === 1) return singular;
  if (last >= 2 && last <= 4) return few;
  return many;
}

function asStringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function asNumberList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === 'number')
    : [];
}

function formatCriterionAnchors(value: unknown) {
  if (!Array.isArray(value)) return '';
  return value
    .filter(
      (item): item is TrainingCriterionAnchor =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as TrainingCriterionAnchor).id === 'string' &&
        typeof (item as TrainingCriterionAnchor).points === 'number' &&
        typeof (item as TrainingCriterionAnchor).description === 'string',
    )
    .map(
      (anchor) =>
        `${anchor.id} | ${anchor.points} | ${anchor.description}`,
    )
    .join('\n');
}

function parseCriterionAnchors(value: string, maximumPoints: number) {
  const anchors: TrainingCriterionAnchor[] = [];
  const ids = new Set<string>();
  for (const [index, line] of splitLines(value).entries()) {
    const [rawId, rawPoints, ...descriptionParts] = line.split('|');
    const id = rawId?.trim() ?? '';
    const points = Number(rawPoints?.trim());
    const description = descriptionParts.join('|').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id)) {
      throw new Error(`Якорь ${index + 1}: укажите корректный ID.`);
    }
    if (ids.has(id)) {
      throw new Error(`Якорь ${index + 1}: ID должен быть уникальным.`);
    }
    if (
      !Number.isFinite(points) ||
      points < 0 ||
      points > maximumPoints ||
      Math.round(points * 100) !== points * 100
    ) {
      throw new Error(
        `Якорь ${index + 1}: баллы должны быть от 0 до ${maximumPoints}.`,
      );
    }
    if (!description) {
      throw new Error(`Якорь ${index + 1}: добавьте описание.`);
    }
    ids.add(id);
    anchors.push({ id, points, description });
  }
  return anchors;
}

function splitList(value: string) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitLines(value: string) {
  return value
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumberList(value: string) {
  return value
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item));
}

function isIntegerInRange(value: string, min: number, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max;
}

function toDateTimeInput(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function nextPosition(questions: TrainingQuestion[]) {
  const used = new Set(questions.map((question) => question.position));
  return Array.from({ length: 10 }, (_, index) => index + 1).find(
    (position) => !used.has(position),
  ) ?? 10;
}

function nextCriterionPosition(criteria: TrainingCriterion[]) {
  return Math.max(-1, ...criteria.map((criterion) => criterion.sortOrder)) + 1;
}

function formatBytes(value: string | null) {
  const bytes = Number(value ?? 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return 'размер не указан';
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toLocaleString('ru-RU', {
    maximumFractionDigits: 1,
  })} МБ`;
}

function formatNumber(value: number) {
  return value.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
}

function getHttpsHost(value: string) {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || !url.hostname) return '';
    return url.hostname.toLowerCase();
  } catch {
    return '';
  }
}
