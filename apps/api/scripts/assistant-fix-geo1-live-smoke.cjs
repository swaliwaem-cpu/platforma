const assert = require('node:assert/strict');

const cases = [
  {
    label: 'Садовое кольцо',
    content: 'Найди квартиру возле Садового кольца',
    kind: 'LINE',
    mode: 'NEAR',
  },
  {
    label: 'ТТК',
    content: 'Найди квартиру возле ТТК',
    kind: 'LINE',
    mode: 'NEAR',
  },
  {
    label: 'МКАД',
    content: 'Найди квартиру возле МКАД',
    kind: 'LINE',
    mode: 'NEAR',
  },
  {
    label: 'Арбат',
    content: 'Найди квартиру внутри района Арбат',
    kind: 'AREA',
    mode: 'INSIDE',
  },
];

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'ASSISTANT_FIX_GEO1_LIVE_SMOKE_FAILED'}\n`);
  process.exitCode = 1;
});

async function main() {
  if (process.env.ASSISTANT_FIX_GEO1_LIVE_SMOKE !== 'true') {
    throw new Error('ASSISTANT_FIX_GEO1_LIVE_SMOKE_OPT_IN_REQUIRED');
  }
  const apiUrl = readUrl(process.env.ASSISTANT_FIX_GEO1_LIVE_API_URL);
  const accessToken = readSecret(process.env.ASSISTANT_FIX_GEO1_LIVE_ACCESS_TOKEN);
  const allowRemote = process.env.ASSISTANT_FIX_GEO1_LIVE_ALLOW_REMOTE === 'true';
  if (!allowRemote && !isLoopback(apiUrl.hostname)) {
    throw new Error('ASSISTANT_FIX_GEO1_LIVE_REMOTE_OPT_IN_REQUIRED');
  }
  const timeoutMs = readBoundedInteger(
    process.env.ASSISTANT_FIX_GEO1_LIVE_TIMEOUT_MS,
    20_000,
    1_000,
    30_000,
    'ASSISTANT_FIX_GEO1_LIVE_TIMEOUT_INVALID',
  );
  for (const smokeCase of cases) {
    const response = await fetch(new URL('/assistant/geo/resolve', apiUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content: smokeCase.content, locale: 'ru', country: 'ru' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    assert.equal(response.status, 201, `${smokeCase.label}: HTTP ${response.status}`);
    const payload = await readBoundedJson(response, 128 * 1_024);
    assert.equal(payload.status, 'RESOLVED', `${smokeCase.label}: ${String(payload.status)}`);
    assert.equal(payload.candidates?.length, 1, `${smokeCase.label}: expected one candidate`);
    assert.equal(payload.candidates[0]?.kind, smokeCase.kind, `${smokeCase.label}: kind`);
    assert.equal(payload.candidates[0]?.mode, smokeCase.mode, `${smokeCase.label}: mode`);
    process.stdout.write(`${smokeCase.label}: ${smokeCase.kind}/${smokeCase.mode} OK\n`);
  }

  process.stdout.write(`ASSISTANT_FIX_GEO1_LIVE_SMOKE_OK requests=${cases.length}\n`);
}

function readUrl(value) {
  if (!value) throw new Error('ASSISTANT_FIX_GEO1_LIVE_API_URL_REQUIRED');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('ASSISTANT_FIX_GEO1_LIVE_API_URL_INVALID');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('ASSISTANT_FIX_GEO1_LIVE_API_URL_INVALID');
  }
  return parsed;
}

function readSecret(value) {
  if (typeof value !== 'string' || value.length < 20 || value.length > 8_192) {
    throw new Error('ASSISTANT_FIX_GEO1_LIVE_ACCESS_TOKEN_REQUIRED');
  }
  return value;
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function readBoundedInteger(value, fallback, minimum, maximum, errorCode) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(errorCode);
  return parsed;
}

async function readBoundedJson(response, maximumBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error('ASSISTANT_FIX_GEO1_LIVE_RESPONSE_TOO_LARGE');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('ASSISTANT_FIX_GEO1_LIVE_RESPONSE_EMPTY');
  const chunks = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maximumBytes) {
      await reader.cancel();
      throw new Error('ASSISTANT_FIX_GEO1_LIVE_RESPONSE_TOO_LARGE');
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('ASSISTANT_FIX_GEO1_LIVE_RESPONSE_INVALID');
  }
}
