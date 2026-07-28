const SAFE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_.:-]{0,119}$/u;
const SAFE_LOG_FIELD_NAMES = new Set([
  'event',
  'correlationId',
  'jobId',
  'attemptId',
  'attemptQuestionId',
  'answerId',
  'updateId',
  'providerType',
  'requestedModel',
  'actualModel',
  'providerRequestId',
  'latencyMs',
  'retryCount',
  'errorCode',
  'workerKind',
  'status',
]);

export function formatTrainingErrorForLog(error: unknown) {
  const name =
    error instanceof Error &&
    /^[A-Za-z][A-Za-z0-9]{0,79}$/u.test(error.name)
      ? error.name
      : 'TrainingError';
  const code = readSafeErrorCode(error);
  return code ? `${name}:${code}` : name;
}

export function safeTrainingFailureMessage(
  error: unknown,
  fallback: string,
) {
  const code = readSafeErrorCode(error);
  return code ? `${fallback} (${code})` : fallback;
}

export function buildSafeTrainingLogRecord(
  event: string,
  fields: Record<string, unknown>,
) {
  const record: Record<string, string | number | boolean> = {
    event: normalizeSafeValue(event),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (
      key === 'event' ||
      !SAFE_LOG_FIELD_NAMES.has(key) ||
      !['string', 'number', 'boolean'].includes(typeof value)
    ) {
      continue;
    }
    record[key] =
      typeof value === 'string' ? normalizeSafeValue(value) : (value as number | boolean);
  }
  return record;
}

function readSafeErrorCode(error: unknown) {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && SAFE_CODE_PATTERN.test(code) ? code : null;
}

function normalizeSafeValue(value: string) {
  return value.replace(/[\r\n]+/gu, ' ').slice(0, 160);
}
