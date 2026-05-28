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
