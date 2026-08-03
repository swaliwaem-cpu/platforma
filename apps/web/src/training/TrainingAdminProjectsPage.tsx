import { FormEvent, useEffect, useState } from 'react';
import type {
  TrainingAdminProjectSummary,
} from '@platforma/shared';
import {
  ArrowRightIcon,
  BadgeCheckIcon,
  BarChart3Icon,
  ClipboardCheckIcon,
  FilePenLineIcon,
  FolderKanbanIcon,
  FolderPlusIcon,
  TrophyIcon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import {
  AdminAlert,
  AdminButton,
  AdminEmptyState,
  AdminPanel,
  AdminStatusBadge,
} from '../admin/AdminUi';
import { useAuth } from '../auth/AuthProvider';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  createTrainingAdminProject,
  getTrainingAdminProjects,
} from './trainingApi';
import {
  getTrainingStatusClass,
  trainingProjectStatusLabels,
} from './trainingView';
import './trainingAdminDashboard.css';

type TrainingAdminProjectsPageProps = {
  canManageProjects: boolean;
  canReadResults: boolean;
  navigate: (pathname: string) => void;
};

type TrainingDashboardMetricProps = {
  icon: LucideIcon;
  label: string;
  value: number | null;
  tone?: 'default' | 'success';
};

function TrainingDashboardMetric({
  icon: Icon,
  label,
  tone = 'default',
  value,
}: TrainingDashboardMetricProps) {
  return (
    <AdminPanel className="training-dashboard-metric" data-tone={tone}>
      <span className="training-dashboard-metric-icon" aria-hidden="true">
        <Icon />
      </span>
      <span className="training-dashboard-metric-copy">
        <small>{label}</small>
        {value === null ? (
          <Skeleton className="training-dashboard-metric-skeleton" />
        ) : (
          <strong>{value}</strong>
        )}
      </span>
    </AdminPanel>
  );
}

