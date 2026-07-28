import {
  AlertCircleIcon,
  ArrowLeftIcon,
  CheckCircle2Icon,
  DownloadIcon,
  EyeIcon,
  FileTextIcon,
  LoaderCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  Trash2Icon,
  UploadIcon,
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
  changeTrainingProjectStatus,
  createTrainingDraftVersion,
  createTrainingProject,
  deleteTrainingCriterion,
  deleteTrainingDocument,
  deleteTrainingFact,
  deleteTrainingQuestion,
  downloadTrainingDocument,
  getTrainingDocumentText,
  getTrainingProject,
  listTrainingDocuments,
  listTrainingObjects,
  listTrainingProjects,
  publishTrainingVersion,
  retryTrainingDocument,
  saveTrainingCriterion,
  saveTrainingFact,
  saveTrainingQuestion,
  type TrainingCriterion,
  type TrainingCriterionAnchor,
  type TrainingDocument,
  type TrainingFact,
  type TrainingProject,
  type TrainingQuestion,
  type TrainingQuestionType,
  type TrainingRealEstateObject,
  type TrainingVersion,
  updateTrainingDocumentText,
  updateTrainingProject,
  updateTrainingVersion,
  uploadTrainingDocument,
} from './trainingAdminApi';
import './trainingAdmin.css';

type TrainingAdminPageProps = {
  pathname: string;
  navigate: (path: string) => void;
  onBack: () => void;
};

type EditorTab =
  | 'main'
  | 'materials'
  | 'main-question'
  | 'follow-ups'
  | 'facts'
  | 'criteria'
  | 'publish';

const editorTabs: Array<{ id: EditorTab; label: string }> = [
  { id: 'main', label: 'Основное' },
  { id: 'materials', label: 'Материалы' },
  { id: 'main-question', label: 'Главный вопрос' },
  { id: 'follow-ups', label: 'Дополнительные вопросы' },
  { id: 'facts', label: 'Факты' },
  { id: 'criteria', label: 'Критерии' },
  { id: 'publish', label: 'Проверка / публикация' },
];

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
  action?: ReactNode;
};

type ProjectEditorSection = 'project' | 'availability' | 'attempt';

const projectStatusLabels = {
  DRAFT: 'Черновик',
  OPEN: 'Открыт',
  CLOSED: 'Закрыт',
  ARCHIVED: 'Архив',
} as const;

