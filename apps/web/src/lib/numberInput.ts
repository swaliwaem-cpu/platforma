export function formatGroupedNumberInputValue(value: string) {
  const normalizedValue = value.trim().replace(/\s/g, '');

  if (!normalizedValue) {
    return '';
  }

  const [rawIntegerPart = '', ...rawFractionParts] = normalizedValue.split('.');
  const integerPart = rawIntegerPart.replace(/\D/g, '');
  const fractionPart = rawFractionParts.join('').replace(/\D/g, '');
  const groupedIntegerPart = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

  if (!rawFractionParts.length) {
    return groupedIntegerPart;
  }

  return `${groupedIntegerPart}.${fractionPart}`;
}

export function formatCurrencyInputValue(value: string) {
  const groupedValue = formatGroupedNumberInputValue(value);

  return groupedValue ? `${groupedValue} ₽` : '';
}

export function getCurrencyInputBackspaceValue(
  value: string,
  selectionStart: number | null,
  selectionEnd: number | null,
) {
  if (selectionStart === null || selectionEnd === null || selectionStart !== selectionEnd) {
    return null;
  }

  const currencyIndex = value.indexOf('₽');

  if (currencyIndex === -1 || selectionStart <= currencyIndex) {
    return null;
  }

  const rawValue = value.slice(0, currencyIndex).replace(/[^\d,.]/g, '').replace(',', '.');

  return rawValue.slice(0, -1);
}
