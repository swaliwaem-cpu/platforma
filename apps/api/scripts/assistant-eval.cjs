#!/usr/bin/env node

'use strict';

const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { PrismaClient } = require('@prisma/client');

const {
  evaluateAssistantEvalArtifact,
  loadAssistantEvalDataset,
  scoreAssistantEval,
} = require('../dist/assistant/eval/assistant-eval.js');
const { loadAssistantEvalRunRecords } = require('./assistant-eval-runtime.cjs');

void run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'ASSISTANT_EVAL_FAILED'}\n`);
  process.exitCode = 1;
});

async function run() {
  const resultsPath = readArgument('--results') ?? process.env.ASSISTANT_EVAL_RESULTS_PATH;
  if (!resultsPath) throw new Error('ASSISTANT_EVAL_RESULTS_PATH_REQUIRED');
  const dataset = loadAssistantEvalDataset(JSON.parse(readFileSync(
    resolve(__dirname, '../tests/fixtures/assistant/assistant-eval-v1.json'),
    'utf8',
  )));
  const artifact = JSON.parse(readFileSync(resolve(resultsPath), 'utf8'));
  const prisma = new PrismaClient();
  let records;
  try {
    records = await loadAssistantEvalRunRecords(prisma, dataset, artifact);
  } finally {
    await prisma.$disconnect();
  }
  const summary = scoreAssistantEval(dataset, evaluateAssistantEvalArtifact(dataset, artifact, records));

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.passed) process.exitCode = 2;
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
