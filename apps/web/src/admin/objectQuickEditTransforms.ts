import { matchesSearchVariants, normalizeSearchText } from '@platforma/shared/search-normalization';

export type QuickEditCompletionValue = {
  completionQuarter: string | null;
  completionYear: string | null;
};

const quickEditCompletionPattern = /^([1-4])\s*кв\.?\s*(\d{4})$/iu;
const quickEditCompletionYearPattern = /^(\d{4})$/u;
const apartmentAreaUnitPattern = /\s*(?:м²|м2|м\^2|кв\.?\s*м\.?)\s*$/iu;
const priceFromPrefixPattern = /^от(?:\.|\s|$)\s*/iu;
const priceCurrencyPattern = /\s*(?:₽|руб(?:\.|лей|ля|ль)?|р\.)\s*/giu;
const pricePerMeterUnitPattern = /\s*\/?\s*(?:м²|м2|м\^2|кв\.?\s*м\.?)\s*/giu;
const ceilingHeightPrefixPattern = /^от(?:\.|\s|$)\s*/iu;
const ceilingHeightUnitPattern = /\s*(?:м|метр(?:а|ов)?\.?)\s*$/iu;

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

export function normalizeObjectPriceValue(value: string) {
  const normalizedValue = value.trim().replace(/\s+/g, ' ');

  if (!normalizedValue || normalizedValue.toLowerCase() === 'по запросу') {
    return '';
  }

  return normalizedValue
    .replace(priceFromPrefixPattern, '')
    .replace(priceCurrencyPattern, '')
    .replace(pricePerMeterUnitPattern, '')
    .replace(/\s+/g, '')
    .replace(',', '.');
}

export function normalizeCeilingHeight(value: string) {
  const normalizedValue = value.trim().replace(/\s+/g, ' ');

  if (!normalizedValue) {
    return '';
  }

  if (!/^(?:от(?:\.|\s|$)|\d)/iu.test(normalizedValue)) {
    return normalizedValue;
  }

  const valueWithoutPrefix = normalizedValue.replace(ceilingHeightPrefixPattern, '').trim();
  const valueWithoutUnit = valueWithoutPrefix
    .replace(ceilingHeightUnitPattern, '')
    .trim()
    .replace(/(\d)\.(\d)/g, '$1,$2');

  return valueWithoutUnit ? `от ${valueWithoutUnit} м` : normalizedValue;
}
