#!/usr/bin/env node

'use strict';

const { readFileSync } = require('node:fs');
const { writeFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { PrismaClient } = require('@prisma/client');

const {
  evaluateAssistantEvalArtifact,
  loadAssistantEvalDataset,
  scoreAssistantEval,
} = require('../dist/assistant/eval/assistant-eval.js');
const {
  createAssistantEvalEvidenceBundle,
  loadAssistantEvalDatabaseFingerprint,
  loadAssistantEvalProviderReceipts,
  loadAssistantEvalRunRecords,
} = require('./assistant-eval-runtime.cjs');

async function runAssistantEval(input = {}) {
  const environment = input.environment ?? process.env;
  const options = input.options ?? parseArguments(input.argv ?? process.argv.slice(2), environment);
  if (options.mode !== 'EVALUATE') throw new Error('ASSISTANT_EVAL_ARGUMENT_INVALID');
  const resultsPath = options.resultsPath;
  if (!resultsPath) throw new Error('ASSISTANT_EVAL_RESULTS_PATH_REQUIRED');
  const dataset = loadAssistantEvalDataset(JSON.parse(readFileSync(
    resolve(__dirname, '../tests/fixtures/assistant/assistant-eval-v1.json'),
    'utf8',
  )));
  const artifact = readJsonFile(resultsPath, 'ASSISTANT_EVAL_ARTIFACT_INVALID');
  const now = input.now ?? new Date();
  const prisma = input.prisma ?? new PrismaClient();
  let records;
  let providerReceiptsByRun = null;
  let databaseFingerprint = null;
  try {
    records = await loadAssistantEvalRunRecords(prisma, dataset, artifact, now);
    if (options.evidencePath) {
      [providerReceiptsByRun, databaseFingerprint] = await Promise.all([
        loadAssistantEvalProviderReceipts(prisma, records, now),
        loadAssistantEvalDatabaseFingerprint(prisma),
      ]);
    }
  } finally {
    if (!input.prisma) await prisma.$disconnect();
  }
  const evaluation = evaluateAssistantEvalArtifact(dataset, artifact, records, now);
  const summary = scoreAssistantEval(dataset, evaluation);
  let evidenceBundle = null;
  if (options.evidencePath) {
    const runnerReport = readJsonFile(
      options.runnerReportPath,
      'ASSISTANT_EVAL_RUNNER_REPORT_INVALID',
    );
    evidenceBundle = createAssistantEvalEvidenceBundle({
      dataset,
      artifact,
      evaluation,
      summary,
      records,
      providerReceiptsByRun,
      runnerReport,
      databaseFingerprint,
      generatedAt: now,
    });
    await writeJsonExclusive(options.evidencePath, evidenceBundle);
  }
  return { summary, evidenceBundle };
}

async function main() {
  const options = parseArguments(process.argv.slice(2), process.env);
  const { summary } = await runAssistantEval({ options });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.passed) process.exitCode = 2;
}

function parseArguments(argv, environment) {
  const valueArguments = new Set([
    '--results',
    '--evidence',
    '--runner-report',
  ]);
  for (let index = 0; index < argv.length;) {
    const argument = argv[index];
    if (!valueArguments.has(argument) || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error('ASSISTANT_EVAL_ARGUMENT_INVALID');
    }
    index += 2;
  }
  const resultsValue = readArgument(argv, '--results') ?? environment.ASSISTANT_EVAL_RESULTS_PATH;
  const evidenceValue = readArgument(argv, '--evidence');
  const runnerReportValue = readArgument(argv, '--runner-report');
  if (Boolean(evidenceValue) !== Boolean(runnerReportValue)) {
    throw new Error('ASSISTANT_EVAL_EVIDENCE_ARGUMENTS_REQUIRED');
  }
  const resultsPath = resultsValue ? resolve(resultsValue) : null;
  const evidencePath = evidenceValue ? resolve(evidenceValue) : null;
  const runnerReportPath = runnerReportValue ? resolve(runnerReportValue) : null;
  if (evidencePath && new Set([resultsPath, evidencePath, runnerReportPath]).size !== 3) {
    throw new Error('ASSISTANT_EVAL_OUTPUT_PATHS_COLLIDE');
  }
  return { mode: 'EVALUATE', resultsPath, evidencePath, runnerReportPath };
}

function readArgument(argv, name) {
  const indexes = argv.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length === 0) return undefined;
  if (indexes.length !== 1) throw new Error('ASSISTANT_EVAL_ARGUMENT_DUPLICATED');
  return argv[indexes[0] + 1];
}

function readJsonFile(path, code) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(code);
  }
}

async function writeJsonExclusive(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

function readSafeCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,119}$/u.test(value)
    ? value
    : 'ASSISTANT_EVAL_FAILED';
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`${readSafeCode(error?.message)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArguments, runAssistantEval };
