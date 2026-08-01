import { FormEvent, useEffect, useRef, useState } from 'react';
import type { TrainingEmployeeAttempt } from '@platforma/shared';

import { AdminAlert, AdminButton, AdminPanel, AdminStatusBadge } from '../admin/AdminUi';
import { useAuth } from '../auth/AuthProvider';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { getTrainingAttempt, submitTrainingAnswer } from './trainingApi';
import {
  formatTrainingDuration,
  getTrainingResultLabel,
  getTrainingStatusClass,
  trainingAttemptStatusLabels,
} from './trainingView';

type TrainingAttemptPageProps = {
  attemptId: string;
  navigate: (pathname: string) => void;
};

export function TrainingAttemptPage({ attemptId, navigate }: TrainingAttemptPageProps) {
  const { accessToken } = useAuth();
  const [attempt, setAttempt] = useState<TrainingEmployeeAttempt | null>(null);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [reloadKey, setReloadKey] = useState(0);
  const [timeoutRefreshKey, setTimeoutRefreshKey] = useState(0);
  const timeoutRefreshAttemptRef = useRef<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;

    const controller = new AbortController();
    setIsLoading(true);
    setError(null);
    timeoutRefreshAttemptRef.current = null;

    void getTrainingAttempt(accessToken, attemptId, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) {
          setAttempt(response);
          setNow(Date.now());
        }
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

  useEffect(() => {
    if (!attempt || attempt.status !== 'IN_PROGRESS') return;

    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [attempt]);

  const remainingSeconds = attempt
    ? Math.max(0, Math.ceil((new Date(attempt.expiresAt).getTime() - now) / 1000))
    : 0;

  useEffect(() => {
    if (
      !accessToken ||
      !attempt ||
      attempt.status !== 'IN_PROGRESS' ||
      remainingSeconds > 0 ||
      timeoutRefreshAttemptRef.current === attempt.id
    ) {
      return;
    }

    const controller = new AbortController();
    let retryTimer: number | undefined;
    timeoutRefreshAttemptRef.current = attempt.id;

    void getTrainingAttempt(accessToken, attempt.id, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;

        if (response.status === 'IN_PROGRESS') {
          timeoutRefreshAttemptRef.current = null;
          retryTimer = window.setTimeout(
            () => setTimeoutRefreshKey((value) => value + 1),
            1000,
          );
          return;
        }

        setAttempt(response);
      })
      .catch((refreshError: unknown) => {
        if (!controller.signal.aborted) {
          timeoutRefreshAttemptRef.current = null;
          setError(
            refreshError instanceof Error
              ? refreshError.message
              : 'Не удалось обновить timeout',
          );
        }
      });

    return () => {
      controller.abort();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [accessToken, attempt, remainingSeconds, timeoutRefreshKey]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();

    if (!accessToken || !attempt?.currentQuestion || isSubmitting) return;

    if (!answer.trim()) {
      setError('Введите текст ответа');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const updatedAttempt = await submitTrainingAnswer(accessToken, attempt.id, {
        attemptQuestionId: attempt.currentQuestion.id,
        text: answer.trim(),
      });
      setAttempt(updatedAttempt);
      setAnswer('');
      setNow(Date.now());
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Не удалось отправить ответ');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="training-page" aria-label="Загрузка попытки">
        <Skeleton className="training-attempt-skeleton" />
      </div>
    );
  }

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
        <AdminButton type="button" tone="secondary" onClick={() => navigate('/training')}>К проектам</AdminButton>
      </div>
    );
  }

  const resultLabel = attempt.result
    ? attempt.status === 'REQUIRES_REVIEW'
      ? getTrainingResultLabel('REQUIRES_REVIEW')
      : getTrainingResultLabel(null, attempt.result.isPassed)
    : trainingAttemptStatusLabels[attempt.status];

  return (
    <div className="training-page training-attempt-page">
      <header className="training-page-header">
        <div>
          <p className="eyebrow">Обучение · Попытка №{attempt.attemptNumber}</p>
          <h2>{attempt.project.title}</h2>
        </div>
        <div className="training-attempt-status">
          <AdminStatusBadge className={getTrainingStatusClass(attempt.status)}>{resultLabel}</AdminStatusBadge>
          <div className="training-timer" aria-live="polite" aria-label={`Осталось ${formatTrainingDuration(remainingSeconds)}`}>
            <span>Осталось</span><strong>{formatTrainingDuration(remainingSeconds)}</strong>
          </div>
        </div>
      </header>

      {error ? (
        <AdminAlert tone="error">
          <span>{error}</span>
          <AdminButton type="button" tone="text" onClick={() => setReloadKey((value) => value + 1)}>Обновить</AdminButton>
        </AdminAlert>
      ) : null}

      {attempt.currentQuestion ? (
        <AdminPanel className="training-question-panel">
          <div className="training-question-progress">
            <span>Вопрос {attempt.currentQuestion.sequence} из {attempt.totalQuestions}</span>
            <strong>до {attempt.currentQuestion.maxScore} баллов</strong>
          </div>
          <h3>{attempt.currentQuestion.text}</h3>
          <form className="training-answer-form" onSubmit={(event) => void handleSubmit(event)}>
            <Field data-invalid={Boolean(error && !answer.trim())}>
              <FieldLabel htmlFor="training-answer">Текст ответа</FieldLabel>
              <textarea
                id="training-answer"
                className="training-textarea"
                value={answer}
                rows={7}
                disabled={isSubmitting || remainingSeconds === 0}
                aria-invalid={Boolean(error && !answer.trim())}
                onChange={(event) => setAnswer(event.target.value)}
              />
              <FieldDescription>
                Development/test fallback Stage 2. Основной продуктовый сценарий проходит голосом в Telegram.
              </FieldDescription>
              <FieldDescription>
                Dev-маркеры: <code>[fake:pass]</code>, <code>[fake:fail]</code>, <code>[fake:review]</code>.
              </FieldDescription>
              {!answer.trim() && error ? <FieldError>{error}</FieldError> : null}
            </Field>
            <AdminButton type="submit" tone="primary" disabled={isSubmitting || remainingSeconds === 0}>
              {isSubmitting ? 'Отправка…' : 'Отправить ответ'}
            </AdminButton>
          </form>
        </AdminPanel>
      ) : attempt.result ? (
        <AdminPanel className="training-result-panel">
          <p className="eyebrow">Результат</p>
          <div className="training-result-score">
            <strong>{attempt.result.finalScore ?? '—'}</strong><span>из 100</span>
          </div>
          <h3>{resultLabel}</h3>
          {attempt.status === 'REQUIRES_REVIEW' ? (
            <p className="muted-text">Результат сохранён отдельно и пока не считается подтверждённым.</p>
          ) : attempt.status === 'TIMED_OUT' ? (
            <p className="muted-text">Пропущенные вопросы получили 0 баллов; неполная попытка не может быть пройдена.</p>
          ) : null}
          <div className="training-breakdown-list">
            {attempt.result.safeBreakdown.map((item) => (
              <div key={item.sequence}><span>Вопрос {item.sequence}</span><strong>{item.score} / {item.maxScore}</strong></div>
            ))}
          </div>
          <AdminButton type="button" tone="primary" onClick={() => navigate('/training')}>К проектам и истории</AdminButton>
        </AdminPanel>
      ) : null}
    </div>
  );
}
