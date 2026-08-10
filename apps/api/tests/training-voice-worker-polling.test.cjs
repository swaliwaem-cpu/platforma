require('reflect-metadata');

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createTrainingVoiceWorkerIdlePollDelays,
  TrainingVoiceWorkerService,
} = require('../dist/training/training-voice-worker.service.js');
const {
  TrainingVoiceWorkerWakeupService,
} = require('../dist/training/training-voice-worker-wakeup.service.js');

test('voice worker idle delays follow the bounded 2/5/10/15 second progression', () => {
  assert.deepEqual(createTrainingVoiceWorkerIdlePollDelays(2_000), [
    2_000,
    5_000,
    10_000,
    15_000,
  ]);
  assert.deepEqual(createTrainingVoiceWorkerIdlePollDelays(250), [
    250,
    625,
    1_250,
    1_875,
  ]);
  assert.throws(
    () => createTrainingVoiceWorkerIdlePollDelays(0),
    /TRAINING_VOICE_WORKER_POLL_INTERVAL_INVALID/u,
  );
});

test('local wake-up isolates listener failures and keeps notifying other workers', () => {
  const wakeup = new TrainingVoiceWorkerWakeupService();
  let notified = 0;

  wakeup.subscribe(() => {
    throw new Error('listener failed');
  });
  wakeup.subscribe(() => {
    notified += 1;
  });

  assert.doesNotThrow(() => wakeup.kick());
  assert.equal(notified, 1);
});

test('fake timers prove idle claim queries back off and a local kick resets the delay', async () => {
  const previousEnvironment = {
    TRAINING_MODULE_ENABLED: process.env.TRAINING_MODULE_ENABLED,
    TRAINING_VOICE_WORKER_ENABLED: process.env.TRAINING_VOICE_WORKER_ENABLED,
    TRAINING_VOICE_WORKER_POLL_INTERVAL_MS:
      process.env.TRAINING_VOICE_WORKER_POLL_INTERVAL_MS,
  };
  const clock = new FakeClock();
  const restoreTimers = clock.install();
  const prisma = new IdlePrisma();
  const wakeup = new TrainingVoiceWorkerWakeupService();
  const worker = new TrainingVoiceWorkerService(
    prisma,
    {},
    {},
    {},
    {},
    {},
    wakeup,
  );

  process.env.TRAINING_MODULE_ENABLED = 'true';
  process.env.TRAINING_VOICE_WORKER_ENABLED = 'true';
  process.env.TRAINING_VOICE_WORKER_POLL_INTERVAL_MS = '2000';

  try {
    await worker.onModuleInit();
    await flushMicrotasks();
    assert.equal(prisma.claimCycles, 1);
    assert.equal(clock.nextTimeoutDelay(), 2_000);

    await clock.advanceBy(2_000);
    assert.equal(prisma.claimCycles, 2);
    assert.equal(clock.nextTimeoutDelay(), 5_000);

    await clock.advanceBy(5_000);
    assert.equal(prisma.claimCycles, 3);
    assert.equal(clock.nextTimeoutDelay(), 10_000);

    await clock.advanceBy(10_000);
    assert.equal(prisma.claimCycles, 4);
    assert.equal(clock.nextTimeoutDelay(), 15_000);

    await clock.advanceBy(43_000);
    assert.equal(prisma.claimCycles, 6);
    assert.equal(prisma.recoveryQueries, 5);
    assert.equal(prisma.claimQueries + prisma.recoveryQueries, 17);
    assert.ok(prisma.claimQueries + prisma.recoveryQueries < 93 / 3);

    wakeup.kick();
    await flushMicrotasks();
    assert.equal(prisma.claimCycles, 7);
    assert.equal(clock.nextTimeoutDelay(), 2_000);
  } finally {
    await worker.shutdown();
    restoreTimers();
    restoreEnvironment(previousEnvironment);
  }
});

class IdlePrisma {
  constructor() {
    this.claimCycles = 0;
    this.claimQueries = 0;
    this.recoveryQueries = 0;
  }

  async $queryRaw() {
    this.recoveryQueries += 1;
    return [];
  }

  async $transaction(run) {
    this.claimCycles += 1;
    return run({
      $queryRaw: async () => {
        this.claimQueries += 1;
        return [];
      },
    });
  }
}

class FakeClock {
  constructor() {
    this.now = 0;
    this.nextId = 1;
    this.timers = new Map();
  }

  install() {
    const original = {
      setTimeout: global.setTimeout,
      clearTimeout: global.clearTimeout,
      setInterval: global.setInterval,
      clearInterval: global.clearInterval,
    };
    global.setTimeout = (callback, delay = 0) => this.add(callback, delay, 0);
    global.clearTimeout = (id) => this.timers.delete(id);
    global.setInterval = (callback, delay = 0) => this.add(callback, delay, delay);
    global.clearInterval = (id) => this.timers.delete(id);

    return () => {
      global.setTimeout = original.setTimeout;
      global.clearTimeout = original.clearTimeout;
      global.setInterval = original.setInterval;
      global.clearInterval = original.clearInterval;
    };
  }

  add(callback, delay, repeat) {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, {
      callback,
      dueAt: this.now + Number(delay),
      repeat: Number(repeat),
    });
    return id;
  }

  nextTimeoutDelay() {
    const next = [...this.timers.values()]
      .filter((timer) => timer.repeat === 0)
      .sort((left, right) => left.dueAt - right.dueAt)[0];
    return next ? next.dueAt - this.now : null;
  }

  async advanceBy(milliseconds) {
    const target = this.now + milliseconds;

    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
      if (!next) break;

      const [id, timer] = next;
      this.now = timer.dueAt;
      if (timer.repeat > 0) {
        timer.dueAt += timer.repeat;
      } else {
        this.timers.delete(id);
      }
      timer.callback();
      await flushMicrotasks();
    }

    this.now = target;
    await flushMicrotasks();
  }
}

async function flushMicrotasks() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function restoreEnvironment(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
