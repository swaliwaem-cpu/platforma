const SAFE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_.:-]{0,119}$/u;
const SAFE_LOG_FIELD_NAMES = new Set([
  'event',
  'correlationId',
  'jobId',
  'attemptId',
  'attemptQuestionId',
  'answerId',
  'intentId',
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
const SAFE_CORRELATION_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;

type TrainingLogLevel = 'log' | 'warn' | 'error';
type TrainingLogSink = Record<
  TrainingLogLevel,
  (message: string) => unknown
>;

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

export function readTrainingCorrelationId(value: unknown) {
  return typeof value === 'string' &&
    SAFE_CORRELATION_PATTERN.test(value)
    ? value
    : null;
}

export function resolveTrainingCorrelationId(
  value: unknown,
  fallback: string,
) {
  return (
    readTrainingCorrelationId(value) ??
    readTrainingCorrelationId(fallback)
  );
}

export function writeSafeTrainingLog(
  logger: TrainingLogSink,
  level: TrainingLogLevel,
  event: string,
  fields: Record<string, unknown>,
) {
  logger[level](
    JSON.stringify(buildSafeTrainingLogRecord(event, fields)),
  );
}

function readSafeErrorCode(error: unknown) {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && SAFE_CODE_PATTERN.test(code) ? code : null;
}

function normalizeSafeValue(value: string) {
  return value.replace(/[\r\n]+/gu, ' ').slice(0, 160);
}
