'use strict';

const { readAssistantEvalArtifactRunIds } = require('../dist/assistant/eval/assistant-eval.js');

async function loadAssistantEvalRunRecords(prisma, dataset, artifact, now = new Date()) {
  const runIds = readAssistantEvalArtifactRunIds(dataset, artifact, now);
  return loadAssistantEvalRunRecordsByIds(prisma, runIds, now);
}

async function loadAssistantEvalRunRecordsByIds(prisma, runIds, now = new Date()) {
  const runs = await prisma.assistantRun.findMany({
    where: { id: { in: runIds } },
    select: {
      id: true,
      ownerUserId: true,
      status: true,
      createdAt: true,
      completedAt: true,
      intentJson: true,
      evidenceJson: true,
      telemetryJson: true,
      auditJson: true,
      qualityFlags: true,
      latencyMs: true,
      conversation: { select: { ownerUserId: true } },
      userMessage: { select: { content: true, contextJson: true, geoContextJson: true } },
      assistantMessage: { select: { content: true, answerJson: true } },
      owner: {
        select: {
          role: {
            select: {
              permissions: { select: { permission: { select: { key: true } } } },
            },
          },
        },
      },
    },
  });
  const ownerUserIds = [...new Set(runs.map(({ ownerUserId }) => ownerUserId))];
  const earliest = runs.reduce((value, run) => Math.min(value, run.createdAt.getTime()), now.getTime());
  const geoOperations = ownerUserIds.length === 0 ? [] : await prisma.assistantGeoOperation.findMany({
    where: {
      actorUserId: { in: ownerUserIds },
      createdAt: {
        gte: new Date(earliest - 30_000),
        lte: now,
      },
    },
    select: { actorUserId: true, providerCallCount: true, createdAt: true },
  });

  return runs.map((run) => ({
    id: run.id,
    ownerUserId: run.ownerUserId,
    conversationOwnerUserId: run.conversation.ownerUserId,
    ownerPermissions: run.owner.role.permissions.map(({ permission }) => permission.key),
    status: run.status,
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    query: run.userMessage.content,
    context: run.userMessage.contextJson,
    geoContext: run.userMessage.geoContextJson,
    answer: mergeAssistantMessage(run.assistantMessage),
    evidence: run.evidenceJson,
    intent: run.intentJson,
    audit: run.auditJson,
    qualityFlags: run.qualityFlags,
    latencyMs: run.latencyMs,
    telemetry: run.telemetryJson,
    geoProviderCalls: geoOperations.filter((operation) => (
      operation.actorUserId === run.ownerUserId
      && operation.createdAt.getTime() >= run.createdAt.getTime() - 30_000
      && operation.createdAt.getTime() <= (run.completedAt?.getTime() ?? now.getTime())
    )).reduce((total, operation) => total + operation.providerCallCount, 0),
  }));
}

function mergeAssistantMessage(message) {
  if (!message || !isRecord(message.answerJson)) return null;
  return { ...message.answerJson, content: message.content };
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

module.exports = { loadAssistantEvalRunRecords, loadAssistantEvalRunRecordsByIds };
