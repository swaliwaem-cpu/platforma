import { matchesSearchVariants, normalizeSearchText } from '@platforma/shared/search-normalization';

export type QuickEditCompletionValue = {
  completionQuarter: string | null;
  completionYear: string | null;
};

const quickEditCompletionPattern = /^([1-4])\s*кв\.?\s*(\d{4})$/iu;
const quickEditCompletionYearPattern = /^(\d{4})$/u;
const apartmentAreaUnitPattern = /\s*(?:м²|м2|м\^2|кв\.?\s*м\.?)\s*$/iu;

export function normalizeQuickEditSearchTerm(value: string) {
  return normalizeSearchText(value);
}

export function matchesQuickEditSearch(query: string, values: Array<string | null | undefined>) {
  return matchesSearchVariants(query, values);
}

export function parseQuickEditCompletion(value: string): QuickEditCompletionValue {
  const normalizedValue = value.trim().replace(/\s+/g, ' ');

  if (!normalizedValue) {
    return {
      completionQuarter: null,
      completionYear: null,
    };
  }

  const completionMatch = normalizedValue.match(quickEditCompletionPattern);

  if (completionMatch) {
    return {
      completionQuarter: completionMatch[1] ?? null,
      completionYear: completionMatch[2] ?? null,
    };
  }

  const yearMatch = normalizedValue.match(quickEditCompletionYearPattern);

  return {
    completionQuarter: null,
    completionYear: yearMatch?.[1] ?? normalizedValue,
  };
}

export function normalizeApartmentAreaRange(value: string) {
  const normalizedValue = value.trim().replace(/\s+/g, ' ');

  if (!normalizedValue) {
    return '';
  }

  const valueWithoutUnit = normalizedValue.replace(apartmentAreaUnitPattern, '').trim();

  return valueWithoutUnit ? `${valueWithoutUnit} м²` : normalizedValue;
}
