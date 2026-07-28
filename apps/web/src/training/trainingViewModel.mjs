export const attemptStatusLabels = {
  STARTED: 'Начата',
  AWAITING_MAIN: 'Ожидает ответа',
  PROCESSING_MAIN: 'Обработка основного ответа',
  AWAITING_FOLLOW_UP: 'Ожидает уточнения',
  PROCESSING_FOLLOW_UP: 'Обработка уточнения',
  FINALIZING: 'Подведение итогов',
  COMPLETED: 'Завершена',
  REQUIRES_REVIEW: 'Требует проверки',
  EXPIRED: 'Время истекло',
  TECHNICAL_FAILURE: 'Техническая ошибка',
};

export const passStatusLabels = {
  PENDING: 'Требует проверки',
  PASSED: 'Пройдено',
  FAILED: 'Не пройдено',
};

export const reviewStatusLabels = {
  NOT_REQUIRED: 'Проверка не нужна',
  PENDING: 'Ожидает проверки',
  APPROVED: 'Подтверждено',
  OVERRIDDEN: 'Скорректировано',
};

export const eligibilityLabels = {
  AVAILABLE: 'Можно начать',
  TELEGRAM_NOT_CONNECTED: 'Telegram не подключён',
  ATTEMPT_IN_PROGRESS: 'Попытка уже идёт',
  ATTEMPT_LIMIT_REACHED: 'Попытки закончились',
  COOLDOWN_ACTIVE: 'Действует перерыв',
  ALREADY_PASSED: 'Проект уже пройден',
  DEADLINE_PASSED: 'Срок завершён',
  NOT_YET_AVAILABLE: 'Ещё недоступно',
};

export function visibleEmployeeScore(attempt) {
  return attempt.reviewStatus === 'PENDING' ? null : attempt.finalScore;
}

export function formatTrainingScore(value) {
  if (value === null || value === undefined || value === '') return '—';
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? parsed.toLocaleString('ru-RU', { maximumFractionDigits: 2 })
    : '—';
}

export function formatTrainingDuration(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? `${minutes} мин ${remainder} сек` : `${remainder} сек`;
}