const versionStatusLabels = {
  DRAFT: 'Черновик',
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

export function TrainingAdminPage({
  pathname,
  navigate,
  onBack,
}: TrainingAdminPageProps) {
  const editorMatch = pathname.match(
    /^\/admin\/training\/([0-9a-f-]+)\/edit\/?$/iu,
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
        description="Черновики, материалы, структура вопросов и готовность к публикации."
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
                        ? `v${draft.versionNumber} · черновик`
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
                        Открыть
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
    void listTrainingObjects(accessToken)
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
      navigate(`/admin/training/${response.project.id}/edit`);
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
        description="Сначала сохранится проект и его первая draft-версия. Контент добавляется в редакторе."
        onBack={onBack}
      />

      <form onSubmit={(event) => void handleSubmit(event)}>
        <AdminPanel className="training-section-panel">
          {serverError ? <AdminAlert tone="error">{serverError}</AdminAlert> : null}
          <ProjectAndSettingsFields
            form={form}
            errors={errors}
            objects={objects}
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
              Создать draft
            </AdminButton>
          </div>
        </AdminPanel>
      </form>
    </main>
  );
}

function TrainingProjectEditorPage({
  projectId,
  onBack,
}: {
  projectId: string;
  navigate: (path: string) => void;
  onBack: () => void;
}) {
  const { accessToken } = useAuth();
  const [project, setProject] = useState<TrainingProject | null>(null);
  const [objects, setObjects] = useState<TrainingRealEstateObject[]>([]);
  const [activeTab, setActiveTab] = useState<EditorTab>('main');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);

  const loadProject = useCallback(async () => {
    if (!accessToken) return;

    setLoading(true);
    setError(null);
    try {
      const [projectResponse, objectResponse] = await Promise.all([
        getTrainingProject(accessToken, projectId),
        listTrainingObjects(accessToken),
      ]);
      setProject(projectResponse.project);
      setObjects(objectResponse.items);
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setLoading(false);
    }
  }, [accessToken, projectId]);

  useEffect(() => {
    void loadProject();
  }, [loadProject]);

  const version = useMemo(() => {
    if (!project) return null;
    return (
      project.versions.find((item) => item.status === 'DRAFT') ??
      project.versions.find((item) => item.id === project.activeVersionId) ??
      project.versions[0] ??
      null
    );
  }, [project]);

  async function createDraft() {
    if (!accessToken || !project) return;
    setActionPending(true);
    setError(null);
    try {
      await createTrainingDraftVersion(accessToken, project.id);
      await loadProject();
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setActionPending(false);
    }
  }

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

  const readOnly = version.status !== 'DRAFT' || project.status === 'ARCHIVED';

  return (
    <main className="training-admin training-admin--editor">
      <TrainingAdminHeader
        eyebrow={`Проект · v${version.versionNumber}`}
        title={project.title}
        description={
          readOnly
            ? 'Опубликованная версия доступна только для просмотра. Для изменений создайте новый draft.'
            : 'Изменения сохраняются в draft и не влияют на опубликованную версию.'
        }
        onBack={onBack}
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
            {readOnly && project.status !== 'ARCHIVED' ? (
              <AdminButton
                tone="primary"
                disabled={actionPending}
                onClick={() => void createDraft()}
              >
                <PlusIcon aria-hidden="true" />
                Новый draft
              </AdminButton>
            ) : null}
          </div>
        }
      />

      {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}

      <nav className="training-editor-tabs" aria-label="Разделы редактора">
        {editorTabs.map((tab) => (
          <button
            key={tab.id}
            className={activeTab === tab.id ? 'is-active' : ''}
            type="button"
            aria-current={activeTab === tab.id ? 'page' : undefined}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {activeTab === 'main' ? (
        <ProjectMainSection
          token={accessToken ?? ''}
          project={project}
          version={version}
          objects={objects}
          readOnly={readOnly}
          onChanged={loadProject}
        />
      ) : null}
      {activeTab === 'materials' ? (
        <TrainingMaterialsSection
          token={accessToken ?? ''}
          version={version}
          readOnly={readOnly}
        />
      ) : null}
      {activeTab === 'main-question' ? (
        <QuestionsSection
          title="Главный вопрос"
          description="Для публикации нужен ровно один активный главный вопрос с максимумом 55 баллов."
          type="MAIN"
          token={accessToken ?? ''}
          version={version}
          readOnly={readOnly}
          onChanged={loadProject}
        />
      ) : null}
      {activeTab === 'follow-ups' ? (
        <QuestionsSection
          title="Дополнительные вопросы"
          description="Для публикации нужны 10 активных вопросов с позициями от 1 до 10 и максимумом 15 баллов каждый."
          type="FOLLOW_UP"
          token={accessToken ?? ''}
          version={version}
          readOnly={readOnly}
          onChanged={loadProject}
        />
      ) : null}
      {activeTab === 'facts' ? (
        <FactsSection
          token={accessToken ?? ''}
          version={version}
          readOnly={readOnly}
          onChanged={loadProject}
        />
      ) : null}
      {activeTab === 'criteria' ? (
        <CriteriaSection
          token={accessToken ?? ''}
          version={version}
          readOnly={readOnly}
          onChanged={loadProject}
        />
      ) : null}
      {activeTab === 'publish' ? (
        <PublishSection
          token={accessToken ?? ''}
          project={project}
          version={version}
          readOnly={readOnly}
          onChanged={loadProject}
          onNavigate={setActiveTab}
        />
      ) : null}
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
}: {
  token: string;
  project: TrainingProject;
  version: TrainingVersion;
  objects: TrainingRealEstateObject[];
  readOnly: boolean;
  onChanged: () => Promise<void>;
}) {
  const [form, setForm] = useState(() => projectToForm(project, version));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectedSection, setSelectedSection] =
    useState<ProjectEditorSection>('project');

  useEffect(() => {
    setForm(projectToForm(project, version));
  }, [project, version]);

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
      setNotice('Основные данные и настройки draft сохранены.');
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
                  section={section}
                  form={form}
                  errors={errors}
                  objects={objects}
                  onChange={setForm}
                />
              </fieldset>
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

function ProjectAndSettingsFields({
  section,
  form,
  errors,
  objects,
  onChange,
}: {
  section?: ProjectEditorSection;
  form: ProjectFormState;
  errors: Record<string, string>;
  objects: TrainingRealEstateObject[];
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
            <FieldLabel htmlFor="training-project-object">
              Объект недвижимости
            </FieldLabel>
            <select
              id="training-project-object"
              className="training-control"
              value={form.realEstateObjectId}
              onChange={(event) => update('realEstateObjectId', event.target.value)}
            >
              <option value="">Без связи с объектом</option>
              {objects.map((object) => (
                <option key={object.id} value={object.id}>
                  {object.title}
                </option>
              ))}
            </select>
            <FieldDescription>Связь опциональна и не влияет на структуру оценки.</FieldDescription>
          </Field>
          <TrainingNumberField
            id="training-project-sort"
            label="Порядок"
            value={form.sortOrder}
            min={0}
            error={errors.sortOrder}
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
}: {
  title: string;
  description: string;
  type: TrainingQuestionType;
  token: string;
  version: TrainingVersion;
  readOnly: boolean;
  onChanged: () => Promise<void>;
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
            description: 'Черновик ещё не сохранён',
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
                  <TrainingMasterAddButton label="Добавить вопрос" onClick={addQuestion} />
                ) : null,
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
                question={question}
                readOnly={readOnly}
                onChanged={onChanged}
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
                question={{
                  id: '',
                  type,
                  text: '',
                  position: type === 'MAIN' ? 1 : nextPosition(questions),
                  isActive: true,
                  maxScore: type === 'MAIN' ? 55 : 15,
                  topicCodesJson: [],
                }}
                readOnly={false}
                onChanged={async (savedId) => {
                  await onChanged();
                  setAdding(false);
                  if (savedId) setSelectedId(savedId);
                }}
                onCancel={() => setAdding(false)}
              />
            </TrainingDetailPanel>
          ) : null}
        </TrainingMasterDetail>
      ) : !readOnly ? (
        <div className="training-empty-action">
          <AdminButton tone="primary" onClick={addQuestion}>
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
  question,
  readOnly,
  onChanged,
  onCancel,
}: {
  token: string;
  versionId: string;
  question: TrainingQuestion;
  readOnly: boolean;
  onChanged: (savedId?: string) => Promise<void>;
  onCancel?: () => void;
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
      await onChanged(response.question.id);
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!question.id || !window.confirm('Удалить вопрос из draft?')) return;
    setSaving(true);
    setError(null);
    try {
      await deleteTrainingQuestion(token, versionId, question.id);
      await onChanged();
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="training-edit-card">
      <div className="training-edit-card-heading">
        <div>
          <strong>
            {question.type === 'MAIN' ? 'Главный вопрос' : `Вопрос ${position}`}
          </strong>
          <span>Максимум: {question.type === 'MAIN' ? 55 : 15} баллов</span>
        </div>
        <TrainingCheckboxRow
          id={`question-active-${question.id || 'new'}`}
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
            <FieldLabel htmlFor={`question-text-${question.id || 'new'}`}>
              Текст вопроса
            </FieldLabel>
            <textarea
              id={`question-text-${question.id || 'new'}`}
              className="training-control training-textarea"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </Field>
          <TrainingTextField
            id={`question-position-${question.id || 'new'}`}
            label="Позиция"
            type="number"
            value={position}
            min={question.type === 'MAIN' ? 1 : 1}
            max={question.type === 'MAIN' ? 1 : 10}
            onChange={setPosition}
          />
          <TrainingTextField
            id={`question-topics-${question.id || 'new'}`}
            label="Коды тем"
            value={topicCodes}
            placeholder="location, product"
            onChange={setTopicCodes}
          />
        </div>
      </fieldset>
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

function FactsSection({
  token,
  version,
  readOnly,
  onChanged,
}: {
  token: string;
  version: TrainingVersion;
  readOnly: boolean;
  onChanged: () => Promise<void>;
}) {
  const [documents, setDocuments] = useState<TrainingDocument[]>([]);
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

  useEffect(() => {
    void listTrainingDocuments(token, version.id)
      .then((response) => setDocuments(response.items))
      .catch(() => setDocuments([]));
  }, [token, version.id]);

  useEffect(() => {
    if (!factIds.includes(selectedId)) {
      setSelectedId(factIds[0] ?? '');
    }
  }, [factSelectionKey, selectedId]);

  const addFact = () => {
    setAdding(true);
    setSelectedId(newFactId);
  };
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
            description: 'Черновик ещё не сохранён',
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
        Текст документов — рабочий черновик. Проверьте формулировку, источник и
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
                  <TrainingMasterAddButton label="Добавить факт" onClick={addFact} />
                ) : null,
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
                readOnly={readOnly}
                onChanged={onChanged}
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
                readOnly={false}
                onChanged={async (savedId) => {
                  await onChanged();
                  setAdding(false);
                  if (savedId) setSelectedId(savedId);
                }}
                onCancel={() => setAdding(false)}
              />
            </TrainingDetailPanel>
          ) : null}
        </TrainingMasterDetail>
      ) : !readOnly ? (
        <div className="training-empty-action">
          <AdminButton tone="primary" onClick={addFact}>
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
  readOnly,
  onChanged,
  onCancel,
}: {
  token: string;
  version: TrainingVersion;
  fact: TrainingFact | null;
  documents: TrainingDocument[];
  readOnly: boolean;
  onChanged: (savedId?: string) => Promise<void>;
  onCancel?: () => void;
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
  const [sourceLocator, setSourceLocator] = useState(
    fact?.sourceLocatorJson ? JSON.stringify(fact.sourceLocatorJson, null, 2) : '',
  );
  const [isApproved, setIsApproved] = useState(fact?.isApproved ?? false);
  const [questionIds, setQuestionIds] = useState(
    new Set(fact?.questionLinks.map((link) => link.questionId) ?? []),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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
        sourceLocator: locator,
        isApproved,
        questionIds: [...questionIds],
      });
      await onChanged(response.fact.id);
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!fact || !window.confirm('Удалить факт из draft?')) return;
    setSaving(true);
    try {
      await deleteTrainingFact(token, version.id, fact.id);
      await onChanged();
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="training-edit-card">
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
            id={`fact-code-${fact?.id ?? 'new'}`}
            label="Код"
            value={code}
            maxLength={120}
            onChange={setCode}
          />
          <TrainingTextField
            id={`fact-topic-${fact?.id ?? 'new'}`}
            label="Код темы"
            value={topicCode}
            maxLength={120}
            onChange={setTopicCode}
          />
          <Field className="training-field-wide">
            <FieldLabel htmlFor={`fact-statement-${fact?.id ?? 'new'}`}>
              Проверенная формулировка
            </FieldLabel>
            <textarea
              id={`fact-statement-${fact?.id ?? 'new'}`}
              className="training-control training-textarea"
              value={statement}
              onChange={(event) => setStatement(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`fact-aliases-${fact?.id ?? 'new'}`}>
              Допустимые варианты
            </FieldLabel>
            <textarea
              id={`fact-aliases-${fact?.id ?? 'new'}`}
              className="training-control training-textarea training-textarea--compact"
              value={aliases}
              placeholder="Один вариант на строку"
              onChange={(event) => setAliases(event.target.value)}
            />
          </Field>
          <TrainingTextField
            id={`fact-importance-${fact?.id ?? 'new'}`}
            label="Важность"
            type="number"
            min={1}
            value={importance}
            onChange={setImportance}
          />
          <Field>
            <FieldLabel htmlFor={`fact-document-${fact?.id ?? 'new'}`}>
              Документ-источник
            </FieldLabel>
            <select
              id={`fact-document-${fact?.id ?? 'new'}`}
              className="training-control"
              value={sourceDocumentId}
              onChange={(event) => setSourceDocumentId(event.target.value)}
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
            <FieldLabel htmlFor={`fact-locator-${fact?.id ?? 'new'}`}>
              Локатор источника
            </FieldLabel>
            <textarea
              id={`fact-locator-${fact?.id ?? 'new'}`}
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
            id={`fact-approved-${fact?.id ?? 'new'}`}
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
}: {
  token: string;
  version: TrainingVersion;
  readOnly: boolean;
  onChanged: () => Promise<void>;
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
    setAddingTypes((current) => {
      const next = new Set(current);
      next.delete(type);
      return next;
    });
  };
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
                description: 'Черновик ещё не сохранён',
                status: 'Новый',
                statusTone: 'warning' as const,
              },
            ]
          : []),
      ],
      action:
        !readOnly && !addingTypes.has(type) ? (
          <TrainingMasterAddButton
            label="Добавить критерий"
            onClick={() => addCriterion(type)}
          />
        ) : null,
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
                  readOnly={readOnly}
                  onChanged={onChanged}
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
                      readOnly={false}
                      onChanged={async (savedId) => {
                        await onChanged();
                        cancelCriterion(type);
                        if (savedId) setSelectedId(savedId);
                      }}
                      onCancel={() => cancelCriterion(type)}
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
              <AdminButton onClick={() => addCriterion('MAIN')}>
                <PlusIcon aria-hidden="true" />
                Для главного вопроса
              </AdminButton>
              <AdminButton onClick={() => addCriterion('FOLLOW_UP')}>
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
  readOnly,
  onChanged,
  onCancel,
}: {
  token: string;
  versionId: string;
  criterion: TrainingCriterion;
  readOnly: boolean;
  onChanged: (savedId?: string) => Promise<void>;
  onCancel?: () => void;
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
      await onChanged(response.criterion.id);
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!criterion.id || !window.confirm('Удалить критерий из draft?')) return;
    setSaving(true);
    try {
      await deleteTrainingCriterion(token, versionId, criterion.id);
      await onChanged();
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="training-edit-card training-edit-card--criterion">
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
            id={`criterion-code-${criterion.id || 'new'}-${criterion.questionType}`}
            label="Код"
            value={code}
            onChange={setCode}
          />
          <TrainingTextField
            id={`criterion-order-${criterion.id || 'new'}-${criterion.questionType}`}
            label="Порядок"
            type="number"
            min={0}
            value={sortOrder}
            onChange={setSortOrder}
          />
          <TrainingTextField
            id={`criterion-title-${criterion.id || 'new'}-${criterion.questionType}`}
            label="Название"
            className="training-field-wide"
            value={title}
            onChange={setTitle}
          />
          <TrainingTextField
            id={`criterion-max-${criterion.id || 'new'}-${criterion.questionType}`}
            label="Максимум баллов"
            type="number"
            min={0.01}
            step="0.01"
            value={maxPoints}
            onChange={setMaxPoints}
          />
          <Field>
            <FieldLabel
              htmlFor={`criterion-description-${criterion.id || 'new'}-${criterion.questionType}`}
            >
              Описание
            </FieldLabel>
            <textarea
              id={`criterion-description-${criterion.id || 'new'}-${criterion.questionType}`}
              className="training-control training-textarea training-textarea--compact"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <Field className="training-field-wide">
            <FieldLabel
              htmlFor={`criterion-anchors-${criterion.id || 'new'}-${criterion.questionType}`}
            >
              Якоря оценки
            </FieldLabel>
            <textarea
              id={`criterion-anchors-${criterion.id || 'new'}-${criterion.questionType}`}
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

function TrainingMaterialsSection({
  token,
  version,
  readOnly,
}: {
  token: string;
  version: TrainingVersion;
  readOnly: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [documents, setDocuments] = useState<TrainingDocument[]>([]);
  const [selected, setSelected] = useState<TrainingDocument | null>(null);
  const [extractedText, setExtractedText] = useState('');
  const [metadata, setMetadata] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadDocuments = useCallback(async () => {
    try {
      const response = await listTrainingDocuments(token, version.id);
      setDocuments(response.items);
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setLoading(false);
    }
  }, [token, version.id]);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  useEffect(() => {
    if (
      !documents.some((document) =>
        ['PENDING', 'PROCESSING'].includes(document.extractionStatus),
      )
    ) {
      return;
    }
    const interval = setInterval(() => void loadDocuments(), 2_500);
    return () => clearInterval(interval);
  }, [documents, loadDocuments]);

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      await uploadTrainingDocument(token, version.id, file);
      setNotice('Документ загружен и поставлен в очередь на извлечение текста.');
      await loadDocuments();
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setUploading(false);
    }
  }

  async function preview(document: TrainingDocument) {
    setError(null);
    try {
      const response = await getTrainingDocumentText(token, version.id, document.id);
      setSelected(response.document);
      setExtractedText(response.extractedText);
      setMetadata(response.extractionMetadata);
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    }
  }

  async function saveText() {
    if (!selected) return;
    setError(null);
    try {
      await updateTrainingDocumentText(
        token,
        version.id,
        selected.id,
        extractedText,
      );
      setNotice('Черновой текст документа сохранён.');
      await loadDocuments();
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    }
  }

  async function retry(document: TrainingDocument) {
    setError(null);
    try {
      await retryTrainingDocument(token, version.id, document.id);
      await loadDocuments();
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    }
  }

  async function remove(document: TrainingDocument) {
    if (!window.confirm(`Удалить «${document.file.originalName ?? 'документ'}»?`)) {
      return;
    }
    setError(null);
    try {
      await deleteTrainingDocument(token, version.id, document.id);
      if (selected?.id === document.id) setSelected(null);
      await loadDocuments();
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
        response.filename ?? document.file.originalName ?? `document.${document.documentType.toLowerCase()}`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    }
  }

  return (
    <AdminPanel className="training-section-panel">
      <SectionHeading
        title="Материалы"
        description="PDF, DOCX, PPTX и XLSX до 50 МБ. Извлечение не использует OCR, макросы, формулы или внешние ссылки."
        actions={
          !readOnly ? (
            <>
              <input
                ref={fileInputRef}
                className="training-hidden-input"
                type="file"
                accept=".pdf,.docx,.pptx,.xlsx"
                onChange={(event) => void upload(event)}
              />
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
                Загрузить
              </AdminButton>
            </>
          ) : null
        }
      />
      <AdminAlert tone="notice">
        Извлечённый текст используется только как черновой материал. Он не
        участвует в оценивании, пока администратор не создаст и не подтвердит
        структурированные факты.
      </AdminAlert>
      {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}
      {notice ? <AdminAlert tone="notice">{notice}</AdminAlert> : null}

      {loading ? (
        <TrainingLoading label="Загружаем материалы" />
      ) : documents.length === 0 ? (
        <AdminEmptyState
          title="Материалы не загружены"
          description="Добавьте один или несколько исходных документов."
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
                  {document.documentType} · {formatBytes(document.file.sizeBytes)} ·{' '}
                  {document.extractedCharacterCount.toLocaleString('ru-RU')} знаков
                </span>
                {document.errorMessage ? (
                  <span className="training-document-error">
                    {document.errorMessage}
                  </span>
                ) : null}
              </div>
              <AdminStatusBadge
                className={`training-document-status training-document-status--${document.extractionStatus.toLowerCase()}`}
              >
                {document.extractionStatus === 'PROCESSING' ? (
                  <LoaderCircleIcon className="training-spin" aria-hidden="true" />
                ) : null}
                {documentStatusLabels[document.extractionStatus]}
              </AdminStatusBadge>
              <div className="training-document-actions">
                <AdminButton tone="text" onClick={() => void preview(document)}>
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
                  <AdminButton tone="text" onClick={() => void retry(document)}>
                    <RefreshCwIcon aria-hidden="true" />
                    Повторить
                  </AdminButton>
                ) : null}
                {!readOnly &&
                !['PENDING', 'PROCESSING'].includes(document.extractionStatus) ? (
                  <AdminButton tone="text" onClick={() => void remove(document)}>
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
              <h3>{selected.file.originalName ?? 'Текст документа'}</h3>
              <p>
                Проверьте текст. Для сканов без текстового слоя внесите черновик
                вручную.
              </p>
            </div>
            <AdminButton tone="text" onClick={() => setSelected(null)}>
              Закрыть
            </AdminButton>
          </div>
          <textarea
            className="training-control training-document-text"
            value={extractedText}
            readOnly={readOnly}
            onChange={(event) => setExtractedText(event.target.value)}
          />
          <details>
            <summary>Технические локаторы извлечения</summary>
            <pre>{JSON.stringify(metadata, null, 2)}</pre>
          </details>
          {!readOnly ? (
            <div className="training-form-actions">
              <AdminButton tone="primary" onClick={() => void saveText()}>
                <SaveIcon aria-hidden="true" />
                Сохранить черновой текст
              </AdminButton>
            </div>
          ) : null}
        </section>
      ) : null}
    </AdminPanel>
  );
}

