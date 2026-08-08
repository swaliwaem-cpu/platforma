const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdtemp, open, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const {
  buildTrainingAudioChunkFfmpegArgs,
  calculateTrainingAudioChunkDuration,
  TrainingFfmpegConcurrencyGate,
} = require('../dist/training/training-audio.service.js');
const {
  getTrainingAudioLimits,
  OPENAI_TRANSCRIPTION_HARD_MAX_BYTES,
  TrainingAudioLimitsError,
} = require('../dist/training/training-audio-limits.js');
const {
  TrainingOpenAIClient,
} = require('../dist/training/training-openai-client.js');
const {
  mergeTrainingTranscriptChunks,
  OpenAITrainingTranscriber,
} = require('../dist/training/training-openai-transcriber.js');

test('audio limits keep every allowed Opus recording below the provider hard limit', () => {
  const limits = getTrainingAudioLimits({});
  const encodedUpperBound =
    Math.ceil((limits.maxDurationSeconds * limits.opusBitrateBps) / 8) + 1024 * 1024;

  assert.equal(limits.maxDurationSeconds, 1800);
  assert.ok(encodedUpperBound < OPENAI_TRANSCRIPTION_HARD_MAX_BYTES);
  assert.ok(limits.maxBufferedBytes >= limits.maxSegmentBytes);
  assert.throws(
    () => getTrainingAudioLimits({ TRAINING_AUDIO_MAX_BUFFERED_BYTES: '65536' }),
    (error) =>
      error instanceof TrainingAudioLimitsError &&
      error.code === 'TRAINING_AUDIO_MAX_BUFFERED_BYTES_INVALID',
  );
});

test('provider chunk plan uses bounded WebM Opus parts with deterministic overlap', () => {
  const limits = getTrainingAudioLimits({
    TRAINING_AUDIO_PROVIDER_UPLOAD_MAX_BYTES: String(256 * 1024),
    TRAINING_AUDIO_CHUNK_OVERLAP_SECONDS: '2',
  });
  const duration = calculateTrainingAudioChunkDuration(limits);
  const args = buildTrainingAudioChunkFfmpegArgs(
    '/tmp/merged.webm',
    '/tmp/part.webm',
    duration - limits.chunkOverlapSeconds,
    duration,
    limits.opusBitrateBps,
  );

  assert.ok(duration > limits.chunkOverlapSeconds);
  assert.equal(args.includes('-ss'), true);
  assert.equal(args.includes('-t'), true);
  assert.equal(args.includes('libopus'), true);
  assert.equal(args.includes('webm'), true);
  assert.equal(args.at(-1), '/tmp/part.webm');
});

test('ffmpeg concurrency gate is independent and never exceeds its configured capacity', async () => {
  const gate = new TrainingFfmpegConcurrencyGate();
  let active = 0;
  let peak = 0;
  const releases = [];
  const tasks = Array.from({ length: 3 }, () => gate.run(1, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => releases.push(resolve));
    active -= 1;
  }));

  await waitFor(() => releases.length === 1);
  releases.shift()();
  await waitFor(() => releases.length === 1);
  releases.shift()();
  await waitFor(() => releases.length === 1);
  releases.shift()();
  await Promise.all(tasks);

  assert.equal(peak, 1);
});

test('chunk transcripts merge overlap once and provider uploads stream files in order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'training-audio-provider-'));
  const firstPath = join(directory, 'part-1.webm');
  const secondPath = join(directory, 'part-2.webm');
  const webm = makeWebm();
  await writeFile(firstPath, webm);
  await writeFile(secondPath, webm);
  const requests = [];
  const transcriber = new OpenAITrainingTranscriber(
    new TrainingOpenAIClient('test-key', async (_url, init) => {
      const form = init.body;
      const file = form.get('file');
      requests.push({
        fileName: file.name,
        fileSize: file.size,
        prompt: form.get('prompt'),
      });
      return jsonResponse({
        text: requests.length === 1
          ? 'Первая фраза общий контекст'
          : 'общий контекст вторая фраза',
      });
    }, 'https://openai.invalid/v1'),
  );

  try {
    const result = await transcriber.transcribe({
      projectId: 'project-id',
      attemptId: 'attempt-id',
      answerId: 'answer-id',
      fileId: 'file-id',
      mimeType: 'audio/webm',
      sizeBytes: webm.length * 2,
      checksum: 'merged-checksum',
      vocabularyPrompt: 'Словарь: ЖК Север',
      providerUploads: [firstPath, secondPath].map((filePath, sequence) => ({
        sequence,
        filePath,
        fileName: `answer-part-${sequence + 1}.webm`,
        mimeType: 'audio/webm',
        sizeBytes: webm.length,
        checksum: `checksum-${sequence}`,
        startSeconds: sequence * 28,
        endSeconds: sequence * 28 + 30,
      })),
    });

    assert.equal(result.text, 'Первая фраза общий контекст вторая фраза');
    assert.equal(result.attempts, 2);
    assert.deepEqual(requests.map((request) => request.fileName), [
      'answer-part-1.webm',
      'answer-part-2.webm',
    ]);
    assert.equal(requests.every((request) => request.fileSize === webm.length), true);
    assert.match(requests[1].prompt, /Конец предыдущей части/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('maximum provider upload stays file-backed through the native HTTP client', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'training-audio-max-upload-'));
  const filePath = join(directory, 'maximum.webm');
  const sizeBytes = 24 * 1024 * 1024;
  const handle = await open(filePath, 'w');
  await handle.truncate(sizeBytes);
  await handle.write(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), 0, 4, 0);
  await handle.close();
  let receivedBytes = 0;
  const server = createServer((request, response) => {
    request.on('data', (chunk) => { receivedBytes += chunk.length; });
    request.on('end', () => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'x-request-id': 'request-max-upload',
      });
      response.end(JSON.stringify({ text: 'Максимальный файл принят' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const transcriber = new OpenAITrainingTranscriber(
    new TrainingOpenAIClient('test-key', fetch, `http://127.0.0.1:${address.port}/v1`),
  );

  try {
    const result = await transcriber.transcribe({
      projectId: 'project-id',
      attemptId: 'attempt-id',
      answerId: 'answer-id',
      fileId: 'file-id',
      mimeType: 'audio/webm',
      sizeBytes,
      checksum: 'file-backed-checksum',
      filePath,
      fileName: 'maximum.webm',
      vocabularyPrompt: '',
    });

    assert.equal(result.text, 'Максимальный файл принят');
    assert.ok(receivedBytes > sizeBytes);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test('transcript merge preserves order when overlap is absent', () => {
  assert.equal(
    mergeTrainingTranscriptChunks([' первая часть ', 'Вторая часть']),
    'первая часть Вторая часть',
  );
});

function makeWebm(size = 64) {
  const body = Buffer.alloc(size);
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(body);
  return body;
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-request-id': 'request-test' },
  });
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Condition was not reached');
}
