export type QuickEditCompletionValue = {
  completionQuarter: string | null;
  completionYear: string | null;
};

const quickEditCompletionPattern = /^([1-4])\s*кв\.?\s*(\d{4})$/iu;
const quickEditCompletionYearPattern = /^(\d{4})$/u;
const apartmentAreaUnitPattern = /\s*(?:м²|м2|м\^2|кв\.?\s*м\.?)\s*$/iu;

export function normalizeQuickEditSearchTerm(value: string) {
  return value.replace(/\./g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function matchesQuickEditSearch(query: string, values: Array<string | null | undefined>) {
  const normalizedQuery = normalizeQuickEditSearchTerm(query);

  if (!normalizedQuery) {
    return true;
  }

  return values.some((value) => normalizeQuickEditSearchTerm(value ?? '').includes(normalizedQuery));
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
