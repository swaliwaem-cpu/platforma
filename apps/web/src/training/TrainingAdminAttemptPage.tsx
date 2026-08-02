import { FormEvent, useEffect, useState } from 'react';
import type { TrainingAdminAttempt } from '@platforma/shared';

import { AdminAlert, AdminButton, AdminPanel, AdminStatusBadge } from '../admin/AdminUi';
import { useAuth } from '../auth/AuthProvider';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { getTrainingAdminAttempt, reviewTrainingAdminAttempt } from './trainingApi';
import {
  formatTrainingFactSourceBadge,
  formatTrainingDate,
  getTrainingStatusClass,
  trainingAttemptStatusLabels,
} from './trainingView';

type TrainingAdminAttemptPageProps = {
  attemptId: string;
  canReviewResults: boolean;
  navigate: (pathname: string) => void;
};

export function TrainingAdminAttemptPage({
  attemptId,
  canReviewResults,
  navigate,
}: TrainingAdminAttemptPageProps) {
  const { accessToken } = useAuth();
  const [attempt, setAttempt] = useState<TrainingAdminAttempt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isReviewing, setIsReviewing] = useState(false);
  const [decision, setDecision] = useState<'APPROVE' | 'OVERRIDE'>('APPROVE');
  const [finalScore, setFinalScore] = useState('');
  const [comment, setComment] = useState('');
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

  const handleReview = async (event: FormEvent) => {
    event.preventDefault();
    if (!accessToken || !attempt || isReviewing) return;
    const score = Number(finalScore);

    if (decision === 'OVERRIDE' && (!Number.isInteger(score) || score < 0 || score > 100)) {
      setError('Для Override укажите целый итоговый балл от 0 до 100.');
      return;
    }
    if (decision === 'OVERRIDE' && !comment.trim()) {
      setError('Для Override укажите причину.');
      return;
    }

    setIsReviewing(true);
    setError(null);
    setNotice(null);

    try {
      await reviewTrainingAdminAttempt(accessToken, attempt.id, {
        decision,
        finalScore: decision === 'OVERRIDE' ? score : null,
        comment: comment.trim() || null,
      });
      const updated = await getTrainingAdminAttempt(accessToken, attempt.id);
      setAttempt(updated);
      setNotice(decision === 'APPROVE' ? 'Расчётный результат подтверждён.' : 'Итоговый балл скорректирован.');
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Не удалось завершить проверку');
    } finally {
      setIsReviewing(false);
    }
  };

  if (isLoading) return <div className="training-page"><Skeleton className="training-attempt-skeleton" /></div>;

  if (!attempt) {
    return (
      <div className="training-page">
        <AdminAlert tone="error"><span>{error ?? 'Попытка не найдена'}</span><AdminButton type="button" tone="text" onClick={() => setReloadKey((value) => value + 1)}>Повторить</AdminButton></AdminAlert>
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

      {error ? <AdminAlert tone="error"><span>{error}</span><AdminButton type="button" tone="text" onClick={() => setReloadKey((value) => value + 1)}>Обновить</AdminButton></AdminAlert> : null}
      {notice ? <AdminAlert tone="notice">{notice}</AdminAlert> : null}

      <div className="training-toolbar"><AdminButton type="button" tone="text" onClick={() => navigate('/admin/training')}>К проектам и попыткам</AdminButton></div>

      <AdminPanel className="training-attempt-summary">
        <dl className="training-metrics training-metrics--wide">
          <div><dt>Старт</dt><dd>{formatTrainingDate(attempt.startedAt)}</dd></div>
          <div><dt>Завершение</dt><dd>{formatTrainingDate(attempt.completedAt)}</dd></div>
          <div><dt>Расчётный балл</dt><dd>{attempt.calculatedScore ?? '—'} / 100</dd></div>
          <div><dt>Итоговый балл</dt><dd>{attempt.finalScore ?? '—'} / 100</dd></div>
          <div><dt>Review</dt><dd>{attempt.reviewStatus}{attempt.reviewDecision ? ` · ${attempt.reviewDecision}` : ''}</dd></div>
          <div><dt>Попытка учтена</dt><dd>{attempt.countsTowardAttemptLimit ? 'Да' : 'Нет, возвращена'}</dd></div>
        </dl>
      </AdminPanel>

      {attempt.reviewStatus === 'PENDING' ? (
        canReviewResults ? (
          <AdminPanel className="training-review-panel">
            <div><p className="eyebrow">Ручная проверка</p><h3>Подтвердить или скорректировать итог</h3><p className="muted-text">Расчётный балл: {attempt.calculatedScore ?? '—'}. Review одноразовый.</p></div>
            <form onSubmit={(event) => void handleReview(event)}>
              <FieldGroup>
                <fieldset className="training-review-decisions"><legend>Решение</legend><label><input type="radio" name="review-decision" checked={decision === 'APPROVE'} disabled={isReviewing} onChange={() => setDecision('APPROVE')} /> Approve</label><label><input type="radio" name="review-decision" checked={decision === 'OVERRIDE'} disabled={isReviewing} onChange={() => setDecision('OVERRIDE')} /> Override</label></fieldset>
                {decision === 'OVERRIDE' ? <Field><FieldLabel htmlFor="training-review-score">Итоговый балл</FieldLabel><Input id="training-review-score" inputMode="numeric" value={finalScore} disabled={isReviewing} onChange={(event) => setFinalScore(event.target.value)} /><FieldDescription>Целое число от 0 до 100.</FieldDescription></Field> : null}
                <Field><FieldLabel htmlFor="training-review-comment">Причина / комментарий</FieldLabel><textarea id="training-review-comment" className="training-textarea" rows={4} value={comment} disabled={isReviewing} onChange={(event) => setComment(event.target.value)} />{decision === 'OVERRIDE' && !comment.trim() ? <FieldError>Причина обязательна для Override.</FieldError> : null}</Field>
                <AdminButton type="submit" tone="primary" disabled={isReviewing}>{isReviewing ? 'Сохранение…' : decision === 'APPROVE' ? 'Подтвердить расчёт' : 'Сохранить новый итог'}</AdminButton>
              </FieldGroup>
            </form>
          </AdminPanel>
        ) : <AdminAlert tone="notice">У вас нет права training:results:review.</AdminAlert>
      ) : null}

      <section aria-labelledby="training-admin-answers-title">
        <div className="training-section-heading"><h3 id="training-admin-answers-title">Вопросы, факты и оценивание</h3><span className="training-section-count">{attempt.questions.length}</span></div>
        <div className="training-admin-answers">
          {attempt.questions.map((question) => {
            const evaluation = question.answer?.evaluation;
            const aiBreakdown = question.answer?.safeBreakdown?.basis === 'AI_CRITERIA' ? question.answer.safeBreakdown : null;

            return (
              <AdminPanel className="training-admin-answer" key={question.id}>
                <div className="training-question-progress"><span>Вопрос {question.sequence} · {question.type === 'MAIN' ? 'главный' : 'дополнительный'}</span><strong>{question.answer?.score ?? 0} / {question.maxScore}</strong></div>
                <h3>{question.text}</h3>
                {question.answer ? (
                  <>
                    <div className="training-answer-copy"><p>{question.answer.text ?? 'Transcript не сохранён.'}</p><small>{question.answer.processingStatus} · {formatTrainingDate(question.answer.submittedAt)}</small></div>
                    <dl className="training-metrics training-metrics--wide">
                      <div><dt>Transcription model</dt><dd>{question.answer.transcriptionModel ?? '—'}</dd></div>
                      <div><dt>Evaluation model</dt><dd>{question.answer.evaluationModel ?? '—'}</dd></div>
                      <div><dt>Criteria points</dt><dd>{aiBreakdown?.criteriaPoints ?? '—'}</dd></div>
                      <div><dt>Штрафы</dt><dd>{aiBreakdown ? `−${aiBreakdown.penaltyPoints} (${aiBreakdown.incorrectFactCount} ошибок)` : '—'}</dd></div>
                      <div><dt>Слов</dt><dd>{question.answer.objectiveMetrics?.wordCount ?? '—'}</dd></div>
                      <div><dt>Темп</dt><dd>{question.answer.objectiveMetrics ? `${question.answer.objectiveMetrics.wordsPerMinute} слов/мин` : '—'}</dd></div>
                    </dl>
                    {question.answer.technicalErrorCode ? <AdminAlert tone="error">Код обработки: {question.answer.technicalErrorCode}</AdminAlert> : null}
                    <div className="training-evaluation-grid">
                      <section><h4>Утверждённые факты</h4>{question.facts.length ? <ul>{question.facts.map((fact) => { const assessment = evaluation?.fact_assessments.find((item) => item.fact_id === fact.id); return <li key={fact.id}><strong>{assessment?.verdict ?? '—'}</strong><span>{fact.statement}</span><div className="training-fact-source"><Badge variant={fact.sourceType === 'MATERIAL' ? 'secondary' : 'outline'}>{formatTrainingFactSourceBadge(fact)}</Badge>{fact.sourceType === 'MATERIAL' ? <small>{fact.sourceLabel}{fact.sourceExcerpt ? ` · «${fact.sourceExcerpt}»` : ''}</small> : null}</div>{assessment?.evidence ? <q>{assessment.evidence}</q> : null}{assessment?.explanation ? <small>{assessment.explanation}</small> : null}</li>; })}</ul> : <p className="muted-text">Legacy snapshot без facts.</p>}</section>
                      <section><h4>Критерии</h4>{question.criteria.length ? <ul>{question.criteria.map((criterion) => { const assessment = evaluation?.criterion_assessments.find((item) => item.criterion_id === criterion.id); return <li key={criterion.id}><strong>{assessment?.awarded_points ?? '—'} / {criterion.maxPoints}</strong><span>{criterion.title}</span>{assessment?.evidence ? <q>{assessment.evidence}</q> : null}{assessment?.explanation ? <small>{assessment.explanation}</small> : null}</li>; })}</ul> : <p className="muted-text">Legacy snapshot без criteria.</p>}</section>
                    </div>
                    {evaluation ? <div className="training-evaluation-summary"><h4>Резюме</h4><p>{evaluation.summary}</p>{evaluation.unsupported_claims.length ? <><h4>Unsupported claims</h4><ul>{evaluation.unsupported_claims.map((claim, index) => <li key={`${claim.evidence}-${index}`}><span>{claim.claim}</span><q>{claim.evidence}</q></li>)}</ul></> : null}</div> : null}
                  </>
                ) : <p className="muted-text">Ответ отсутствует: {question.status === 'SKIPPED_TIMEOUT' ? 'время истекло' : 'вопрос ожидает ответа'}.</p>}
              </AdminPanel>
            );
          })}
        </div>
      </section>
    </div>
  );
}
