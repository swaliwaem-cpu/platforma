const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';
const ALLOWED_UPDATES = ['message', 'callback_query'];
const REQUEST_TIMEOUT_MS = 10_000;

async function main() {
  const command = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  const result = await executeWebhookCommand({
    command,
    dryRun,
    env: process.env,
    fetchImpl: fetch,
    apiOrigin: TELEGRAM_API_ORIGIN,
  });
  console.log(JSON.stringify(result, null, 2));
}

async function executeWebhookCommand({
  command,
  dryRun = false,
  env,
  fetchImpl,
  apiOrigin = TELEGRAM_API_ORIGIN,
}) {
  if (!['status', 'register', 'delete'].includes(command)) {
    throw new Error(
      'Command must be status, register or delete',
    );
  }
  if ((env.TELEGRAM_TRANSPORT_MODE ?? '').trim() !== 'real') {
    throw new Error(
      'TELEGRAM_TRANSPORT_MODE=real is required for webhook tooling',
    );
  }
  const botToken = requireValue(env, 'TELEGRAM_BOT_TOKEN');
  const webhookSecret =
    command === 'register'
      ? requireValue(env, 'TELEGRAM_WEBHOOK_SECRET')
      : '';
  const webhookUrl =
    command === 'register'
      ? requireHttpsUrl(env, 'TELEGRAM_WEBHOOK_URL')
      : '';
  const dropPendingUpdates =
    command === 'delete' &&
    readBooleanFlag(env, 'TELEGRAM_WEBHOOK_DROP_PENDING_UPDATES');
  if (
    command === 'delete' &&
    env.TELEGRAM_WEBHOOK_DELETE_CONFIRMED !== 'true'
  ) {
    throw new Error(
      'TELEGRAM_WEBHOOK_DELETE_CONFIRMED=true is required to delete a webhook',
    );
  }

  const method =
    command === 'status'
      ? 'getWebhookInfo'
      : command === 'register'
        ? 'setWebhook'
        : 'deleteWebhook';
  const body =
    command === 'register'
      ? {
          url: webhookUrl,
          secret_token: webhookSecret,
          allowed_updates: ALLOWED_UPDATES,
          drop_pending_updates: false,
        }
      : command === 'delete'
        ? { drop_pending_updates: dropPendingUpdates }
        : undefined;

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      command,
      method,
      allowedUpdates:
        command === 'register' ? ALLOWED_UPDATES : undefined,
      dropPendingUpdates:
        command === 'delete' ? dropPendingUpdates : undefined,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref();
  let response;
  try {
    response = await fetchImpl(
      `${apiOrigin}/bot${botToken}/${method}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      },
    );
  } catch {
    throw new Error('Telegram webhook request failed');
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(
      `Telegram webhook request failed with HTTP ${response.status}`,
    );
  }
  const payload = await response.json().catch(() => null);
  if (!payload || payload.ok !== true) {
    throw new Error('Telegram webhook API rejected the request');
  }
  if (command !== 'status') {
    return { ok: true, command };
  }
  return {
    ok: true,
    command,
    webhook: sanitizeWebhookInfo(payload.result),
  };
}

function readBooleanFlag(env, name) {
  const value = env[name]?.trim().toLowerCase();
  if (value === undefined || value === '') return false;
  if (value !== 'true' && value !== 'false') {
    throw new Error(`${name} must be "true" or "false"`);
  }
  return value === 'true';
}

function sanitizeWebhookInfo(value) {
  const info =
    value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    configured: typeof info.url === 'string' && info.url.length > 0,
    url: typeof info.url === 'string' ? info.url : '',
    pendingUpdateCount:
      Number.isSafeInteger(info.pending_update_count)
        ? info.pending_update_count
        : 0,
    lastErrorDate:
      Number.isSafeInteger(info.last_error_date)
        ? info.last_error_date
        : null,
    allowedUpdates: Array.isArray(info.allowed_updates)
      ? info.allowed_updates.filter(
          (item) => typeof item === 'string',
        )
      : [],
  };
}

function requireValue(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requireHttpsUrl(env, name) {
  const value = requireValue(env, name);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`${name} must use HTTPS`);
  }
  return url.toString();
}

module.exports = {
  ALLOWED_UPDATES,
  executeWebhookCommand,
  sanitizeWebhookInfo,
};

if (require.main === module) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Webhook command failed');
    process.exitCode = 1;
  });
}
