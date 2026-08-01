import type {
  TrainingAttemptStatus,
  TrainingEmployeeProjectStatus,
  TrainingProjectStatus,
} from '@platforma/shared';

export const trainingAttemptStatusLabels: Record<TrainingAttemptStatus, string> = {
  IN_PROGRESS: 'В процессе',
  COMPLETED: 'Завершена',
  REQUIRES_REVIEW: 'Требует проверки',
  TIMED_OUT: 'Время истекло',
};

export const trainingProjectStatusLabels: Record<TrainingProjectStatus, string> = {
  DRAFT: 'Черновик',
  PUBLISHED: 'Опубликован',
  ARCHIVED: 'В архиве',
};

export function getTrainingResultLabel(
  status: TrainingEmployeeProjectStatus,
  isPassed?: boolean | null,
) {
  if (status === 'PASSED' || isPassed === true) return 'Пройдено';
  if (status === 'FAILED' || isPassed === false) return 'Не пройдено';
  if (status === 'REQUIRES_REVIEW') return 'Требует проверки';
  return 'Нет результата';
}

export function getTrainingStatusClass(status: string | null) {
  if (status === 'PASSED' || status === 'COMPLETED') return 'training-status--success';
  if (status === 'FAILED' || status === 'TIMED_OUT') return 'training-status--danger';
  if (status === 'REQUIRES_REVIEW') return 'training-status--warning';
  if (status === 'IN_PROGRESS' || status === 'PUBLISHED') return 'training-status--active';
  return '';
}

export function formatTrainingDate(value: string | null) {
  if (!value) return '—';

  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function formatTrainingDuration(seconds: number) {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  const rest = Math.max(0, seconds) % 60;

  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}
