const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const test = require('node:test');

const {
  TrainingOpenAIClient,
} = require('../dist/training/training-openai-client.js');
const {
  OpenAITrainingTranscriber,
} = require('../dist/training/training-openai-transcriber.js');
const {
  buildTrainingVocabularyPrompt,
} = require('../dist/training/training-transcriber.js');

test('OpenAI transcription serializes one WAV multipart part and bounded vocabulary', async () => {
  const wav = makeWav();
  const request = await captureNativeRequest({ text: 'Тестовая расшифровка' }, async (baseUrl) => {
    const transcriber = new OpenAITrainingTranscriber(
      new TrainingOpenAIClient('test-key', fetch, baseUrl),
    );
    const result = await transcriber.transcribe(makeInput(wav, 'Словарь: ЖК Север'));

    assert.equal(result.text, 'Тестовая расшифровка');
    assert.equal(result.model, 'gpt-4o-mini-transcribe-2025-12-15');
    assert.equal(result.requestId, 'request-test');
  });

  assert.equal(request.url, '/v1/audio/transcriptions');
  assert.match(request.headers['content-type'], /^multipart\/form-data; boundary=/u);
  assert.equal(countMatches(request.body, 'name="file"'), 1);
  assert.match(request.body, /filename="answer.wav"/u);
  assert.match(request.body, /name="model"[\s\S]*gpt-4o-mini-transcribe-2025-12-15/u);
  assert.match(request.body, /name="language"[\s\S]*ru/u);
  assert.match(request.body, /ЖК Север/u);
  assert.equal(request.raw.includes(wav), true);
});

test('transcription vocabulary normalizes, deduplicates and excludes fact statements', () => {
  const allowedAlias = Array.from({ length: 15 }, () => 'раз').join(' ');
  const oversizedAlias = Array.from({ length: 16 }, () => 'два').join(' ');
  const prompt = buildTrainingVocabularyPrompt({
    projectTitle: ' ЖК Север ',
    relatedObjectTitle: 'ЖК Север',
    facts: [{ aliases: ['Север', 'север', 'короткий термин', allowedAlias, oversizedAlias] }],
  });

  assert.equal(countMatches(prompt, 'ЖК Север'), 1);
  assert.equal(countMatches(prompt.toLocaleLowerCase('ru-RU'), 'север'), 2);
  assert.match(prompt, /короткий термин/u);
  assert.match(prompt, new RegExp(allowedAlias, 'u'));
  assert.doesNotMatch(prompt, new RegExp(oversizedAlias, 'u'));
  assert.doesNotMatch(prompt, /В проекте 120 квартир/u);
});

test('OpenAI transcription retries 429 and 500 but not permanent 400/401', async () => {
  await withProviderEnv(async () => {
    for (const status of [429, 500]) {
      let calls = 0;
      const transcriber = makeTranscriber(async () => {
        calls += 1;
        return calls === 1
          ? new Response('', { status, headers: { 'retry-after': '0' } })
          : jsonResponse({ text: 'ok' });
      });

      assert.equal((await transcriber.transcribe(makeInput(makeWav(), ''))).text, 'ok');
      assert.equal(calls, 2);
    }

    for (const [status, code] of [[400, 'OPENAI_INVALID_REQUEST'], [401, 'OPENAI_UNAUTHORIZED']]) {
      let calls = 0;
      const transcriber = makeTranscriber(async () => {
        calls += 1;
        return new Response('', { status });
      });
      await assert.rejects(() => transcriber.transcribe(makeInput(makeWav(), '')), (error) => error.code === code);
      assert.equal(calls, 1);
    }
  });
});

test('OpenAI transcription bounds timeout and rejects empty/malformed responses', async () => {
  await withProviderEnv(async () => {
    process.env.OPENAI_TRANSCRIPTION_TIMEOUT_MS = '1000';
    process.env.OPENAI_TRANSCRIPTION_MAX_RETRIES = '0';
    const timedOut = makeTranscriber((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    await assert.rejects(() => timedOut.transcribe(makeInput(makeWav(), '')), (error) => error.code === 'OPENAI_TIMEOUT');

    for (const payload of [{ text: '' }, { unexpected: true }]) {
      const malformed = makeTranscriber(async () => jsonResponse(payload));
      await assert.rejects(() => malformed.transcribe(makeInput(makeWav(), '')), (error) => error.code === 'OPENAI_EMPTY_TRANSCRIPT');
    }
  });
});

test('Retry-After outside the hard deadline preserves the completed request count', async () => {
  await withProviderEnv(async () => {
    process.env.OPENAI_TRANSCRIPTION_TIMEOUT_MS = '1000';
    process.env.OPENAI_TRANSCRIPTION_MAX_RETRIES = '2';
    let calls = 0;
    const transcriber = makeTranscriber(async () => {
      calls += 1;
      return new Response('', { status: 429, headers: { 'retry-after': '10' } });
    });

    await assert.rejects(
      () => transcriber.transcribe(makeInput(makeWav(), '')),
      (error) => error.code === 'OPENAI_TIMEOUT' && error.attempts === 1,
    );
    assert.equal(calls, 1);
  });
});

test('OpenAI transcription rejects invalid or oversized audio before fetch', async () => {
  let calls = 0;
  const transcriber = makeTranscriber(async () => {
    calls += 1;
    return jsonResponse({ text: 'unexpected' });
  });
  await assert.rejects(() => transcriber.transcribe(makeInput(Buffer.alloc(50), '')), (error) => error.code === 'OPENAI_INVALID_AUDIO');
  const oversized = makeWav(25 * 1024 * 1024 + 1);
  await assert.rejects(() => transcriber.transcribe(makeInput(oversized, '')), (error) => error.code === 'OPENAI_INVALID_AUDIO');
  assert.equal(calls, 0);
});

function makeTranscriber(fetchImplementation) {
  return new OpenAITrainingTranscriber(
    new TrainingOpenAIClient('test-key', fetchImplementation, 'https://openai.invalid/v1'),
  );
}

function makeInput(wav, vocabularyPrompt) {
  return {
    projectId: 'project-id',
    attemptId: 'attempt-id',
    answerId: 'answer-id',
    fileId: 'file-id',
    mimeType: 'audio/wav',
    sizeBytes: wav.length,
    checksum: 'checksum',
    wav,
    vocabularyPrompt,
  };
}

function makeWav(size = 64) {
  const wav = Buffer.alloc(size);
  wav.write('RIFF', 0, 'ascii');
  wav.write('WAVE', 8, 'ascii');
  return wav;
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-request-id': 'request-test' },
  });
}

async function captureNativeRequest(responseValue, run) {
  let captured;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks);
      captured = {
        url: request.url,
        headers: request.headers,
        raw,
        body: raw.toString('utf8'),
      };
      response.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'request-test' });
      response.end(JSON.stringify(responseValue));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  try {
    await run(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  return captured;
}

async function withProviderEnv(run) {
  const original = { ...process.env };
  process.env.OPENAI_TRANSCRIPTION_TIMEOUT_MS = '2000';
  process.env.OPENAI_TRANSCRIPTION_MAX_RETRIES = '1';

  try {
    await run();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) delete process.env[key];
    }
    Object.assign(process.env, original);
  }
}

function countMatches(value, search) {
  return value.split(search).length - 1;
}
