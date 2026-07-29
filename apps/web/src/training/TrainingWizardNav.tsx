import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CircleIcon,
  PencilLineIcon,
} from 'lucide-react';

import type { TrainingWizardStep } from './trainingAdminApi';

export type TrainingWizardStepView = {
  id: TrainingWizardStep;
  label: string;
  summary?: string;
  state: 'complete' | 'attention' | 'pending';
};

export const trainingWizardSteps: Array<
  Pick<TrainingWizardStepView, 'id' | 'label'>
> = [
  { id: 'main', label: 'Основные данные' },
  { id: 'sources', label: 'Источники' },
  { id: 'suggestions', label: 'Предложенные факты' },
  { id: 'assignments', label: 'Участники' },
  { id: 'questions', label: 'Вопросы' },
  { id: 'criteria', label: 'Критерии' },
  { id: 'review', label: 'Проверка' },
];

export function TrainingWizardNav({
  activeStep,
  dirtySteps,
  steps,
  onStepChange,
}: {
  activeStep: TrainingWizardStep;
  dirtySteps: Set<TrainingWizardStep>;
  steps: TrainingWizardStepView[];
  onStepChange: (step: TrainingWizardStep) => void;
}) {
  const activeIndex = Math.max(
    0,
    steps.findIndex((step) => step.id === activeStep),
  );
  const active = steps[activeIndex] ?? steps[0];

  return (
    <nav className="training-wizard-nav" aria-label="Этапы настройки проекта">
      <div className="training-wizard-mobile">
        <div>
          <span>
            Шаг {activeIndex + 1} из {steps.length}
          </span>
          <strong>{active?.label}</strong>
        </div>
        <progress
          max={steps.length}
          value={activeIndex + 1}
          aria-label={`Шаг ${activeIndex + 1} из ${steps.length}`}
        />
        <label>
          <span>Выбрать этап</span>
          <select
            className="training-control"
            value={activeStep}
            onChange={(event) =>
              onStepChange(event.target.value as TrainingWizardStep)
            }
          >
            {steps.map((step, index) => (
              <option key={step.id} value={step.id}>
                {index + 1}. {step.label}
                {dirtySteps.has(step.id) ? ' — не сохранено' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      <ol className="training-wizard-steps">
        {steps.map((step, index) => {
          const current = step.id === activeStep;
          const dirty = dirtySteps.has(step.id);
          const Icon = dirty
            ? PencilLineIcon
            : step.state === 'complete'
              ? CheckCircle2Icon
              : step.state === 'attention'
                ? AlertCircleIcon
                : CircleIcon;
          return (
            <li key={step.id}>
              <button
                type="button"
                className={[
                  'training-wizard-step',
                  current ? 'is-active' : '',
                  `training-wizard-step--${step.state}`,
                  dirty ? 'is-dirty' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-current={current ? 'step' : undefined}
                onClick={() => onStepChange(step.id)}
              >
                <span className="training-wizard-step-index" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="training-wizard-step-copy">
                  <strong>{step.label}</strong>
                  <small>
                    {dirty ? 'Не сохранено' : step.summary ?? 'Не заполнено'}
                  </small>
                </span>
                <Icon aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
