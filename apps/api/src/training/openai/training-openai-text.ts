import type {
  TrainingEvaluationFactInput,
} from '../training-attempt.providers';

export const TRAINING_UNSUPPORTED_APPROVED_TEXT_MIN_LENGTH = 16;

export function normalizeTrainingOpenAiText(value: string) {
  return value
    .normalize('NFC')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\p{Z}\s]+/gu, ' ')
    .trim();
}

function normalizeUnsupportedApprovedComparisonText(value: string) {
  return normalizeTrainingOpenAiText(value).toLocaleLowerCase('ru-RU');
}

export function assertUnsupportedClaimDoesNotMatchApprovedFacts(
  finding: { claim?: string },
  facts: readonly TrainingEvaluationFactInput[],
) {
  const claim = normalizeUnsupportedApprovedComparisonText(
    finding.claim ?? '',
  );
  if (!claim) return;

  for (const fact of facts) {
    for (const approvedText of [
      fact.statement,
      ...(fact.acceptedAliases ?? []),
    ]) {
      const normalizedApprovedText =
        normalizeUnsupportedApprovedComparisonText(approvedText);
      if (!normalizedApprovedText) continue;

      if (claim === normalizedApprovedText) {
        throw new Error(
          'Unsupported claim duplicates an approved fact or alias',
        );
      }

      if (
        Math.min(
          Array.from(claim).length,
          Array.from(normalizedApprovedText).length,
        ) >= TRAINING_UNSUPPORTED_APPROVED_TEXT_MIN_LENGTH &&
        (claim.includes(normalizedApprovedText) ||
          normalizedApprovedText.includes(claim))
      ) {
        throw new Error(
          'Unsupported claim contains an approved fact or alias',
        );
      }
    }
  }
}
