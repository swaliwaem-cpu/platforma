require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');

const {
  AssistantSourceDiscoveryError,
  AssistantSourceDiscoveryProviderBoundary,
  createDeveloperDiscoveryRequestBody,
  readBoundedJson,
} = require('../dist/assistant/sources/assistant-source-discovery-provider.js');
const {
  estimateAssistantAiCallCost,
} = require('../dist/assistant/operations/assistant-ai-cost.js');

const project = {
  projectKey: 'zhiloj-kompleks-amber-city',
  title: 'ЖК Amber City (Эмбер сити)',
  developerKey: 'fsk',
  developerName: 'ФСК',
  address: 'Москва, Шелепихинская набережная, дом 34',
};

test('Assistant source discovery provider boundary owns retry, ledger and phase telemetry', async () => {
  const events = [];
  let providerCalls = 0;
  const executionId = randomUUID();
  const boundary = new AssistantSourceDiscoveryProviderBoundary({
    environment: {
      OPENAI_API_KEY: 'bounded-local-stub',
      ASSISTANT_AI_MODE: 'openai',
      ASSISTANT_SOURCE_DISCOVERY_LIVE: 'true',
      ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
    },
    async fetchImplementation(_url, init) {
      providerCalls += 1;
      const body = JSON.parse(init.body);
      events.push(`http:${providerCalls}:${body.model}`);
      if (providerCalls === 1) throw new Error('simulated retryable network failure');
      return developerResponse();
    },
    serviceOptions: {
      usageBudgets: {
        async reserve(input) {
          events.push(`reserve:${input.attemptOrdinal}:${input.model}`);
          return {
            id: `reservation-${input.attemptOrdinal}`,
            operationRunId: input.operationRunId,
            executionId: input.executionId,
            attemptOrdinal: input.attemptOrdinal,
            provider: input.provider,
            model: input.model,
            serviceTier: input.serviceTier,
            usageDate: new Date('2026-08-27T00:00:00.000Z'),
            reservationExpiresAt: new Date('2026-08-27T00:03:00.000Z'),
            reservedCostUsd: input.reservedCostUsd,
          };
        },
        async settle(input) {
          events.push(`settle:${input.reservation.attemptOrdinal}:${input.errorCode ?? input.outcome}`);
          return true;
        },
      },
      dailyBudgetUsd: '1.00000000',
      maximumRunCostUsd: '1.00000000',
      operationRunId: 'stage-7-provider-boundary',
      executionId,
    },
    validatorVersion: 'assistant-source-discovery-validator-v1',
  });

  const result = await boundary.withProject(project.projectKey, () => (
    boundary.requestCandidate({ phase: 'DEVELOPER', project })
  ));

  assert.deepEqual(events, [
    'reserve:1:gpt-5.6-luna',
    'http:1:gpt-5.6-luna',
    'settle:1:ASSISTANT_SOURCE_DISCOVERY_NETWORK_FAILED',
    'reserve:2:gpt-5.6-luna',
    'http:2:gpt-5.6-luna',
    'settle:2:PROVIDER_SUCCESS',
  ]);
  assert.equal(result.value.model, 'gpt-5.6-luna');
  assert.equal(result.phaseTelemetries.length, 2);
  assert.deepEqual(result.phaseTelemetries.map(({ webSearchCalls }) => webSearchCalls), [null, 1]);
  assert.deepEqual(result.phaseTelemetry, {
    phase: 'DEVELOPER',
    attemptOrdinal: 2,
    provider: 'openai',
    model: 'gpt-5.6-luna',
    requestId: 'request-provider-boundary',
    responseId: 'response-provider-boundary',
    httpStatus: 200,
    inputTokens: 20,
    cachedInputTokens: 4,
    cacheWriteInputTokens: 2,
    outputTokens: 10,
    reasoningTokens: 3,
    totalTokens: 30,
    webSearchCalls: 1,
  });
});

