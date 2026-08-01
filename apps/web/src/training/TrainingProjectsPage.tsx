import { useEffect, useRef, useState } from 'react';
import type {
  TrainingEmployeeAttemptSummary,
  TrainingEmployeeProject,
} from '@platforma/shared';

import { AdminAlert, AdminButton, AdminEmptyState, AdminStatusBadge } from '../admin/AdminUi';
import { useAuth } from '../auth/AuthProvider';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  getTrainingAttempts,
  getTrainingProjects,
  startTrainingAttempt,
} from './trainingApi';
import {
  formatTrainingDate,
  getTrainingResultLabel,
  getTrainingStatusClass,
  trainingAttemptStatusLabels,
} from './trainingView';

type TrainingProjectsPageProps = {
  navigate: (pathname: string) => void;
};

export function TrainingProjectsPage({ navigate }: TrainingProjectsPageProps) {
  const { accessToken } = useAuth();
  const [projects, setProjects] = useState<TrainingEmployeeProject[]>([]);
  const [attempts, setAttempts] = useState<TrainingEmployeeAttemptSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [startingProjectId, setStartingProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const startIdempotencyKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;

    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    void Promise.all([
      getTrainingProjects(accessToken, controller.signal),
      getTrainingAttempts(accessToken, controller.signal),
    ])
      .then(([projectResponse, attemptResponse]) => {
        if (controller.signal.aborted) return;
        setProjects(projectResponse.items);
        setAttempts(attemptResponse.items);
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
  }, [accessToken, reloadKey]);

  const handleStart = async (project: TrainingEmployeeProject) => {
    if (!accessToken) return;

    if (
      !window.confirm(
        `Начать попытку «${project.title}»? После подтверждения попытка считается использованной, а таймер не останавливается.`,
      )
    ) {
      return;
    }

    const idempotencyKey = startIdempotencyKeyRef.current ?? crypto.randomUUID();
    startIdempotencyKeyRef.current = idempotencyKey;
    setStartingProjectId(project.id);
    setError(null);

    try {
      const attempt = await startTrainingAttempt(accessToken, project.id, idempotencyKey, {
        confirmed: true,
      });
      startIdempotencyKeyRef.current = null;
      navigate(`/training/attempts/${attempt.id}`);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'Не удалось начать попытку');
    } finally {
      setStartingProjectId(null);
    }
  };

  return (
    <div className="training-page">
      <header className="training-page-header">
        <div>
          <p className="eyebrow">Обучение</p>
          <h2>Учебные проекты</h2>
          <p className="muted-text">Проходите открытые экзамены и возвращайтесь к своим результатам.</p>
        </div>
      </header>

      {error ? (
        <AdminAlert tone="error">
          <span>{error}</span>
          <AdminButton type="button" tone="text" onClick={() => setReloadKey((value) => value + 1)}>
            Повторить
          </AdminButton>
        </AdminAlert>
      ) : null}

      <section aria-labelledby="training-projects-title">
        <div className="training-section-heading">
          <h3 id="training-projects-title">Доступные проекты</h3>
          <span className="training-section-count">{projects.length}</span>
        </div>

        {isLoading ? (
          <div className="training-card-grid" aria-label="Загрузка проектов">
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton className="training-card-skeleton" key={index} />
            ))}
          </div>
        ) : projects.length ? (
          <div className="training-card-grid">
            {projects.map((project) => (
              <Card key={project.id}>
                <CardHeader>
                  <CardTitle>{project.title}</CardTitle>
                  <CardDescription>{project.description ?? 'Описание пока не добавлено.'}</CardDescription>
                  <CardAction>
                    <AdminStatusBadge className={getTrainingStatusClass(project.status)}>
                      {getTrainingResultLabel(project.status)}
                    </AdminStatusBadge>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <dl className="training-metrics">
                    <div><dt>Попытки</dt><dd>{project.attemptsUsed} / {project.attemptLimit}</dd></div>
                    <div><dt>Время</dt><dd>{project.timeLimitSeconds / 60} мин</dd></div>
                    <div><dt>Проходной балл</dt><dd>{project.passScore}</dd></div>
                    <div><dt>Лучший результат</dt><dd>{project.bestConfirmedScore ?? '—'}</dd></div>
                  </dl>
                  {project.hasPendingReview ? (
                    <p className="training-pending-note">Есть попытка, требующая проверки.</p>
                  ) : null}
                </CardContent>
                <CardFooter>
                  {project.activeAttempt ? (
                    <AdminButton type="button" tone="primary" onClick={() => navigate(`/training/attempts/${project.activeAttempt?.id}`)}>
                      Продолжить попытку
                    </AdminButton>
                  ) : (
                    <AdminButton
                      type="button"
                      tone="primary"
                      disabled={!project.canStart || startingProjectId !== null}
                      onClick={() => void handleStart(project)}
                    >
                      {startingProjectId === project.id ? 'Запуск…' : 'Начать попытку'}
                    </AdminButton>
                  )}
                </CardFooter>
              </Card>
            ))}
          </div>
        ) : (
          <AdminEmptyState title="Нет открытых проектов" description="Новые учебные проекты появятся здесь после публикации." />
        )}
      </section>

      <section aria-labelledby="training-history-title">
        <div className="training-section-heading">
          <h3 id="training-history-title">Мои попытки</h3>
          <span className="training-section-count">{attempts.length}</span>
        </div>
        {!isLoading && attempts.length ? (
          <div className="training-history-list">
            {attempts.map((attempt) => (
              <button className="training-history-row" type="button" key={attempt.id} onClick={() => navigate(`/training/attempts/${attempt.id}`)}>
                <span><strong>{attempt.projectTitle}</strong><small>Попытка №{attempt.attemptNumber} · {formatTrainingDate(attempt.startedAt)}</small></span>
                <span><AdminStatusBadge className={getTrainingStatusClass(attempt.status)}>{trainingAttemptStatusLabels[attempt.status]}</AdminStatusBadge><strong>{attempt.finalScore ?? '—'}</strong></span>
              </button>
            ))}
          </div>
        ) : !isLoading ? (
          <AdminEmptyState title="Попыток пока нет" description="Начатые и завершённые попытки будут сохраняться здесь." />
        ) : null}
      </section>
    </div>
  );
}
