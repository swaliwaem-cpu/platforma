import type {
  TrainingAnswerSource,
  TrainingAssignmentStatus,
  TrainingAttemptStatus,
  TrainingEmployeeProjectStatus,
  TrainingProjectStatus,
  TrainingReviewDecision,
  TrainingReviewStatus,
  TrainingUnsupportedClaimCategory,
} from '@platforma/shared';

export const trainingAttemptStatusLabels: Record<TrainingAttemptStatus, string> = {
  IN_PROGRESS: 'В процессе',
  COMPLETED: 'Завершена',
  REQUIRES_REVIEW: 'Требует проверки',
  TIMED_OUT: 'Время истекло',
  TECHNICAL_FAILED: 'Техническая ошибка',
};

export const trainingProjectStatusLabels: Record<TrainingProjectStatus, string> = {
  DRAFT: 'Черновик',
  PUBLISHED: 'Опубликован',
  ARCHIVED: 'В архиве',
};

export const trainingReviewStatusLabels: Record<TrainingReviewStatus, string> = {
  NOT_REQUIRED: 'Не требуется',
  PENDING: 'Ожидает проверки',
  RESOLVED: 'Проверено',
};

export const trainingAssignmentStatusLabels: Record<TrainingAssignmentStatus, string> = {
  ASSIGNED: 'Назначен',
  REVOKED: 'Назначение отозвано',
  NEVER_ASSIGNED: 'Не назначался',
};

export const trainingAnswerSourceLabels: Record<TrainingAnswerSource, string> = {
  TEXT: 'Текст',
  TELEGRAM: 'Телеграм',
};

export const trainingAnswerProcessingStatusLabels = {
  COLLECTING: 'Сбор ответа',
  PROCESSING: 'Обработка',
  COMPLETED: 'Обработан',
  FAILED: 'Ошибка обработки',
} as const;

export const trainingFactVerdictLabels = {
  CORRECT: 'Верно',
  PARTIAL: 'Частично',
  MISSING: 'Не упомянуто',
  INCORRECT: 'Неверно',
} as const;

export const trainingUnsupportedClaimCategoryLabels: Record<
  TrainingUnsupportedClaimCategory,
  string
> = {
  HARMLESS_EXTRA: 'Безобидная дополнительная информация',
  MATERIAL_UNVERIFIED: 'Существенный неподтверждённый факт',
  CONTRADICTORY: 'Противоречие утверждённому факту',
  UNSAFE_TO_SCORE: 'Нельзя надёжно оценить автоматически',
};

export function formatTrainingUnsupportedClaimCategory(
  category: TrainingUnsupportedClaimCategory | undefined,
) {
  return category
    ? trainingUnsupportedClaimCategoryLabels[category]
    : 'Историческое неподтверждённое утверждение';
}

export function formatTrainingReviewDecision(decision: TrainingReviewDecision) {
  if (decision === 'APPROVED') return 'Подтверждено';
  if (decision === 'OVERRIDDEN') return 'Скорректировано';
  return null;
}

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
  if (status === 'FAILED' || status === 'TIMED_OUT' || status === 'TECHNICAL_FAILED') return 'training-status--danger';
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

export function formatTrainingFactSourceBadge(source: {
  sourceType?: 'MANUAL' | 'MATERIAL';
  sourceMaterialType?: 'PDF' | 'OFFICIAL_URL' | 'MANUAL_TEXT' | 'OBJECT_SNAPSHOT' | null;
  sourceLocator?: string | null;
  sourceUrl?: string | null;
}) {
  if (source.sourceType !== 'MATERIAL') return 'Добавлено вручную';
  if (source.sourceMaterialType === 'PDF') {
    return `PDF · ${formatLocator(source.sourceLocator, 'page:', 'Страница')}`;
  }
  if (source.sourceMaterialType === 'OFFICIAL_URL') {
    return `Ссылка · ${formatSourceUrl(source.sourceUrl)}`;
  }
  if (source.sourceMaterialType === 'OBJECT_SNAPSHOT') {
    return `Platforma · ${formatObjectField(source.sourceLocator)}`;
  }
  if (source.sourceMaterialType === 'MANUAL_TEXT') {
    return `Ручной текст · ${formatLocator(source.sourceLocator, 'paragraph:', 'Абзац')}`;
  }
  return 'Материал · источник';
}

function formatLocator(value: string | null | undefined, prefix: string, label: string) {
  return value?.startsWith(prefix) && value.slice(prefix.length)
    ? `${label} ${value.slice(prefix.length)}`
    : 'источник';
}

function formatSourceUrl(value: string | null | undefined) {
  try {
    const url = new URL(value ?? '');
    const path = url.pathname === '/' ? '' : url.pathname;
    return `${url.hostname}${path}`.slice(0, 120);
  } catch {
    return 'официальная страница';
  }
}

function formatObjectField(locator: string | null | undefined) {
  const code = locator?.startsWith('object-field:') ? locator.slice('object-field:'.length) : '';
  return ({
    title: 'Название',
    type: 'Тип объекта',
    architectureDescription: 'Архитектура',
    infrastructureDescription: 'Инфраструктура',
    fillingDescription: 'Отделка и наполнение',
    krtName: 'КРТ',
    apartmentAreaRange: 'Площади',
    ceilingHeight: 'Высота потолков',
    propertyClass: 'Класс',
    floorRange: 'Этажность',
    completion: 'Срок сдачи',
    address: 'Адрес',
    developer: 'Девелопер',
    locations: 'Районы',
    metroStations: 'Метро',
  } as Record<string, string>)[code] ?? 'поле карточки';
}