test('ZAEBAL4 source discovery settles two returned Web Search calls before rejecting the candidate', async () => {
  const events = [];
  const reservations = [];
  const settlements = [];
  const providerBodies = [];
  const executionId = randomUUID();
  const boundary = new AssistantSourceDiscoveryProviderBoundary({
    environment: {
      OPENAI_API_KEY: 'bounded-local-stub',
      ASSISTANT_AI_MODE: 'openai',
      ASSISTANT_SOURCE_DISCOVERY_LIVE: 'true',
      ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
    },
    async fetchImplementation(_url, init) {
      providerBodies.push(JSON.parse(init.body));
      events.push('http');
      return developerResponse(2);
    },
    serviceOptions: {
      usageBudgets: {
        async reserve(input) {
          reservations.push(input);
          events.push('reserve');
          return {
            id: `reservation-${input.attemptOrdinal}`,
            operationRunId: input.operationRunId,
            executionId: input.executionId,
            attemptOrdinal: input.attemptOrdinal,
            provider: input.provider,
            model: input.model,
            serviceTier: input.serviceTier,
            usageDate: new Date('2026-08-30T00:00:00.000Z'),
            reservationExpiresAt: new Date('2026-08-30T00:03:00.000Z'),
            reservedCostUsd: input.reservedCostUsd,
          };
        },
        async settle(input) {
          settlements.push(input);
          events.push('settle');
          return true;
        },
      },
      dailyBudgetUsd: '1.00000000',
      maximumRunCostUsd: '1.00000000',
      operationRunId: 'zaebal4-tool-call-contract',
      executionId,
    },
    validatorVersion: 'assistant-source-discovery-validator-v3',
  });

  await assert.rejects(
    boundary.withProject(project.projectKey, () => (
      boundary.requestCandidate({ phase: 'DEVELOPER', project })
    )),
    (error) => error instanceof AssistantSourceDiscoveryError
      && error.code === 'ASSISTANT_SOURCE_DISCOVERY_TOOL_CALL_LIMIT_EXCEEDED',
  );

  assert.deepEqual(events, ['reserve', 'http', 'settle']);
  assert.equal(providerBodies.length, 1);
  assert.equal(providerBodies[0].max_tool_calls, 1);
  assert.equal(reservations.length, 1);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].webSearchCalls, 2);
  assert.equal(settlements[0].outcome, 'PROVIDER_CONTRACT_VIOLATION');
  assert.equal(
    settlements[0].errorCode,
    'ASSISTANT_SOURCE_DISCOVERY_TOOL_CALL_LIMIT_EXCEEDED',
  );
  const conservativeReservation = estimateAssistantAiCallCost({
    model: 'gpt-5.6-luna',
    requestBytes: Buffer.byteLength(JSON.stringify(createDeveloperDiscoveryRequestBody(
      'gpt-5.6-luna',
      project,
    )), 'utf8'),
    maxOutputTokens: 1_600,
    maxWebSearchCalls: 2,
  });
  assert.equal(reservations[0].reservedCostUsd, conservativeReservation.estimatedUsd);
});

test('Assistant source discovery provider reader stops before buffering an oversized body', async () => {
  let pulledChunks = 0;
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) {
      pulledChunks += 1;
      controller.enqueue(new Uint8Array(1_024).fill(120));
      if (pulledChunks === 100) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  }), {
    status: 200,
    headers: { 'x-request-id': 'oversized-response-request' },
  });

  await assert.rejects(
    readBoundedJson(response, 2_048),
    (error) => error instanceof AssistantSourceDiscoveryError
      && error.code === 'ASSISTANT_SOURCE_DISCOVERY_RESPONSE_TOO_LARGE'
      && error.requestId === 'oversized-response-request',
  );
  assert.ok(pulledChunks <= 4, `reader consumed ${pulledChunks} chunks before rejecting`);
  assert.equal(cancelled, true);
});

function developerResponse(webSearchCallCount = 1) {
  return new Response(JSON.stringify({
    id: 'response-provider-boundary',
    model: 'gpt-5.6-luna',
    output: [
      {
        type: 'message',
        content: [{
          type: 'output_text',
          text: JSON.stringify({
            status: 'FOUND',
            canonicalUrl: 'https://developer.example/',
            officialDeveloperName: 'ФСК',
            reason: 'Официальный сайт найден.',
          }),
        }],
      },
      ...Array.from({ length: webSearchCallCount }, (_, index) => ({
        type: 'web_search_call',
        id: `search-provider-boundary-${index + 1}`,
        action: { sources: [{ url: 'https://developer.example/' }] },
      })),
    ],
    usage: {
      input_tokens: 20,
      input_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
      output_tokens: 10,
      output_tokens_details: { reasoning_tokens: 3 },
      total_tokens: 30,
    },
  }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-request-id': 'request-provider-boundary',
    },
  });
}
