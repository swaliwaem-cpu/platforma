#!/usr/bin/env node

'use strict';

const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { PrismaClient } = require('@prisma/client');

const {
  assistantEvalEvaluatorVersion,
  computeAssistantEvalDatasetSha256,
  loadAssistantEvalDataset,
} = require('../dist/assistant/eval/assistant-eval.js');

void run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'ASSISTANT_EVAL_MANIFEST_FAILED'}\n`);
  process.exitCode = 1;
});

async function run() {
  const dataset = loadAssistantEvalDataset(JSON.parse(readFileSync(
    resolve(__dirname, '../tests/fixtures/assistant/assistant-eval-v1.json'),
    'utf8',
  )));
  const evaluatedAt = new Date();
  const minimumCompletedAt = new Date(evaluatedAt.getTime() - 24 * 60 * 60 * 1_000);
  const prisma = new PrismaClient();
  let persistedRuns;
  try {
    persistedRuns = await prisma.assistantRun.findMany({
      where: {
        status: 'COMPLETED',
        completedAt: { gte: minimumCompletedAt, lte: evaluatedAt },
        userMessage: { content: { in: dataset.cases.map(({ query }) => query) } },
      },
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, userMessage: { select: { content: true } } },
    });
  } finally {
    await prisma.$disconnect();
  }
  const latestByQuery = new Map();
  for (const persistedRun of persistedRuns) {
    if (!latestByQuery.has(persistedRun.userMessage.content)) {
      latestByQuery.set(persistedRun.userMessage.content, persistedRun.id);
    }
  }
  const missingCaseIds = dataset.cases
    .filter(({ query }) => !latestByQuery.has(query))
    .map(({ id }) => id);
  if (missingCaseIds.length > 0) {
    throw new Error(`ASSISTANT_EVAL_PERSISTED_RUNS_MISSING:${missingCaseIds.join(',')}`);
  }
  process.stdout.write(`${JSON.stringify({
    datasetVersion: dataset.version,
    datasetSha256: computeAssistantEvalDatasetSha256(dataset),
    evaluatorVersion: assistantEvalEvaluatorVersion,
    evaluatedAt: evaluatedAt.toISOString(),
    runs: dataset.cases.map(({ id, query }) => ({ caseId: id, runId: latestByQuery.get(query) })),
  }, null, 2)}\n`);
}