function PublishSection({
  token,
  project,
  version,
  readOnly,
  onChanged,
  onNavigate,
}: {
  token: string;
  project: TrainingProject;
  version: TrainingVersion;
  readOnly: boolean;
  onChanged: () => Promise<void>;
  onNavigate: (tab: EditorTab) => void;
}) {
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const validation = collectPublicationErrors(project, version);
  const allErrors = [
    ...validation,
    ...serverErrors.map((message) => ({ section: 'publish' as const, message })),
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
        description="Предпросмотр использует только текущий draft. Публикация создаёт неизменяемую активную версию."
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
          </dl>
        </section>
      </div>

      {version.status === 'PUBLISHED' && project.status !== 'ARCHIVED' ? (
        <section className="training-lifecycle">
          <div>
            <h3>Доступ сотрудникам</h3>
            <p>Управление состоянием опубликованного проекта.</p>
          </div>
          <div className="training-card-actions">
            {project.status !== 'OPEN' ? (
              <AdminButton
                tone="success"
                disabled={pending}
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
          <span>Выбранный раздел</span>
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
            aria-label="Добавление элементов"
          >
            {groups.map((group) =>
              group.action ? (
                <div key={group.id} className="training-master-mobile-action">
                  <span>{group.label}</span>
                  {group.action}
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
              {group.action}
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
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
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
      aria-label={label}
      data-editor-panel-id={id}
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
  label,
  description,
  checked,
  disabled = false,
  compact = false,
  className,
  onChange,
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  compact?: boolean;
  className?: string;
  onChange: (checked: boolean) => void;
}) {
  const descriptionId = description ? `${id}-description` : undefined;
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
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={descriptionId}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="training-checkbox-copy">
        <strong>{label}</strong>
        {description ? <span id={descriptionId}>{description}</span> : null}
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
        <h2>{title}</h2>
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
  className,
  onChange,
  ...inputProps
}: {
  id: string;
  label: string;
  value: string;
  error?: string;
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
      <FieldError>{error}</FieldError>
    </Field>
  );
}

function TrainingNumberField({
  id,
  label,
  value,
  error,
  onChange,
  ...inputProps
}: {
  id: string;
  label: string;
  value: string;
  error?: string;
  onChange: (value: string) => void;
} & Omit<React.ComponentProps<typeof Input>, 'id' | 'type' | 'value' | 'onChange'>) {
  return (
    <TrainingTextField
      id={id}
      label={label}
      type="number"
      value={value}
      error={error}
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
    errors.sortOrder = 'Порядок должен быть целым числом от 0.';
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
  const errors: Array<{ section: EditorTab; message: string }> = [];
  const main = version.questions.filter(
    (question) => question.type === 'MAIN' && question.isActive,
  );
  const followUps = version.questions.filter(
    (question) => question.type === 'FOLLOW_UP' && question.isActive,
  );
  if (main.length !== 1) {
    errors.push({
      section: 'main-question',
      message: 'Нужен ровно один активный главный вопрос.',
    });
  }
  if (followUps.length !== 10) {
    errors.push({
      section: 'follow-ups',
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
      section: 'follow-ups',
      message: 'Позиции дополнительных вопросов должны покрывать диапазон 1–10.',
    });
  }
  if (version.facts.length === 0) {
    errors.push({ section: 'facts', message: 'Добавьте структурированные факты.' });
  } else if (version.facts.some((fact) => !fact.isApproved)) {
    errors.push({
      section: 'facts',
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
