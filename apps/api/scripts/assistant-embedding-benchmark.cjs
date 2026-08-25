const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const {
  AssistantEmbeddingGateway,
} = require('../dist/assistant/sources/assistant-embedding.gateway.js');

if (process.env.ASSISTANT_EMBEDDING_BENCHMARK_ENABLED !== 'true') {
  throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_ENABLED_REQUIRED');
}
if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY_REQUIRED');

const datasetPath = resolve(__dirname, '../tests/fixtures/assistant/embedding-benchmark-v1.json');
const datasetBytes = readFileSync(datasetPath);
const dataset = JSON.parse(datasetBytes.toString('utf8'));
const candidates = parseCandidates(process.env.ASSISTANT_EMBEDDING_BENCHMARK_CANDIDATES);

void run().catch((error) => {
  console.error(JSON.stringify({
    benchmark: 'assistant-embedding-retrieval-v1',
    errorCode: error instanceof Error ? error.message : 'BENCHMARK_FAILED',
  }));
  process.exitCode = 1;
});

async function run() {
  const results = [];
  const documentTexts = dataset.documents.map(({ text }) => text);
  const queryTexts = dataset.cases.map(({ query }) => query);

  for (const candidate of candidates) {
    const gateway = new AssistantEmbeddingGateway({
      ASSISTANT_EMBEDDING_MODE: 'openai',
      ASSISTANT_EMBEDDING_MODEL: candidate.model,
      ASSISTANT_EMBEDDING_DIMENSIONS: String(candidate.dimensions),
      ASSISTANT_EMBEDDING_TIMEOUT_MS: process.env.ASSISTANT_EMBEDDING_TIMEOUT_MS ?? '120000',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    });
    const startedAt = Date.now();
    const documents = await gateway.embed(documentTexts);
    const queries = await gateway.embed(queryTexts);
    const rankings = queries.vectors.map((queryVector) => dataset.documents
      .map((document, index) => ({ id: document.id, score: cosine(queryVector, documents.vectors[index]) }))
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)));
    const reciprocalRanks = rankings.map((ranking, index) => {
      const relevant = new Set(dataset.cases[index].relevantDocumentIds);
      const rank = ranking.findIndex(({ id }) => relevant.has(id));
      return rank === -1 ? 0 : 1 / (rank + 1);
    });
    const recallAt3 = rankings.filter((ranking, index) => {
      const relevant = new Set(dataset.cases[index].relevantDocumentIds);
      return ranking.slice(0, 3).some(({ id }) => relevant.has(id));
    }).length / rankings.length;
    results.push({
      model: candidate.model,
      dimensions: candidate.dimensions,
      meanReciprocalRank: round(mean(reciprocalRanks)),
      recallAt3: round(recallAt3),
      durationMs: Date.now() - startedAt,
    });
  }

  results.sort((left, right) =>
    right.meanReciprocalRank - left.meanReciprocalRank
    || right.recallAt3 - left.recallAt3
    || left.durationMs - right.durationMs
    || left.model.localeCompare(right.model));
  console.log(JSON.stringify({
    benchmark: 'assistant-embedding-retrieval-v1',
    datasetSha256: createHash('sha256').update(datasetBytes).digest('hex'),
    cases: dataset.cases.length,
    documents: dataset.documents.length,
    winner: results[0] ?? null,
    results,
  }, null, 2));
}

function parseCandidates(value) {
  if (!value) throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_CANDIDATES_REQUIRED');
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_CANDIDATES_INVALID');
  }
  if (!Array.isArray(parsed) || parsed.length < 2 || parsed.length > 5) {
    throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_CANDIDATES_INVALID');
  }
  return parsed.map((candidate) => {
    if (!candidate || typeof candidate !== 'object'
      || typeof candidate.model !== 'string' || !candidate.model.trim()
      || !Number.isInteger(candidate.dimensions) || candidate.dimensions < 1 || candidate.dimensions > 4096) {
      throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_CANDIDATES_INVALID');
    }
    return { model: candidate.model.trim(), dimensions: candidate.dimensions };
  });
}

function cosine(left, right) {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value) {
  return Number(value.toFixed(6));
}
