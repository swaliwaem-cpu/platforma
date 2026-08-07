export const DEFAULT_TRAINING_QUESTION_CONTEXT_MAX_CHARS = 30_000;
export const MIN_TRAINING_QUESTION_CONTEXT_MAX_CHARS = 5_000;
export const ABSOLUTE_TRAINING_QUESTION_CONTEXT_MAX_CHARS = 120_000;
export const TRAINING_QUESTION_CONTEXT_BUDGET_POLICY_VERSION =
  'training-question-context-budget-v1';

export type TrainingQuestionEvidenceCharacteristics = Readonly<{
  uniqueChars: number;
  uniqueFragments: number;
  uniqueSources: number;
}>;

export type TrainingQuestionContextBudgetConfig = Readonly<{
  maximumChars: number;
  hardCeilingChars?: number;
}>;

export type TrainingQuestionContextBudget = Readonly<{
  chosenBudget: number;
  policyVersion: string;
}>;

export function chooseTrainingQuestionContextBudget(
  evidence: TrainingQuestionEvidenceCharacteristics,
  config: TrainingQuestionContextBudgetConfig,
): TrainingQuestionContextBudget {
  const hardCeiling = config.hardCeilingChars ??
    ABSOLUTE_TRAINING_QUESTION_CONTEXT_MAX_CHARS;

  if (
    !isNonNegativeInteger(evidence.uniqueChars) ||
    !isNonNegativeInteger(evidence.uniqueFragments) ||
    !isNonNegativeInteger(evidence.uniqueSources) ||
    evidence.uniqueChars < evidence.uniqueFragments ||
    (evidence.uniqueChars > 0 && evidence.uniqueFragments === 0) ||
    (evidence.uniqueFragments > 0 && evidence.uniqueSources === 0)
  ) {
    throw new RangeError('TRAINING_QUESTION_EVIDENCE_CHARACTERISTICS_INVALID');
  }
  if (
    !Number.isInteger(hardCeiling) ||
    hardCeiling < MIN_TRAINING_QUESTION_CONTEXT_MAX_CHARS ||
    hardCeiling > ABSOLUTE_TRAINING_QUESTION_CONTEXT_MAX_CHARS ||
    !Number.isInteger(config.maximumChars) ||
    config.maximumChars < MIN_TRAINING_QUESTION_CONTEXT_MAX_CHARS ||
    config.maximumChars > hardCeiling
  ) {
    throw new RangeError('TRAINING_QUESTION_CONTEXT_MAX_CHARS_INVALID');
  }

  return Object.freeze({
    chosenBudget: Math.min(evidence.uniqueChars, config.maximumChars, hardCeiling),
    policyVersion: TRAINING_QUESTION_CONTEXT_BUDGET_POLICY_VERSION,
  });
}

function isNonNegativeInteger(value: number) {
  return Number.isInteger(value) && value >= 0;
}
