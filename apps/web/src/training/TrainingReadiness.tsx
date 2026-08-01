import { AlertCircleIcon, CheckCircle2Icon } from 'lucide-react';

import type { TrainingReadiness } from './trainingAdminApi';
import { formatTrainingPoints as formatPoints } from './trainingViewModel.mjs';

export function TrainingReadinessSummary({
  readiness,
  loading = false,
  error = null,
  stale = false,
}: {
  readiness: TrainingReadiness | null;
  loading?: boolean;
  error?: string | null;
  stale?: boolean;
}) {
  if (loading && !readiness) {
    return (
      <div className="training-readiness-summary" role="status">
        Проверяем готовность…
      </div>
    );
  }

  if (!readiness) {
    return (
      <div
        className="training-readiness-summary"
        role="status"
        aria-live="polite"
      >
        <div className="training-readiness-verdict">
          <AlertCircleIcon aria-hidden="true" />
          <span>
            <strong>
              {error
                ? 'Не удалось проверить готовность'
                : 'Готовность ещё не проверена'}
            </strong>
            <small>Публикация заблокирована.</small>
          </span>
        </div>
      </div>
    );
  }

  return (
    <section
      className={
        readiness.readyToPublish && !stale
          ? 'training-readiness-summary is-ready'
          : 'training-readiness-summary'
      }
      aria-label="Готовность к публикации"
      aria-live="polite"
    >
      <div className="training-readiness-metric">
        <span>Факты</span>
        <strong>
          {readiness.facts.approved}/{readiness.facts.total}
        </strong>
        {readiness.facts.pendingSuggestions > 0 ? (
          <small>{readiness.facts.pendingSuggestions} требуют решения</small>
        ) : (
          <small>подтверждено</small>
        )}
      </div>
      <div className="training-readiness-metric">
        <span>Вопросы</span>
        <strong>
          {readiness.questions.active}/{readiness.questions.required}
        </strong>
        <small>настроено</small>
      </div>
      <div className="training-readiness-metric">
        <span>Критерии</span>
        <strong>
          {formatPoints(readiness.criteria.mainPoints)}/
          {readiness.criteria.mainRequired} +{' '}
          {formatPoints(readiness.criteria.followUpPoints)}/
          {readiness.criteria.followUpRequired}
        </strong>
        <small>баллов</small>
      </div>
      <div className="training-readiness-verdict">
        {readiness.readyToPublish && !stale ? (
          <CheckCircle2Icon aria-hidden="true" />
        ) : (
          <AlertCircleIcon aria-hidden="true" />
        )}
        <span>
          <strong>
            {stale
              ? 'Сначала сохраните изменения'
              : readiness.readyToPublish
                ? 'Можно публиковать'
                : `${readiness.issues.length} ${pluralizeIssues(readiness.issues.length)}`}
          </strong>
          {stale ? <small>Проверка будет обновлена после сохранения.</small> : null}
        </span>
      </div>
    </section>
  );
}

function pluralizeIssues(value: number) {
  const mod100 = value % 100;
  const mod10 = value % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'проблем';
  if (mod10 === 1) return 'проблема';
  if (mod10 >= 2 && mod10 <= 4) return 'проблемы';
  return 'проблем';
}
