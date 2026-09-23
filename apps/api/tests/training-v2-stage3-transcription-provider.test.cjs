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

test('Qwen ASR transcription sends one inline WAV part with Russian and bounded vocabulary', async () => {
  const wav = makeWav();
  const usageRecords = [];
  const request = await captureNativeRequest(asrResponse('Тестовая расшифровка'), async (baseUrl) => {
    const transcriber = new OpenAITrainingTranscriber(
      new TrainingOpenAIClient('test-key', fetch, baseUrl),
      { record: async (value) => { usageRecords.push(value); return true; } },
    );
    const result = await transcriber.transcribe(makeInput(wav, 'Словарь: ЖК Север'));

    assert.equal(result.text, 'Тестовая расшифровка');
    assert.equal(result.model, 'qwen3-asr-flash');
    assert.equal(result.requestId, 'request-test');
  });

  const body = JSON.parse(request.body);
  assert.equal(request.url, '/compatible-mode/v1/chat/completions');
  assert.match(request.headers['content-type'], /^application\/json/u);
  assert.equal(body.model, 'qwen3-asr-flash');
  assert.equal(body.stream, false);
  assert.deepEqual(body.asr_options, { language: 'ru', enable_itn: false });
  assert.deepEqual(body.messages.map((message) => message.role), ['system', 'user']);
  assert.match(body.messages[0].content[0].text, /ЖК Север/u);
  assert.equal(body.messages[1].content.length, 1);
  assert.equal(body.messages[1].content[0].type, 'input_audio');
  assert.equal(
    body.messages[1].content[0].input_audio.data,
    `data:audio/wav;base64,${wav.toString('base64')}`,
  );
  assert.equal(usageRecords.length, 1);
  assert.equal(usageRecords[0].outcome, 'accepted');
  assert.equal(usageRecords[0].operation, 'training_audio_transcription');
  assert.equal(usageRecords[0].attemptOrdinal, 1);
  assert.deepEqual(usageRecords[0].usage, {
    inputTokens: 275,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 12,
    reasoningTokens: null,
    totalTokens: 287,
  });
});

test('Qwen ASR transcription without vocabulary sends only the audio message', async () => {
  let body;
  const transcriber = makeTranscriber(async (_url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse(asrResponse('ok'));
  });

  await withProviderEnv(() => transcriber.transcribe(makeInput(makeWav(), '')));
  assert.deepEqual(body.messages.map((message) => message.role), ['user']);
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

test('Qwen ASR transcription retries 429 and 500 but not permanent 400/401', async () => {
  await withProviderEnv(async () => {
    for (const status of [429, 500]) {
      let calls = 0;
      const transcriber = makeTranscriber(async () => {
        calls += 1;
        return calls === 1
          ? new Response('', { status, headers: { 'retry-after': '0' } })
          : jsonResponse(asrResponse('ok'));
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

test('Qwen ASR transcription bounds timeout and rejects empty/malformed responses', async () => {
  await withProviderEnv(async () => {
    process.env.TRAINING_TRANSCRIPTION_TIMEOUT_MS = '1000';
    process.env.TRAINING_TRANSCRIPTION_MAX_RETRIES = '0';
    const timedOut = makeTranscriber((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    await assert.rejects(() => timedOut.transcribe(makeInput(makeWav(), '')), (error) => error.code === 'OPENAI_TIMEOUT');

    for (const payload of [asrResponse(''), { text: 'legacy' }, { unexpected: true }]) {
      const malformed = makeTranscriber(async () => jsonResponse(payload));
      await assert.rejects(() => malformed.transcribe(makeInput(makeWav(), '')), (error) => error.code === 'OPENAI_EMPTY_TRANSCRIPT');
    }
  });
});

test('Qwen ASR transcription forwards caller abort and does not retry a cancelled request', async () => {
  await withProviderEnv(async () => {
    process.env.TRAINING_TRANSCRIPTION_TIMEOUT_MS = '10000';
    process.env.TRAINING_TRANSCRIPTION_MAX_RETRIES = '2';
    const controller = new AbortController();
    let calls = 0;
    let signalStarted;
    const started = new Promise((resolve) => { signalStarted = resolve; });
    const transcriber = makeTranscriber((_url, init) => {
      calls += 1;
      signalStarted();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
    });
    const request = transcriber.transcribe(
      makeInput(makeWav(), ''),
      { signal: controller.signal },
    );

    await started;
    controller.abort();

    await assert.rejects(
      () => request,
      (error) => error.code === 'OPENAI_ABORTED' && error.attempts === 1,
    );
    assert.equal(calls, 1);
  });
});

test('Retry-After outside the hard deadline preserves the completed request count', async () => {
  await withProviderEnv(async () => {
    process.env.TRAINING_TRANSCRIPTION_TIMEOUT_MS = '1000';
    process.env.TRAINING_TRANSCRIPTION_MAX_RETRIES = '2';
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

test('Qwen ASR transcription rejects invalid or oversized audio before fetch', async () => {
  let calls = 0;
  const transcriber = makeTranscriber(async () => {
    calls += 1;
    return jsonResponse(asrResponse('unexpected'));
  });
  await assert.rejects(() => transcriber.transcribe(makeInput(Buffer.alloc(50), '')), (error) => error.code === 'OPENAI_INVALID_AUDIO');
  const oversized = makeWav(9 * 1024 * 1024 + 1);
  await assert.rejects(() => transcriber.transcribe(makeInput(oversized, '')), (error) => error.code === 'OPENAI_INVALID_AUDIO');
  assert.equal(calls, 0);
});

function makeTranscriber(fetchImplementation) {
  return new OpenAITrainingTranscriber(
    new TrainingOpenAIClient(
      'test-key',
      fetchImplementation,
      'https://dashscope.invalid/compatible-mode/v1',
    ),
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

function asrResponse(text) {
  return {
    id: 'chatcmpl-asr',
    object: 'chat.completion',
    model: 'qwen3-asr-flash',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: text },
    }],
    usage: {
      prompt_tokens: 275,
      prompt_tokens_details: { audio_tokens: 245, text_tokens: 30 },
      completion_tokens: 12,
      total_tokens: 287,
      seconds: 9,
    },
  };
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
    await run(`http://127.0.0.1:${address.port}/compatible-mode/v1`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  return captured;
}

async function withProviderEnv(run) {
  const original = { ...process.env };
  process.env.TRAINING_TRANSCRIPTION_TIMEOUT_MS = '2000';
  process.env.TRAINING_TRANSCRIPTION_MAX_RETRIES = '1';
  delete process.env.TRAINING_TRANSCRIPTION_MODEL;

  try {
    return await run();
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
