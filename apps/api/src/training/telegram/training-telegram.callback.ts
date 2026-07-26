const UUID_HEX_PATTERN = /^[0-9a-f]{32}$/u;

export type TrainingTelegramCallback =
  | { action: 'PROJECTS' }
  | { action: 'PROJECT'; projectId: string }
  | { action: 'START'; projectId: string }
  | { action: 'FINISH'; attemptQuestionId: string }
  | { action: 'RESULTS' }
  | { action: 'RULES' }
  | { action: 'CONNECT' };

export function encodeProjectCallback(projectId: string) {
  return encodeUuidCallback('p', projectId);
}

export function encodeStartCallback(projectId: string) {
  return encodeUuidCallback('s', projectId);
}

export function encodeFinishCallback(attemptQuestionId: string) {
  return encodeUuidCallback('f', attemptQuestionId);
}

export function parseTrainingTelegramCallback(
  value: string,
): TrainingTelegramCallback | null {
  if (value === 'tr:projects') return { action: 'PROJECTS' };
  if (value === 'tr:results') return { action: 'RESULTS' };
  if (value === 'tr:rules') return { action: 'RULES' };
  if (value === 'tr:connect') return { action: 'CONNECT' };

  const match = /^tr:([psf]):([0-9a-f]{32})$/u.exec(value);
  if (!match) return null;
  const id = expandUuid(match[2]!);
  if (match[1] === 'p') return { action: 'PROJECT', projectId: id };
  if (match[1] === 's') return { action: 'START', projectId: id };
  return { action: 'FINISH', attemptQuestionId: id };
}

function encodeUuidCallback(action: 'p' | 's' | 'f', value: string) {
  const compact = value.toLowerCase().replaceAll('-', '');
  if (!UUID_HEX_PATTERN.test(compact)) {
    throw new Error('Telegram callback entity ID must be a UUID');
  }
  const callback = `tr:${action}:${compact}`;
  if (Buffer.byteLength(callback, 'utf8') > 64) {
    throw new Error('Telegram callback_data exceeds 64 bytes');
  }
  return callback;
}

function expandUuid(compact: string) {
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join('-');
}
