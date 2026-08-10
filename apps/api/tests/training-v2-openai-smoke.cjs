const { createHash, randomUUID } = require('node:crypto');

const {
  DEFAULT_OPENAI_EVALUATION_MODEL,
  DEFAULT_OPENAI_TRANSCRIPTION_MODEL,
  TrainingOpenAIClient,
  TrainingOpenAIError,
} = require('../dist/training/training-openai-client.js');
const {
  OpenAITrainingEvaluator,
} = require('../dist/training/training-openai-evaluator.js');
const {
  OpenAITrainingTranscriber,
} = require('../dist/training/training-openai-transcriber.js');
const {
  calculateTrainingObjectiveMetrics,
} = require('../dist/training/training-evaluator.js');

if (
  process.env.TRAINING_AI_MODE !== 'openai' ||
  process.env.OPENAI_SMOKE_ENABLED !== 'true' ||
  !process.env.OPENAI_API_KEY?.trim()
) {
  console.log(JSON.stringify({
    status: 'skipped',
    required: [
      'TRAINING_AI_MODE=openai',
      'OPENAI_SMOKE_ENABLED=true',
      'OPENAI_API_KEY',
    ],
  }));
  process.exit(0);
}

process.env.OPENAI_TRANSCRIPTION_MAX_RETRIES = '0';
process.env.OPENAI_EVALUATION_MAX_RETRIES = '0';

void run();

async function run() {
  const requestedTranscriptionModel =
    process.env.OPENAI_TRANSCRIPTION_MODEL ?? DEFAULT_OPENAI_TRANSCRIPTION_MODEL;
  const requestedEvaluationModel =
    process.env.OPENAI_EVALUATOR_MODEL ??
    process.env.OPENAI_EVALUATION_MODEL ??
    DEFAULT_OPENAI_EVALUATION_MODEL;
  const client = new TrainingOpenAIClient(process.env.OPENAI_API_KEY);
  const transcriber = new OpenAITrainingTranscriber(client);
  const evaluator = new OpenAITrainingEvaluator(client);
  const wav = createSyntheticWav();
  const failures = [];
  let transcription = null;
  let evaluation = null;
  const projectId = randomUUID();
  const attemptId = randomUUID();
  const questionId = randomUUID();

  try {
    transcription = await transcriber.transcribe({
      projectId,
      attemptId,
      answerId: randomUUID(),
      fileId: randomUUID(),
      mimeType: 'audio/wav',
      sizeBytes: wav.length,
      checksum: createHash('sha256').update(wav).digest('hex'),
      wav,
      vocabularyPrompt: 'Краткий словарь имён и терминов: Platforma, аттестация',
    });
  } catch (error) {
    failures.push(`transcription:${safeFailureCode(error)}`);
  }

  const evaluationTranscript = transcription?.text ??
    'Синтетическая запись используется только для проверки structured evaluation.';
  const factId = randomUUID();
  const criterionId = randomUUID();
  const objectiveMetrics = calculateTrainingObjectiveMetrics({
    transcript: evaluationTranscript,
    audioDurationSeconds: 1,
    segmentCount: 1,
  });

  try {
    evaluation = await evaluator.evaluate({
      projectId,
      attemptId,
      questionId,
      projectKnowledgeVersion: 1,
      questionText: 'Повторите содержание короткой синтетической записи.',
      questionType: 'FOLLOW_UP',
      transcript: evaluationTranscript,
      facts: [{
        id: factId,
        statement: evaluationTranscript,
        aliases: [],
        required: true,
        position: 1,
      }],
      criteria: [{
        id: criterionId,
        code: 'synthetic_answer',
        title: 'Синтетический ответ',
        guidance: 'Оценить только совпадение с утверждённым фактом.',
        maxPoints: 15,
        position: 1,
      }],
      objectiveMetrics,
      maxScore: 15,
    });
  } catch (error) {
    failures.push(`evaluation:${safeFailureCode(error)}`);
  }

  console.log(JSON.stringify({
    status: failures.length ? 'failure' : 'success',
    ...(failures.length ? { failure: failures } : {}),
    transcription: providerSummary(requestedTranscriptionModel, transcription),
    evaluation: providerSummary(requestedEvaluationModel, evaluation),
  }));

  if (failures.length) process.exitCode = 1;
}

function providerSummary(requestedModel, result) {
  return {
    requestedModel,
    actualModel: result?.model ?? null,
    requestId: result?.requestId ?? null,
    usage: result?.usage ?? null,
    latencyMs: result?.latencyMs ?? null,
  };
}

function safeFailureCode(error) {
  return error instanceof TrainingOpenAIError ? error.code : 'OPENAI_SMOKE_FAILED';
}

function createSyntheticWav() {
  const sampleRate = 16_000;
  const samples = sampleRate;
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  for (let index = 0; index < samples; index += 1) {
    const envelope = Math.sin(Math.PI * index / samples);
    const sample = Math.round(
      Math.sin((2 * Math.PI * 440 * index) / sampleRate) * envelope * 4_000,
    );
    buffer.writeInt16LE(sample, 44 + index * 2);
  }

  return buffer;
}
