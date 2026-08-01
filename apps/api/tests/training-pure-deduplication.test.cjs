const assert = require('node:assert/strict');
const test = require('node:test');

const {
  hashCanonicalTrainingFactSuggestionJson,
} = require('../dist/training/fact-suggestions/training-fact-suggestion-canonical-json');
const { isTrainingUuid } = require('../dist/training/training-uuid');
const {
  waitForTrainingWorkerPromise,
} = require('../dist/training/training-worker-shutdown');

test('worker shutdown wait resolves true and clears its unref timeout', async () => {
  const nativeSetTimeout = global.setTimeout;
  const nativeClearTimeout = global.clearTimeout;
  let unrefCalls = 0;
  let clearCalls = 0;

  global.setTimeout = (callback, timeoutMs, ...args) => {
    const timeout = nativeSetTimeout(callback, timeoutMs, ...args);
    const nativeUnref = timeout.unref.bind(timeout);
    timeout.unref = () => {
      unrefCalls += 1;
      return nativeUnref();
    };
    return timeout;
  };
  global.clearTimeout = (timeout) => {
    clearCalls += 1;
    return nativeClearTimeout(timeout);
  };

  try {
    assert.equal(
      await waitForTrainingWorkerPromise(Promise.resolve(), 1_000),
      true,
    );
    assert.equal(unrefCalls, 1);
    assert.equal(clearCalls, 1);
  } finally {
    global.setTimeout = nativeSetTimeout;
    global.clearTimeout = nativeClearTimeout;
  }
});

test('worker shutdown wait returns false on timeout and propagates rejection', async () => {
  assert.equal(
    await waitForTrainingWorkerPromise(new Promise(() => {}), 1),
    false,
  );
  const failure = new Error('drain failed');
  await assert.rejects(
    waitForTrainingWorkerPromise(Promise.reject(failure), 1_000),
    (error) => error === failure,
  );
});

test('training UUID predicate preserves the accepted version and variant matrix', () => {
  const v1 = '00112233-4455-1677-8899-aabbccddeeff';
  const v4Uppercase = '00112233-4455-4677-A899-AABBCCDDEEFF';
  const v5 = '00112233-4455-5677-b899-aabbccddeeff';
  const v6 = '00112233-4455-6677-8899-aabbccddeeff';
  const v8 = '00112233-4455-8677-8899-aabbccddeeff';

  assert.equal(isTrainingUuid(v1), true);
  assert.equal(isTrainingUuid(v4Uppercase), true);
  assert.equal(isTrainingUuid(v5), true);
  assert.equal(isTrainingUuid(v6), false);
  assert.equal(isTrainingUuid(v6, 8), true);
  assert.equal(isTrainingUuid(v8, 8), true);

  for (const invalid of [
    '00112233-4455-0677-8899-aabbccddeeff',
    '00112233-4455-9677-8899-aabbccddeeff',
    '00112233-4455-4677-7899-aabbccddeeff',
    '00000000-0000-0000-0000-000000000000',
    ' 00112233-4455-4677-8899-aabbccddeeff',
    '{00112233-4455-4677-8899-aabbccddeeff}',
    '00112233445546778899aabbccddeeff',
    null,
    undefined,
  ]) {
    assert.equal(isTrainingUuid(invalid, 8), false);
  }
});

test('fact-suggestion canonical hash preserves stable JSON and SHA-256 semantics', () => {
  assert.equal(
    hashCanonicalTrainingFactSuggestionJson({}),
    '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  );
  assert.equal(
    hashCanonicalTrainingFactSuggestionJson({ b: 2, a: 1 }),
    '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777',
  );
  assert.equal(
    hashCanonicalTrainingFactSuggestionJson(null),
    '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
  );
  assert.equal(
    hashCanonicalTrainingFactSuggestionJson({
      text: 'ЖК\u00a0TATE',
      nested: { z: 1, a: [{ b: 2, a: 1 }, null] },
    }),
    '26fc44e8ab04a4d241f5813e88dffd5b3916532a8df9c99a3a389f43a282dbcd',
  );
  assert.equal(
    hashCanonicalTrainingFactSuggestionJson({ a: 1, b: 2 }),
    hashCanonicalTrainingFactSuggestionJson({ b: 2, a: 1 }),
  );
  assert.notEqual(
    hashCanonicalTrainingFactSuggestionJson([1, 2]),
    hashCanonicalTrainingFactSuggestionJson([2, 1]),
  );
  assert.equal(
    hashCanonicalTrainingFactSuggestionJson({ omitted: undefined }),
    hashCanonicalTrainingFactSuggestionJson({}),
  );
  assert.equal(
    hashCanonicalTrainingFactSuggestionJson([undefined]),
    hashCanonicalTrainingFactSuggestionJson([null]),
  );
  assert.throws(
    () => hashCanonicalTrainingFactSuggestionJson(undefined),
    TypeError,
  );
  const circular = {};
  circular.self = circular;
  assert.throws(
    () => hashCanonicalTrainingFactSuggestionJson(circular),
    RangeError,
  );
});
