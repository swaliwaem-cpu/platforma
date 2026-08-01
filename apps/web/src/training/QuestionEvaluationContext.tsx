import { AlertCircleIcon, CheckCircle2Icon } from 'lucide-react';

import { AdminButton, AdminStatusBadge } from '../admin/AdminUi';
import type {
  TrainingCriterion,
  TrainingFact,
  TrainingQuestion,
} from './trainingAdminApi';
import { formatTrainingPoints as formatPoints } from './trainingViewModel.mjs';

export function QuestionEvaluationContext({
  instanceId,
  question,
  facts,
  criteria,
  onOpenCriteria,
  onOpenFacts,
}: {
  instanceId: string;
  question: TrainingQuestion;
  facts: TrainingFact[];
  criteria: TrainingCriterion[];
  onOpenCriteria: () => void;
  onOpenFacts: () => void;
}) {
  const headingId = `evaluation-context-${instanceId.replace(
    /[^A-Za-z0-9_-]+/gu,
    '-',
  )}`;
  const linkedFacts = question.id
    ? facts.filter((fact) =>
        fact.questionLinks.some((link) => link.questionId === question.id),
      )
    : [];
  const approvedFacts = linkedFacts.filter((fact) => fact.isApproved);
  const excludedFacts = linkedFacts.filter((fact) => !fact.isApproved);
  const questionCriteria = criteria
    .filter((criterion) => criterion.questionType === question.type)
    .sort((left, right) => left.sortOrder - right.sortOrder);
  const criterionPoints = questionCriteria.reduce(
    (sum, criterion) => sum + Number(criterion.maxPoints),
    0,
  );
  const expectedPoints = question.type === 'MAIN' ? 55 : 15;

  return (
    <section
      className="training-evaluation-context"
      aria-labelledby={headingId}
    >
      <div className="training-evaluation-context-heading">
        <div>
          <h3 id={headingId}>
            Что реально участвует в оценке
          </h3>
          <p>
            Только подтверждённые связанные факты и критерии этого типа вопроса.
          </p>
        </div>
        {!question.isActive ? (
          <AdminStatusBadge className="training-status--warning">
            Вопрос выключен
          </AdminStatusBadge>
        ) : null}
      </div>

      {!question.isActive ? (
        <p className="training-evaluation-context-disabled">
          Этот вопрос сейчас не участвует в экзамене. Настройки ниже начнут
          действовать после включения вопроса.
        </p>
      ) : null}

      <div className="training-evaluation-context-grid">
        <section className="training-evaluation-group">
          <div className="training-evaluation-group-heading">
            <div>
              <h4>Связанные факты</h4>
              <p>
                {approvedFacts.length} участвует
                {excludedFacts.length > 0
                  ? ` · ${excludedFacts.length} не участвует`
                  : ''}
              </p>
            </div>
            <AdminButton tone="text" onClick={onOpenFacts}>
              Настроить
            </AdminButton>
          </div>
          {linkedFacts.length === 0 ? (
            <p className="training-evaluation-empty">
              {question.id
                ? 'К вопросу пока не привязаны факты.'
                : 'Сначала сохраните вопрос, затем свяжите с ним факты.'}
            </p>
          ) : (
            <ul className="training-evaluation-list">
              {linkedFacts.map((fact) => (
                <li key={fact.id}>
                  {fact.isApproved ? (
                    <CheckCircle2Icon aria-hidden="true" />
                  ) : (
                    <AlertCircleIcon aria-hidden="true" />
                  )}
                  <span>
                    <strong>{fact.code}</strong>
                    <span>{fact.statement}</span>
                    {!fact.isApproved ? (
                      <small>Не подтверждён — в оценке не участвует</small>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="training-evaluation-group">
          <div className="training-evaluation-group-heading">
            <div>
              <h4>Критерии</h4>
              <p>
                {formatPoints(criterionPoints)}/{expectedPoints} баллов
              </p>
            </div>
            <AdminButton tone="text" onClick={onOpenCriteria}>
              Настроить
            </AdminButton>
          </div>
          {question.type === 'FOLLOW_UP' ? (
            <p className="training-evaluation-hint">
              Эти критерии одинаковы для всех дополнительных вопросов.
            </p>
          ) : null}
          {questionCriteria.length === 0 ? (
            <p className="training-evaluation-empty">
              Критерии для этого типа вопроса не добавлены.
            </p>
          ) : (
            <ul className="training-evaluation-list training-evaluation-list--criteria">
              {questionCriteria.map((criterion) => (
                <li key={criterion.id}>
                  <span>
                    <strong>{criterion.title || criterion.code}</strong>
                    <span>{criterion.description || criterion.code}</span>
                  </span>
                  <b>{formatPoints(Number(criterion.maxPoints))}</b>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}
