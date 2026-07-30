import { createHash } from 'node:crypto';

import { normalizeTrainingOpenAiText } from './training-openai-text';

export const TRAINING_OPENAI_VOCABULARY_VERSION = 'safe-vocabulary-v2';
export const TRAINING_OPENAI_VOCABULARY_MAX_TERMS = 64;
export const TRAINING_OPENAI_VOCABULARY_MAX_TERM_LENGTH = 80;
export const TRAINING_OPENAI_VOCABULARY_MAX_ALIAS_WORDS = 6;
export const TRAINING_OPENAI_VOCABULARY_PROMPT_MAX_CHARACTERS = 2_000;
export const TRAINING_OPENAI_VOCABULARY_PROMPT_PREFIX =
  'Утвержденные термины и названия: ';

type TrainingVocabularyContext = {
  projectVersionNumber: number;
  projectTitle: string;
  object?: {
    title?: string | null;
    mapName?: string | null;
    krtName?: string | null;
    developerName?: string | null;
    primaryLocationName?: string | null;
    locationNames?: Array<string | null>;
    metroStations?: Array<{
      name?: string | null;
      lineName?: string | null;
    }>;
  } | null;
  approvedFacts: Array<{
    statement: string;
    acceptedAliases: string[];
  }>;
};

export function buildSafeTrainingVocabulary(
  context: TrainingVocabularyContext,
) {
  const forbiddenStatements = new Set(
    context.approvedFacts
      .map((fact) => normalizeTrainingOpenAiText(fact.statement))
      .filter(Boolean),
  );
  const structuredTerms = [
    context.projectTitle,
    context.object?.title,
    context.object?.mapName,
    context.object?.krtName,
    context.object?.developerName,
    context.object?.primaryLocationName,
    ...(context.object?.locationNames ?? []),
    ...(context.object?.metroStations ?? []).flatMap((station) => [
      station.name,
      station.lineName,
    ]),
  ];
  const aliasTerms = context.approvedFacts.flatMap(
    (fact) => fact.acceptedAliases,
  );
  const accepted = new Map<string, string>();

  for (const value of structuredTerms) {
    addVocabularyTerm(accepted, value, forbiddenStatements, false);
  }
  for (const value of aliasTerms) {
    addVocabularyTerm(accepted, value, forbiddenStatements, true);
  }

  const terms = fitTrainingVocabularyPromptTerms(
    [...accepted.values()]
      .sort(compareVocabularyTerms)
      .slice(0, TRAINING_OPENAI_VOCABULARY_MAX_TERMS),
  );
  const version = `${TRAINING_OPENAI_VOCABULARY_VERSION}:project-version-${context.projectVersionNumber}`;
  const hash = createHash('sha256')
    .update(JSON.stringify({ version, terms }))
    .digest('hex');

  return { version, terms, hash };
}

export function buildTrainingVocabularyPrompt(values: readonly string[]) {
  const accepted = new Map<string, string>();
  for (const value of values) {
    if (typeof value !== 'string' || /[\r\n]/u.test(value)) continue;
    const normalized = normalizeTrainingOpenAiText(value);
    if (
      !normalized ||
      Array.from(normalized).length >
        TRAINING_OPENAI_VOCABULARY_MAX_TERM_LENGTH ||
      isSentenceLike(normalized)
    ) {
      continue;
    }
    const key = normalized.toLocaleLowerCase('ru-RU');
    if (!accepted.has(key)) accepted.set(key, normalized);
  }

  const terms = fitTrainingVocabularyPromptTerms(
    [...accepted.values()].slice(0, TRAINING_OPENAI_VOCABULARY_MAX_TERMS),
  );
  return terms.length > 0
    ? `${TRAINING_OPENAI_VOCABULARY_PROMPT_PREFIX}${terms.join(', ')}`
    : '';
}

function fitTrainingVocabularyPromptTerms(values: readonly string[]) {
  const terms: string[] = [];
  for (const value of values) {
    const candidate = `${TRAINING_OPENAI_VOCABULARY_PROMPT_PREFIX}${[
      ...terms,
      value,
    ].join(', ')}`;
    if (
      Array.from(candidate).length >
      TRAINING_OPENAI_VOCABULARY_PROMPT_MAX_CHARACTERS
    ) {
      continue;
    }
    terms.push(value);
  }
  return terms;
}

function addVocabularyTerm(
  accepted: Map<string, string>,
  value: string | null | undefined,
  forbiddenStatements: Set<string>,
  alias: boolean,
) {
  if (typeof value !== 'string' || /[\r\n]/u.test(value)) return;
  const normalized = normalizeTrainingOpenAiText(value);
  if (
    !normalized ||
    Array.from(normalized).length > TRAINING_OPENAI_VOCABULARY_MAX_TERM_LENGTH ||
    [...forbiddenStatements].some(
      (statement) =>
        normalized === statement || normalized.includes(statement),
    ) ||
    isSentenceLike(normalized) ||
    (alias &&
      normalized.split(' ').length >
        TRAINING_OPENAI_VOCABULARY_MAX_ALIAS_WORDS)
  ) {
    return;
  }
  const key = normalized.toLocaleLowerCase('ru-RU');
  if (!accepted.has(key)) accepted.set(key, normalized);
}

function isSentenceLike(value: string) {
  return /[.!?](?:\s|$)/u.test(value);
}

function compareVocabularyTerms(left: string, right: string) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
