require('reflect-metadata');

const assert = require('node:assert/strict');
const { chmod, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const {
  FakeTrainingTelegramClient,
  TrainingTelegramClientError,
} = require('../dist/training/training-telegram-client.js');
const {
  hashTrainingTelegramLinkToken,
  isPrivateTrainingTelegramUpdate,
  parseTrainingTelegramCallback,
} = require('../dist/training/training-telegram.service.js');
const {
  buildTrainingFfmpegArgs,
  SpawnTrainingFfmpegRunner,
  TrainingAudioError,
} = require('../dist/training/training-audio.service.js');
const {
  DeterministicFakeTrainingTranscriber,
} = require('../dist/training/training-transcriber.js');

test('Telegram link tokens are hashed deterministically without storing raw data', () => {
  const rawToken = '0123456789abcdefghijklmnopqrstuvwxyzABCDE';
  const first = hashTrainingTelegramLinkToken(rawToken);
  const second = hashTrainingTelegramLinkToken(rawToken);

  assert.equal(first, second);
  assert.equal(first.length, 64);
  assert.notEqual(first, rawToken);
  assert.match(first, /^[0-9a-f]{64}$/u);
});

test('Telegram callback parser accepts only exact start and finish UUID payloads', () => {
  const id = '11111111-1111-4111-8111-111111111111';

  assert.deepEqual(parseTrainingTelegramCallback(`tr:start:${id}`), {
    kind: 'START',
    id,
  });
  assert.deepEqual(parseTrainingTelegramCallback(`tr:finish:${id}`), {
    kind: 'FINISH',
    id,
  });
  assert.equal(parseTrainingTelegramCallback(`tr:finish:${id}:extra`), null);
  assert.equal(parseTrainingTelegramCallback('tr:start:not-a-uuid'), null);
  assert.equal(parseTrainingTelegramCallback(`unknown:${id}`), null);
});

test('Telegram update boundary accepts private messages/callbacks and ignores groups', () => {
  assert.equal(
    isPrivateTrainingTelegramUpdate({
      message: { chat: { id: 10, type: 'private' } },
    }),
    true,
  );
  assert.equal(
    isPrivateTrainingTelegramUpdate({
      callback_query: { message: { chat: { id: 10, type: 'private' } } },
    }),
    true,
  );
  assert.equal(
    isPrivateTrainingTelegramUpdate({
      message: { chat: { id: -10, type: 'group' } },
    }),
    false,
  );
  assert.equal(isPrivateTrainingTelegramUpdate({ channel_post: {} }), false);
});

test('fake Telegram client records outbound calls and serves bounded local files', async () => {
  const client = new FakeTrainingTelegramClient();
  const body = Buffer.from('OggS-fake');
  client.registerFile('voice-1', { body, mimeType: 'audio/ogg' });

  await client.sendMessage({ chatId: 100n, text: 'Вопрос' });
  await client.answerCallbackQuery('callback-1', 'Принято');
  const file = await client.getFile('voice-1');
  const downloaded = await client.downloadFile(file.filePath, 100);

  assert.equal(client.sentMessages.length, 1);
  assert.equal(client.answeredCallbacks.length, 1);
  assert.equal(downloaded.body.equals(body), true);
  assert.equal(downloaded.mimeType, 'audio/ogg');
  await assert.rejects(
    () => client.downloadFile(file.filePath, 2),
    (error) =>
      error instanceof TrainingTelegramClientError && error.code === 'FILE_TOO_LARGE',
  );
});

test('ffmpeg arguments preserve persisted input order and normalize to mono 16 kHz PCM WAV', () => {
  const args = buildTrainingFfmpegArgs(
    ['/tmp/segment-001.ogg', '/tmp/segment-002.ogg'],
    '/tmp/merged.wav',
  );

  assert.deepEqual(args.slice(0, 5), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y']);
  assert.equal(args.indexOf('/tmp/segment-001.ogg') < args.indexOf('/tmp/segment-002.ogg'), true);
  assert.equal(args.includes('[0:a][1:a]concat=n=2:v=0:a=1[out]'), true);
  assert.deepEqual(args.slice(-9), [
    '-map',
    '[out]',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    '-f',
    'wav',
    '/tmp/merged.wav',
  ].slice(-9));
  assert.equal(args.includes('shell'), false);
});

test('one voice segment is still normalized and fake transcription is deterministic pass text', async () => {
  const args = buildTrainingFfmpegArgs(['/tmp/only.ogg'], '/tmp/merged.wav');
  const transcriber = new DeterministicFakeTrainingTranscriber();
  const metadata = {
    answerId: 'answer-id',
    fileId: 'file-id',
    mimeType: 'audio/wav',
    sizeBytes: 1024,
  };

  assert.equal(args.includes('-vn'), true);
  assert.equal(args.includes('-filter_complex'), false);
  const first = await transcriber.transcribe(metadata);
  const second = await transcriber.transcribe(metadata);
  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    text: '[fake:pass]',
    model: 'deterministic-fake-transcriber',
    requestId: null,
    latencyMs: 0,
    attempts: 1,
    usage: null,
  });
});

test('ffmpeg runner enforces timeout without shell interpolation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'training-fake-ffmpeg-'));
  const executable = join(directory, 'ffmpeg');
  const previousPath = process.env.PATH;
  await writeFile(executable, '#!/bin/sh\nsleep 2\n', { flag: 'wx' });
  await chmod(executable, 0o700);
  process.env.PATH = `${directory}:${previousPath ?? ''}`;

  try {
    await assert.rejects(
      () => new SpawnTrainingFfmpegRunner().run(['ignored'], 50),
      (error) => error instanceof TrainingAudioError && error.code === 'FFMPEG_TIMEOUT',
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
