require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');

const {
  AssistantSourceDiscoveryProviderBoundary,
} = require('../dist/assistant/sources/assistant-source-discovery-provider.js');

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
  assert.deepEqual(result.phaseTelemetry, {
    phase: 'DEVELOPER',
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

function developerResponse() {
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
      {
        type: 'web_search_call',
        action: { sources: [{ url: 'https://developer.example/' }] },
      },
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
