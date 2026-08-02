import { FormEvent, useEffect, useState } from 'react';
import type {
  TrainingAdminProjectSummary,
} from '@platforma/shared';

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
  createTrainingAdminProject,
  getTrainingAdminProjects,
} from './trainingApi';
import {
  getTrainingStatusClass,
  trainingProjectStatusLabels,
} from './trainingView';

type TrainingAdminProjectsPageProps = {
  canManageProjects: boolean;
  canReadResults: boolean;
  navigate: (pathname: string) => void;
};

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
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

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
      setError('Введите название проекта');
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      const project = await createTrainingAdminProject(accessToken, {
        title: title.trim(),
        allowRetakeAfterPass,
        accessMode: 'ASSIGNED_USERS',
      });
      navigate(`/admin/training/projects/${project.id}`);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Не удалось создать проект');
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="training-page training-admin-page">
      <header className="training-page-header">
        <div>
          <p className="eyebrow">Админка · Обучение</p>
          <h2>Training V2</h2>
          <p className="muted-text">Управление проектами и отдельный реестр результатов Training V2.</p>
        </div>
        {canReadResults ? <AdminButton type="button" tone="primary" onClick={() => navigate('/admin/training/results')}>Результаты сотрудников</AdminButton> : null}
      </header>

      {error ? (
        <AdminAlert tone="error">
          <span>{error}</span>
          <AdminButton type="button" tone="text" onClick={() => setReloadKey((value) => value + 1)}>Повторить</AdminButton>
        </AdminAlert>
      ) : null}

      {canManageProjects ? (
        <AdminPanel className="training-create-panel">
          <div>
            <p className="eyebrow">Новый проект</p>
            <h3>Создать черновик</h3>
          </div>
          <form onSubmit={(event) => void handleCreate(event)}>
            <FieldGroup>
              <Field data-invalid={Boolean(error && !title.trim())}>
                <FieldLabel htmlFor="training-project-title">Название</FieldLabel>
                <Input id="training-project-title" value={title} aria-invalid={Boolean(error && !title.trim())} onChange={(event) => setTitle(event.target.value)} />
                {!title.trim() && error ? <FieldError>{error}</FieldError> : null}
              </Field>
              <Field orientation="horizontal">
                <input id="training-project-retake" type="checkbox" checked={allowRetakeAfterPass} onChange={(event) => setAllowRetakeAfterPass(event.target.checked)} />
                <div>
                  <FieldLabel htmlFor="training-project-retake">Разрешить пересдачу после успешного результата</FieldLabel>
                  <FieldDescription>Общий лимит попыток продолжает действовать.</FieldDescription>
                </div>
              </Field>
            </FieldGroup>
            <AdminButton type="submit" tone="primary" disabled={isCreating}>{isCreating ? 'Создание…' : 'Создать и настроить'}</AdminButton>
          </form>
        </AdminPanel>
      ) : null}

      {canManageProjects ? (
        <section aria-labelledby="training-admin-projects-title">
          <div className="training-section-heading"><h3 id="training-admin-projects-title">Проекты</h3><span className="training-section-count">{projects.length}</span></div>
          {isLoading ? <Skeleton className="training-list-skeleton" /> : projects.length ? (
            <div className="training-admin-list">
              {projects.map((project) => (
                <button type="button" className="training-admin-row" key={project.id} onClick={() => navigate(`/admin/training/projects/${project.id}`)}>
                  <span><strong>{project.title}</strong><small>{project.questionsCount} вопросов · {project.attemptsCount} попыток</small><small>{project.accessMode === 'ALL_PARTICIPANTS' ? 'Все участники' : `По назначениям · ${project.activeAssignments}`}</small></span>
                  <span><AdminStatusBadge className={getTrainingStatusClass(project.status)}>{trainingProjectStatusLabels[project.status]}{project.isOpen ? ' · открыт' : ''}</AdminStatusBadge><small>{project.timeLimitSeconds / 60} мин</small></span>
                </button>
              ))}
            </div>
          ) : <AdminEmptyState title="Проектов пока нет" description="Создайте первый черновик выше." />}
        </section>
      ) : null}

      {canReadResults ? (
        <AdminPanel className="training-results-entry">
          <div><p className="eyebrow">Результаты</p><h3>История сотрудников</h3><p className="muted-text">Фильтры, серверная пагинация, detail, review и защищённое аудио доступны в отдельном разделе.</p></div>
          <AdminButton type="button" tone="primary" onClick={() => navigate('/admin/training/results')}>Открыть результаты</AdminButton>
        </AdminPanel>
      ) : null}
    </div>
  );
}