export function TrainingAdminProjectsPage({
  canManageProjects,
  canReadResults,
  navigate,
}: TrainingAdminProjectsPageProps) {
  const { accessToken } = useAuth();
  const [projects, setProjects] = useState<TrainingAdminProjectSummary[]>([]);
  const [title, setTitle] = useState('');
  const [allowRetakeAfterPass, setAllowRetakeAfterPass] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const dashboardSummary = projects.reduce(
    (summary, project) => {
      if (project.status === 'PUBLISHED') summary.published += 1;
      if (project.status === 'DRAFT') summary.drafts += 1;
      summary.attempts += project.attemptsCount;
      return summary;
    },
    { published: 0, drafts: 0, attempts: 0 },
  );

  useEffect(() => {
    if (!accessToken) return;

    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    void (canManageProjects
      ? getTrainingAdminProjects(accessToken, controller.signal)
      : Promise.resolve({ items: [] }))
      .then((projectResponse) => {
        if (controller.signal.aborted) return;
        setProjects(projectResponse.items);
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить обучение');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, [accessToken, canManageProjects, reloadKey]);

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();

    if (!accessToken || !canManageProjects || isCreating) return;

    if (!title.trim()) {
      setCreateError('Введите название проекта');
      return;
    }

    setIsCreating(true);
    setCreateError(null);

    try {
      const project = await createTrainingAdminProject(accessToken, {
        title: title.trim(),
        allowRetakeAfterPass,
        accessMode: 'ASSIGNED_USERS',
      });
      navigate(`/admin/training/projects/${project.id}`);
    } catch (createError) {
      setCreateError(createError instanceof Error ? createError.message : 'Не удалось создать проект');
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="training-page training-admin-page training-admin-dashboard">
      <header className="training-page-header">
        <div>
          <p className="eyebrow">Админка · Обучение</p>
          <h2>Модуль обучения</h2>
          <p className="muted-text">Управление учебными проектами и отдельный реестр результатов.</p>
        </div>
        {canReadResults || canManageProjects ? (
          <div className="training-admin-dashboard-actions">
            {canReadResults ? (
              <>
                <AdminButton
                  className="training-dashboard-icon-action"
                  type="button"
                  tone="secondary"
                  size="icon"
                  aria-label="Результаты сотрудников"
                  title="Результаты сотрудников"
                  onClick={() => navigate('/admin/training/results')}
                >
                  <BarChart3Icon />
                </AdminButton>
                <AdminButton
                  className="training-dashboard-icon-action"
                  type="button"
                  tone="secondary"
                  size="icon"
                  aria-label="Рейтинг"
                  title="Рейтинг"
                  onClick={() => navigate('/admin/training/ranking')}
                >
                  <TrophyIcon />
                </AdminButton>
              </>
            ) : null}
            {canManageProjects ? (
              <AdminButton
                className="training-dashboard-create-action"
                type="button"
                tone="primary"
                onClick={() => {
                  setCreateError(null);
                  setIsCreateDialogOpen(true);
                }}
              >
                <FolderPlusIcon data-icon="inline-start" />
                Создать проект
              </AdminButton>
            ) : null}
          </div>
        ) : null}
      </header>

      {error ? (
        <AdminAlert tone="error">
          <span>{error}</span>
          <AdminButton type="button" tone="text" onClick={() => setReloadKey((value) => value + 1)}>Повторить</AdminButton>
        </AdminAlert>
      ) : null}

      {canManageProjects ? (
        <section className="training-dashboard-metrics" aria-label="Сводка по проектам">
          <TrainingDashboardMetric
            icon={FolderKanbanIcon}
            label="Всего проектов"
            value={isLoading ? null : projects.length}
          />
          <TrainingDashboardMetric
            icon={BadgeCheckIcon}
            label="Опубликовано"
            tone="success"
            value={isLoading ? null : dashboardSummary.published}
          />
          <TrainingDashboardMetric
            icon={FilePenLineIcon}
            label="Черновики"
            value={isLoading ? null : dashboardSummary.drafts}
          />
          <TrainingDashboardMetric
            icon={ClipboardCheckIcon}
            label="Попытки"
            value={isLoading ? null : dashboardSummary.attempts}
          />
        </section>
      ) : null}

      {canManageProjects ? (
        <>
          <AdminPanel className="training-dashboard-project-panel">
            <div className="training-dashboard-panel-heading">
              <div>
                <h3 id="training-admin-projects-title">Проекты</h3>
                <p>Управляйте настройками, доступом и публикацией.</p>
              </div>
              <span className="training-section-count" aria-label={`Проектов: ${projects.length}`}>
                {projects.length}
              </span>
            </div>

            {isLoading ? (
              <Skeleton className="training-dashboard-list-skeleton" />
            ) : projects.length ? (
              <div className="training-dashboard-project-table" aria-labelledby="training-admin-projects-title">
                <div className="training-dashboard-project-head" aria-hidden="true">
                  <span>Название проекта</span>
                  <span>Статус</span>
                  <span>Вопросы</span>
                  <span>Попытки</span>
                  <span>Доступ</span>
                  <span>Время</span>
                  <span />
                </div>
                <div className="training-dashboard-project-list">
                  {projects.map((project) => (
                    <button
                      type="button"
                      className="training-dashboard-project-row"
                      key={project.id}
                      aria-label={`Открыть проект «${project.title}»`}
                      onClick={() => navigate(`/admin/training/projects/${project.id}`)}
                    >
                      <span className="training-dashboard-project-name">
                        <FolderKanbanIcon aria-hidden="true" />
                        <strong>{project.title}</strong>
                      </span>
                      <span className="training-dashboard-project-status">
                        <AdminStatusBadge className={getTrainingStatusClass(project.status)}>
                          {trainingProjectStatusLabels[project.status]}
                          {project.isOpen ? ' · открыт' : ''}
                        </AdminStatusBadge>
                      </span>
                      <span
                        className="training-dashboard-project-cell training-dashboard-project-cell--questions"
                        data-label="Вопросы"
                      >
                        {project.questionsCount}
                      </span>
                      <span
                        className="training-dashboard-project-cell training-dashboard-project-cell--attempts"
                        data-label="Попытки"
                      >
                        {project.attemptsCount}
                      </span>
                      <span
                        className="training-dashboard-project-cell training-dashboard-project-cell--access"
                        data-label="Доступ"
                      >
                        {project.accessMode === 'ALL_PARTICIPANTS'
                          ? 'Все участники'
                          : `По назначениям · ${project.activeAssignments}`}
                      </span>
                      <span
                        className="training-dashboard-project-cell training-dashboard-project-cell--time"
                        data-label="Время"
                      >
                        {project.timeLimitSeconds / 60} мин
                      </span>
                      <span className="training-dashboard-project-arrow" aria-hidden="true">
                        <ArrowRightIcon />
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="training-dashboard-empty">
                <AdminEmptyState title="Проектов пока нет" description="Создайте первый черновик кнопкой сверху." />
              </div>
            )}
          </AdminPanel>

          <Dialog
            open={isCreateDialogOpen}
            onOpenChange={(open) => {
              if (isCreating) return;
              setIsCreateDialogOpen(open);
              if (!open) setCreateError(null);
            }}
          >
            <DialogContent
              className="training-create-dialog"
              showCloseButton={!isCreating}
              onEscapeKeyDown={(event) => {
                if (isCreating) event.preventDefault();
              }}
              onPointerDownOutside={(event) => {
                if (isCreating) event.preventDefault();
              }}
            >
              <DialogHeader>
                <DialogTitle>Создать проект</DialogTitle>
                <DialogDescription>
                  Создайте черновик и перейдите к материалам, вопросам и настройкам доступа.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={(event) => void handleCreate(event)}>
                <FieldGroup>
                  <Field
                    data-disabled={isCreating || undefined}
                    data-invalid={Boolean(createError && !title.trim())}
                  >
                    <FieldLabel htmlFor="training-project-title">Название проекта *</FieldLabel>
                    <Input
                      id="training-project-title"
                      value={title}
                      required
                      autoComplete="off"
                      placeholder="Введите название проекта"
                      disabled={isCreating}
                      aria-invalid={Boolean(createError && !title.trim())}
                      onChange={(event) => setTitle(event.target.value)}
                    />
                    {!title.trim() && createError ? <FieldError>{createError}</FieldError> : null}
                  </Field>
                  <Field
                    className="training-dashboard-retake-field"
                    data-disabled={isCreating || undefined}
                    orientation="horizontal"
                  >
                    <input
                      id="training-project-retake"
                      type="checkbox"
                      checked={allowRetakeAfterPass}
                      disabled={isCreating}
                      onChange={(event) => setAllowRetakeAfterPass(event.target.checked)}
                    />
                    <div>
                      <FieldLabel htmlFor="training-project-retake">
                        Разрешить пересдачу после успешного результата
                      </FieldLabel>
                      <FieldDescription>Общий лимит попыток продолжает действовать.</FieldDescription>
                    </div>
                  </Field>
                </FieldGroup>
                {createError && title.trim() ? <AdminAlert tone="error">{createError}</AdminAlert> : null}
                <DialogFooter>
                  <AdminButton
                    type="button"
                    tone="secondary"
                    disabled={isCreating}
                    onClick={() => setIsCreateDialogOpen(false)}
                  >
                    Отмена
                  </AdminButton>
                  <AdminButton type="submit" tone="primary" disabled={isCreating}>
                    {isCreating ? 'Создание…' : 'Создать и настроить'}
                    {!isCreating ? <ArrowRightIcon data-icon="inline-end" /> : null}
                  </AdminButton>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </>
      ) : null}

    </div>
  );
}
