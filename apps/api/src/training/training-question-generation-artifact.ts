import { createHash } from 'node:crypto';

import {
  readQuestionGenerationMaxOutputTokens,
  readQuestionGenerationReasoning,
  TRAINING_QUESTION_COMPILER_VERSION,
  TRAINING_QUESTION_EVIDENCE_DEDUP_ALGORITHM,
  TRAINING_QUESTION_LOCATOR_CONTRACT,
  TRAINING_QUESTION_PROMPT_VERSION,
  TRAINING_QUESTION_SELECTION_ALGORITHM,
  type TrainingGeneratedQuestionDraft,
  type TrainingPreparedQuestionSource,
  type TrainingQuestionDraftGenerationInput,
  type TrainingQuestionDraftGenerationResult,
} from './training-material-suggester';
import { normalizeTrainingMaterialText } from './training-material-extraction';
import { getTrainingAiMode, TrainingOpenAIError } from './training-openai-client';
import { readQuestionGenerationRoutingConfig } from './training-question-generation-router';

export const TRAINING_QUESTION_GENERATION_ARTIFACT_SCHEMA_VERSION = 1;
export const TRAINING_QUESTION_GENERATION_KEY_VERSION =
  'training-question-generation-key-v1';

type PortableQuestionDraft = {
  text: string;
  facts: Array<{
    statement: string;
    aliases: string[];
    isRequired: boolean;
    evidenceHash: string;
  }>;
};

export type TrainingQuestionGenerationArtifactPayload = {
  schemaVersion: typeof TRAINING_QUESTION_GENERATION_ARTIFACT_SCHEMA_VERSION;
  main: PortableQuestionDraft;
  followUps: PortableQuestionDraft[];
};

export type TrainingQuestionGenerationPlan = {
  realEstateObjectId: string;
  generationKeyHash: string;
  generationKey: Record<string, unknown>;
  sourceFingerprint: string;
  artifactSchemaVersion: number;
  compilerVersion: string;
  promptVersion: string;
  generationModel: string;
  generationReasoning: string;
  routingStrategy: string;
  validatorVersion: string;
  chosenBudget: number;
  budgetPolicyVersion: string;
  maxOutputTokens: number;
};

export function createTrainingQuestionGenerationPlan(
  input: TrainingQuestionDraftGenerationInput,
  prepared: TrainingPreparedQuestionSource,
  realEstateObjectId: string | null,
): TrainingQuestionGenerationPlan | null {
  if (!realEstateObjectId || !input.sources.length) return null;
  if (!input.sources.every((source) =>
    source.reuseMetadata?.realEstateObjectId === realEstateObjectId &&
    (
      source.reuseMetadata.kind === 'PLATFORMA_OBJECT_SNAPSHOT' ||
      source.reuseMetadata.kind === 'PLATFORMA_OBJECT_PDF'
    )
  )) {
    return null;
  }

  const contentHashes = [...new Set(
    prepared.sourceManifest.map((source) => source.contentHash),
  )].sort();
  const selectedEvidenceHashes = prepared.segments.map((segment) => {
    const reference = prepared.references.get(segment.locator);
    if (!reference) {
      throw new TrainingOpenAIError('QUESTION_GENERATION_ARTIFACT_INVALID', false);
    }
    return reference.evidenceHash;
  });
  const sourceFingerprint = digest({ contentHashes });
  const providerMode = getTrainingAiMode();
  const routing = readQuestionGenerationRoutingConfig();
  const generationModel = routing.primaryModel;
  const generationReasoning = readQuestionGenerationReasoning();
  const routingStrategy = `${routing.routingVersion}:${providerMode}:${routing.strategy}`;
  const maxOutputTokens = readQuestionGenerationMaxOutputTokens();
  const generationKey = {
    keyVersion: TRAINING_QUESTION_GENERATION_KEY_VERSION,
    artifactSchemaVersion: TRAINING_QUESTION_GENERATION_ARTIFACT_SCHEMA_VERSION,
    scopeKind: 'PLATFORMA_OBJECT',
    realEstateObjectId,
    sourceFingerprint,
    contentHashes,
    selectedEvidenceHashes,
    objectTitleHash: digest(normalizeTrainingMaterialText(input.objectTitle)),
    providerMode,
    routingStrategy,
    strategy: routing.strategy,
    routingVersion: routing.routingVersion,
    validatorVersion: routing.validatorVersion,
    primaryModel: routing.primaryModel,
    fallbackModel: routing.fallbackModel,
    generationModel,
    generationReasoning,
    compilerVersion: TRAINING_QUESTION_COMPILER_VERSION,
    promptVersion: TRAINING_QUESTION_PROMPT_VERSION,
    chosenBudget: prepared.evidenceMetrics.chosenBudget,
    budgetPolicyVersion: prepared.evidenceMetrics.policyVersion,
    selectionAlgorithm: TRAINING_QUESTION_SELECTION_ALGORITHM,
    evidenceDedupAlgorithm: TRAINING_QUESTION_EVIDENCE_DEDUP_ALGORITHM,
    locatorContract: TRAINING_QUESTION_LOCATOR_CONTRACT,
    maxOutputTokens,
  };

  return {
    realEstateObjectId,
    generationKeyHash: hashTrainingQuestionGenerationKey(generationKey),
    generationKey,
    sourceFingerprint,
    artifactSchemaVersion: TRAINING_QUESTION_GENERATION_ARTIFACT_SCHEMA_VERSION,
    compilerVersion: TRAINING_QUESTION_COMPILER_VERSION,
    promptVersion: TRAINING_QUESTION_PROMPT_VERSION,
    generationModel,
    generationReasoning,
    routingStrategy,
    validatorVersion: routing.validatorVersion,
    chosenBudget: prepared.evidenceMetrics.chosenBudget,
    budgetPolicyVersion: prepared.evidenceMetrics.policyVersion,
    maxOutputTokens,
  };
}

