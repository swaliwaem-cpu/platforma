require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const { NestFactory } = require('@nestjs/core');

const {
  TrainingAttemptStateService,
} = require('../dist/training/training-attempt-state.service.js');
const {
  TrainingVoiceWorkerService,
} = require('../dist/training/training-voice-worker.service.js');
const {
  TrainingVoiceWorkerWakeupService,
} = require('../dist/training/training-voice-worker-wakeup.service.js');

test('Training wake-up DI metadata uses the injectable class for both consumers', () => {
  const attemptStateParamTypes = Reflect.getMetadata(
    'design:paramtypes',
    TrainingAttemptStateService,
  );
  const voiceWorkerParamTypes = Reflect.getMetadata(
    'design:paramtypes',
    TrainingVoiceWorkerService,
  );

  assert.equal(attemptStateParamTypes[4], TrainingVoiceWorkerWakeupService);
  assert.equal(voiceWorkerParamTypes[6], TrainingVoiceWorkerWakeupService);
});

const databaseUrl = process.env.TRAINING_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('TrainingModule DI integration requires the targeted temporary database runner', () => {
    assert.equal(process.env.TRAINING_TEST_DATABASE_URL, undefined);
  });
} else {
  test('TrainingModule resolves one wake-up singleton for both consumers', async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = 'test';
    process.env.TRAINING_AI_MODE = 'fake';
    process.env.TELEGRAM_TRANSPORT_MODE = 'fake';
    process.env.TRAINING_MODULE_ENABLED = 'true';
    process.env.TRAINING_VOICE_WORKER_ENABLED = 'false';
    process.env.TRAINING_MATERIAL_WORKER_ENABLED = 'false';
    process.env.TRAINING_TELEGRAM_OUTBOX_WORKER_ENABLED = 'false';
    delete process.env.OPENAI_API_KEY;

    const { TrainingModule } = require('../dist/training/training.module.js');
    const application = await NestFactory.createApplicationContext(TrainingModule, {
      logger: false,
    });

    try {
      const wakeup = application.get(TrainingVoiceWorkerWakeupService);
      const attemptState = application.get(TrainingAttemptStateService);
      const voiceWorker = application.get(TrainingVoiceWorkerService);

      assert.equal(attemptState.voiceWorkerWakeup, wakeup);
      assert.equal(voiceWorker.wakeup, wakeup);
    } finally {
      await application.close();
    }
  });
}
