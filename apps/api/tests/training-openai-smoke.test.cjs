const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const test = require('node:test');

const {
  runTrainingOpenAiSmoke,
  SMOKE_SCHEMA_VERSION,
} = require('../scripts/run-training-openai-smoke.cjs');

function createSmokeEnvironment() {
  return {
    NODE_ENV: 'development',
    OPENAI_PROVIDER_MODE: 'real',
    OPENAI_API_KEY: 'opaque_live_smoke_9Jw4nR2sT8vK6qP3mL7x',
    OPENAI_SMOKE_ENABLED: 'true',
    OPENAI_TRANSCRIPTION_MODEL: 'smoke-transcription-model',
    OPENAI_EVALUATION_MODEL: 'smoke-evaluation-model',
    OPENAI_EVALUATION_REASONING: 'medium',
  };
}

test('OpenAI smoke performs exactly one transcription and one structured evaluation request', async (t) => {
  const counts = { transcription: 0, evaluation: 0 };
  let evaluationRequest;
  const server = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    if (request.url === '/v1/audio/transcriptions') {
      counts.transcription += 1;
      assert.match(
        request.headers['content-type'],
        /^multipart\/form-data; boundary=/u,
      );
      response.writeHead(200, {
        'content-type': 'application/json',
        'x-request-id': 'smoke-transcription-request',
      });
      response.end(
        JSON.stringify({
          text: 'Проверка связи прошла',
          model: 'smoke-transcription-actual',
          usage: { input_tokens: 1 },
        }),
      );
      return;
    }
    if (request.url === '/v1/responses') {
      counts.evaluation += 1;
      evaluationRequest = JSON.parse(body.toString('utf8'));
      response.writeHead(200, {
        'content-type': 'application/json',
        'x-request-id': 'smoke-evaluation-request',
      });
      response.end(
        JSON.stringify({
          status: 'completed',
          model: 'smoke-evaluation-actual',
          usage: { output_tokens: 1 },
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    schema_version: SMOKE_SCHEMA_VERSION,
                    criterion_id: 'smoke-criterion',
                    anchor_id: 'smoke-anchor',
                  }),
                },
              ],
            },
          ],
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  const baseUrl = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const writes = [];
  const result = await runTrainingOpenAiSmoke({
    environment: createSmokeEnvironment(),
    baseUrl,
    writeOutput: (value) => writes.push(value),
  });

  assert.deepEqual(counts, { transcription: 1, evaluation: 1 });
  assert.equal(evaluationRequest.store, false);
  assert.equal(evaluationRequest.text.format.strict, true);
  assert.equal(
    evaluationRequest.text.format.schema.properties.schema_version.enum[0],
    SMOKE_SCHEMA_VERSION,
  );
  assert.equal(result.ok, true);
  assert.equal(writes.length, 1);
  const serialized = writes[0];
  assert.equal(serialized.includes('Проверка связи прошла'), false);
  assert.equal(serialized.includes('"input"'), false);
  assert.equal(serialized.includes('"output"'), false);
  assert.equal(serialized.includes('"prompt"'), false);
});

test('OpenAI smoke disables retries and stops after one 429 transcription request', async (t) => {
  let transcriptionCalls = 0;
  let evaluationCalls = 0;
  const server = createServer((request, response) => {
    if (request.url === '/v1/audio/transcriptions') {
      transcriptionCalls += 1;
      response.writeHead(429, { 'retry-after': '0' }).end('fixture');
      return;
    }
    evaluationCalls += 1;
    response.writeHead(500).end();
  });
  const baseUrl = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await assert.rejects(
    () =>
      runTrainingOpenAiSmoke({
        environment: createSmokeEnvironment(),
        baseUrl,
      }),
    (error) => error.code === 'OPENAI_HTTP_429',
  );
  assert.equal(transcriptionCalls, 1);
  assert.equal(evaluationCalls, 0);
});

test('OpenAI smoke rejects refusal without exposing response content', async (t) => {
  const counts = { transcription: 0, evaluation: 0 };
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/audio/transcriptions') {
      counts.transcription += 1;
      response.end(JSON.stringify({ text: 'fixture' }));
      return;
    }
    counts.evaluation += 1;
    response.end(
      JSON.stringify({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'refusal',
                refusal: 'sensitive refusal fixture',
              },
            ],
          },
        ],
      }),
    );
  });
  const baseUrl = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await assert.rejects(
    () =>
      runTrainingOpenAiSmoke({
        environment: createSmokeEnvironment(),
        baseUrl,
      }),
    (error) =>
      error.code === 'SMOKE_EVALUATION_REFUSAL' &&
      !error.message.includes('sensitive refusal fixture'),
  );
  assert.deepEqual(counts, { transcription: 1, evaluation: 1 });
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}