export function hashTrainingQuestionGenerationKey(value: Record<string, unknown>) {
  return digest(value);
}

export function createTrainingQuestionGenerationArtifactPayload(
  generated: Pick<TrainingQuestionDraftGenerationResult, 'main' | 'followUps'>,
  prepared: TrainingPreparedQuestionSource,
): TrainingQuestionGenerationArtifactPayload {
  return {
    schemaVersion: TRAINING_QUESTION_GENERATION_ARTIFACT_SCHEMA_VERSION,
    main: createPortableQuestion(generated.main, prepared),
    followUps: generated.followUps.map((question) =>
      createPortableQuestion(question, prepared),
    ),
  };
}

export function materializeTrainingQuestionGenerationArtifact(
  value: unknown,
  prepared: TrainingPreparedQuestionSource,
) {
  const artifact = parseTrainingQuestionGenerationArtifact(value);
  const referencesByEvidenceHash = new Map(
    [...prepared.references.entries()].map(([locator, reference]) => [
      reference.evidenceHash,
      { locator, excerpt: reference.sourceExcerpt },
    ]),
  );
  const materialize = (question: PortableQuestionDraft): TrainingGeneratedQuestionDraft => ({
    text: question.text,
    facts: question.facts.map((fact) => {
      const reference = referencesByEvidenceHash.get(fact.evidenceHash);
      if (!reference) {
        throw new TrainingOpenAIError('QUESTION_GENERATION_ARTIFACT_INVALID', false);
      }
      return {
        statement: fact.statement,
        aliases: fact.aliases,
        isRequired: fact.isRequired,
        sourceLocator: reference.locator,
        sourceExcerpt: reference.excerpt,
      };
    }),
  });

  return {
    main: materialize(artifact.main),
    followUps: artifact.followUps.map(materialize),
  };
}

export function parseTrainingQuestionGenerationArtifact(
  value: unknown,
): TrainingQuestionGenerationArtifactPayload {
  if (
    !isRecord(value) ||
    value.schemaVersion !== TRAINING_QUESTION_GENERATION_ARTIFACT_SCHEMA_VERSION ||
    !hasExactKeys(value, ['schemaVersion', 'main', 'followUps']) ||
    !Array.isArray(value.followUps)
  ) {
    throw new TrainingOpenAIError('QUESTION_GENERATION_ARTIFACT_INVALID', false);
  }
  return {
    schemaVersion: TRAINING_QUESTION_GENERATION_ARTIFACT_SCHEMA_VERSION,
    main: parsePortableQuestion(value.main),
    followUps: value.followUps.map(parsePortableQuestion),
  };
}

function createPortableQuestion(
  question: TrainingGeneratedQuestionDraft,
  prepared: TrainingPreparedQuestionSource,
): PortableQuestionDraft {
  return {
    text: question.text,
    facts: question.facts.map((fact) => {
      const reference = prepared.references.get(fact.sourceLocator);
      if (!reference) {
        throw new TrainingOpenAIError('QUESTION_GENERATION_ARTIFACT_INVALID', false);
      }
      return {
        statement: fact.statement,
        aliases: fact.aliases,
        isRequired: fact.isRequired,
        evidenceHash: reference.evidenceHash,
      };
    }),
  };
}

function parsePortableQuestion(value: unknown): PortableQuestionDraft {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['text', 'facts']) ||
    typeof value.text !== 'string' ||
    !Array.isArray(value.facts)
  ) {
    throw new TrainingOpenAIError('QUESTION_GENERATION_ARTIFACT_INVALID', false);
  }
  return {
    text: value.text,
    facts: value.facts.map((fact) => {
      if (
        !isRecord(fact) ||
        !hasExactKeys(fact, ['statement', 'aliases', 'isRequired', 'evidenceHash']) ||
        typeof fact.statement !== 'string' ||
        !Array.isArray(fact.aliases) ||
        fact.aliases.some((alias) => typeof alias !== 'string') ||
        typeof fact.isRequired !== 'boolean' ||
        typeof fact.evidenceHash !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(fact.evidenceHash)
      ) {
        throw new TrainingOpenAIError('QUESTION_GENERATION_ARTIFACT_INVALID', false);
      }
      return {
        statement: fact.statement,
        aliases: fact.aliases as string[],
        isRequired: fact.isRequired,
        evidenceHash: fact.evidenceHash,
      };
    }),
  };
}

function digest(value: unknown) {
  const input = typeof value === 'string' ? value : JSON.stringify(value);
  return createHash('sha256').update(input).digest('hex');
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
