import { useEffect, useState } from 'react';
import type { TrainingAdminAttempt } from '@platforma/shared';

import { AdminAlert, AdminButton, AdminPanel, AdminStatusBadge } from '../admin/AdminUi';
import { useAuth } from '../auth/AuthProvider';
import { Skeleton } from '@/components/ui/skeleton';
import { getTrainingAdminAttempt } from './trainingApi';
import {
  formatTrainingDate,
  getTrainingStatusClass,
  trainingAttemptStatusLabels,
} from './trainingView';

type TrainingAdminAttemptPageProps = {
  attemptId: string;
  navigate: (pathname: string) => void;
};

export function TrainingAdminAttemptPage({
  attemptId,
  navigate,
}: TrainingAdminAttemptPageProps) {
  const { accessToken } = useAuth();
  const [attempt, setAttempt] = useState<TrainingAdminAttempt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!accessToken) return;

    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    void getTrainingAdminAttempt(accessToken, attemptId, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) setAttempt(response);
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить попытку');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, [accessToken, attemptId, reloadKey]);

  if (isLoading) return <div className="training-page"><Skeleton className="training-attempt-skeleton" /></div>;

  if (!attempt) {
    return (
      <div className="training-page">
        <AdminAlert tone="error">
          <span>{error ?? 'Попытка не найдена'}</span>
          <AdminButton
            type="button"
            tone="text"
            onClick={() => setReloadKey((value) => value + 1)}
          >
            Повторить
          </AdminButton>
        </AdminAlert>
        <AdminButton type="button" onClick={() => navigate('/admin/training')}>К списку</AdminButton>
      </div>
    );
  }

  return (
    <div className="training-page training-admin-page">
      <header className="training-page-header">
        <div><p className="eyebrow">Админка · Попытка №{attempt.attemptNumber}</p><h2>{attempt.project.title}</h2><p className="muted-text">{attempt.user.name ?? attempt.user.email} · {attempt.user.email}</p></div>
        <AdminStatusBadge className={getTrainingStatusClass(attempt.status)}>{trainingAttemptStatusLabels[attempt.status]}</AdminStatusBadge>
      </header>

      {error ? <AdminAlert tone="error"><span>{error}</span><AdminButton type="button" tone="text" onClick={() => setReloadKey((value) => value + 1)}>Повторить</AdminButton></AdminAlert> : null}

      <div className="training-toolbar"><AdminButton type="button" tone="text" onClick={() => navigate('/admin/training')}>К проектам и попыткам</AdminButton></div>

      <AdminPanel className="training-attempt-summary">
        <dl className="training-metrics training-metrics--wide">
          <div><dt>Старт</dt><dd>{formatTrainingDate(attempt.startedAt)}</dd></div>
          <div><dt>Deadline</dt><dd>{formatTrainingDate(attempt.expiresAt)}</dd></div>
          <div><dt>Завершение</dt><dd>{formatTrainingDate(attempt.completedAt)}</dd></div>
          <div><dt>Итог</dt><dd>{attempt.finalScore ?? '—'} / 100</dd></div>
          <div><dt>Pass score snapshot</dt><dd>{attempt.project.settings.passScore}</dd></div>
          <div><dt>Evaluator</dt><dd>{attempt.fakeEvaluationVersion}</dd></div>
        </dl>
      </AdminPanel>

      <section aria-labelledby="training-admin-answers-title">
        <div className="training-section-heading"><h3 id="training-admin-answers-title">Вопросы и ответы</h3><span className="training-section-count">{attempt.questions.length}</span></div>
        <div className="training-admin-answers">
          {attempt.questions.map((question) => (
            <AdminPanel className="training-admin-answer" key={question.id}>
              <div className="training-question-progress"><span>Вопрос {question.sequence} · {question.type === 'MAIN' ? 'главный' : 'дополнительный'}</span><strong>{question.answer?.score ?? 0} / {question.maxScore}</strong></div>
              <h3>{question.text}</h3>
              {question.answer ? (
                <div className="training-answer-copy"><p>{question.answer.text}</p><small>{question.answer.fakeOutcome} · {formatTrainingDate(question.answer.submittedAt)}</small></div>
              ) : (
                <p className="muted-text">Ответ отсутствует: {question.status === 'SKIPPED_TIMEOUT' ? 'время истекло' : 'вопрос ожидает ответа'}.</p>
              )}
            </AdminPanel>
          ))}
        </div>
      </section>
    </div>
  );
}
