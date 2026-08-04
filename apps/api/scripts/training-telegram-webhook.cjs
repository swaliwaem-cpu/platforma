const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';
const ALLOWED_UPDATES = ['message', 'callback_query'];

async function executeWebhookCommand({
  action,
  args = [],
  environment = process.env,
  fetchImpl = fetch,
}) {
  requireRealTelegramConfig(environment);
  const dryRun = args.includes('--dry-run');

  if (!['status', 'register', 'delete'].includes(action)) {
    throw safeError('WEBHOOK_ACTION_INVALID');
  }
  if (action === 'delete' && !args.includes('--confirm-delete')) {
    throw safeError('WEBHOOK_DELETE_CONFIRMATION_REQUIRED');
  }

  const operation = createOperation(action, environment);

  if (dryRun) return { ok: true, action, dryRun: true };

  const result = await callTelegram(operation, environment, fetchImpl);

  if (action === 'status') {
    return {
      ok: true,
      action,
      registered: typeof result.url === 'string' && result.url.length > 0,
      pendingUpdateCount: boundedNonNegativeInteger(result.pending_update_count),
      hasLastError: Number.isInteger(result.last_error_date),
    };
  }

  return { ok: true, action, dryRun: false };
}

function createOperation(action, environment) {
  if (action === 'status') return { method: 'getWebhookInfo', body: {} };
  if (action === 'delete') {
    return { method: 'deleteWebhook', body: { drop_pending_updates: false } };
  }

  const webhookUrl = validateWebhookUrl(environment.TELEGRAM_WEBHOOK_URL);
  const secret = required(environment, 'TELEGRAM_WEBHOOK_SECRET');

  return {
    method: 'setWebhook',
    body: {
      url: webhookUrl,
      secret_token: secret,
      allowed_updates: ALLOWED_UPDATES,
      drop_pending_updates: false,
    },
  };
}

async function callTelegram(operation, environment, fetchImpl) {
  const token = required(environment, 'TELEGRAM_BOT_TOKEN');
  const origin = getApiOrigin(environment);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), readTimeout(environment));
  let response;

  try {
    response = await fetchImpl(`${origin}/bot${token}/${operation.method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(operation.body),
      signal: controller.signal,
    });
  } catch (error) {
    throw safeError(
      error instanceof DOMException && error.name === 'AbortError'
        ? 'TELEGRAM_WEBHOOK_TIMEOUT'
        : 'TELEGRAM_WEBHOOK_NETWORK_ERROR',
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) throw safeError(`TELEGRAM_WEBHOOK_HTTP_${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > 32 * 1024) {
    throw safeError('TELEGRAM_WEBHOOK_RESPONSE_TOO_LARGE');
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw safeError('TELEGRAM_WEBHOOK_RESPONSE_INVALID');
  }
  if (!payload || payload.ok !== true) throw safeError('TELEGRAM_WEBHOOK_PROVIDER_ERROR');
  return payload.result && typeof payload.result === 'object' ? payload.result : {};
}

function requireRealTelegramConfig(environment) {
  if (environment.TELEGRAM_TRANSPORT_MODE?.trim().toLowerCase() !== 'real') {
    throw safeError('TELEGRAM_TRANSPORT_MODE_REAL_REQUIRED');
  }
  required(environment, 'TELEGRAM_BOT_TOKEN');
}

function required(environment, key) {
  const value = environment[key]?.trim();
  if (!value) throw safeError(`${key}_REQUIRED`);
  return value;
}

function validateWebhookUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw safeError('TELEGRAM_WEBHOOK_URL_INVALID');
  }

  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/training/telegram/webhook' ||
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.test') ||
    hostname.endsWith('.example') ||
    isPrivateHostname(hostname)
  ) {
    throw safeError('TELEGRAM_WEBHOOK_URL_INVALID');
  }

  return url.toString();
}

function isPrivateHostname(hostname) {
  const normalized = hostname.replace(/^\[|\]$/gu, '');

  if (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:')
  ) {
    return true;
  }

  const match = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  const first = octets[0] ?? 0;
  const second = octets[1] ?? 0;

  return octets.some((part) => part > 255) || first === 0 || first === 10 || first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

function getApiOrigin(environment) {
  const testOrigin = environment.TELEGRAM_TEST_API_ORIGIN?.trim();
  if (!testOrigin) return TELEGRAM_API_ORIGIN;
  if (environment.NODE_ENV !== 'test') throw safeError('TELEGRAM_TEST_API_ORIGIN_FORBIDDEN');

  const url = new URL(testOrigin);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/'
  ) {
    throw safeError('TELEGRAM_TEST_API_ORIGIN_INVALID');
  }
  return url.origin;
}

function readTimeout(environment) {
  const value = Number(environment.TELEGRAM_REQUEST_TIMEOUT_MS ?? 5_000);
  return Number.isInteger(value) && value >= 100 && value <= 30_000 ? value : 5_000;
}

function boundedNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? Math.min(value, 1_000_000) : 0;
}

function safeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function main() {
  try {
    const result = await executeWebhookCommand({
      action: process.argv[2],
      args: process.argv.slice(3),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error && error.code ? error.code : 'TELEGRAM_WEBHOOK_COMMAND_FAILED'}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}

module.exports = {
  ALLOWED_UPDATES,
  createOperation,
  executeWebhookCommand,
  validateWebhookUrl,
};
