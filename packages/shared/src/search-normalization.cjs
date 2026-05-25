const englishToRussianLayoutMap = {
  '`': 'е',
  q: 'й',
  w: 'ц',
  e: 'у',
  r: 'к',
  t: 'е',
  y: 'н',
  u: 'г',
  i: 'ш',
  o: 'щ',
  p: 'з',
  '[': 'х',
  ']': 'ъ',
  a: 'ф',
  s: 'ы',
  d: 'в',
  f: 'а',
  g: 'п',
  h: 'р',
  j: 'о',
  k: 'л',
  l: 'д',
  ';': 'ж',
  "'": 'э',
  z: 'я',
  x: 'ч',
  c: 'с',
  v: 'м',
  b: 'и',
  n: 'т',
  m: 'ь',
  ',': 'б',
  '.': 'ю',
};

const russianToEnglishLayoutMap = Object.fromEntries(
  Object.entries(englishToRussianLayoutMap).map(([english, russian]) => [russian, english]),
);

const latinToRussianSingles = {
  a: 'а',
  b: 'б',
  c: 'к',
  d: 'д',
  e: 'е',
  f: 'ф',
  g: 'г',
  h: 'х',
  i: 'и',
  j: 'дж',
  k: 'к',
  l: 'л',
  m: 'м',
  n: 'н',
  o: 'о',
  p: 'п',
  q: 'к',
  r: 'р',
  s: 'с',
  t: 'т',
  u: 'у',
  v: 'в',
  w: 'в',
  x: 'кс',
  y: 'й',
  z: 'з',
};

const latinToRussianPairs = [
  ['shch', 'щ'],
  ['sch', 'щ'],
  ['yo', 'е'],
  ['yu', 'ю'],
  ['ya', 'я'],
  ['ye', 'е'],
  ['zh', 'ж'],
  ['kh', 'х'],
  ['ts', 'ц'],
  ['ch', 'ч'],
  ['sh', 'ш'],
];

const russianToLatinMap = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

function normalizeSearchText(value) {
  return value
    .replace(/ё/gi, 'е')
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function createSearchVariants(value) {
  const normalized = normalizeSearchText(value);

  if (!normalized) {
    return [];
  }

  const variants = new Set();
  const baseCandidates = [
    normalized,
    convertKeyboardLayout(normalized, englishToRussianLayoutMap),
    convertKeyboardLayout(normalized, russianToEnglishLayoutMap),
  ];

  for (const candidate of baseCandidates) {
    addVariant(variants, candidate);
    addVariant(variants, transliterateLatinToRussian(candidate));
    addVariant(variants, transliterateRussianToLatin(candidate));
  }

  return [...variants];
}

function matchesSearchVariants(query, values) {
  const variants = createSearchVariants(query);

  if (variants.length === 0) {
    return true;
  }

  return values.some((value) => {
    const normalizedValue = normalizeSearchText(value ?? '');

    return normalizedValue && variants.some((variant) => normalizedValue.includes(variant));
  });
}

function addVariant(variants, value) {
  const normalized = normalizeSearchText(value);

  if (normalized) {
    variants.add(normalized);
  }
}

function convertKeyboardLayout(value, map) {
  return [...value].map((char) => map[char] ?? char).join('');
}

function transliterateLatinToRussian(value) {
  let result = '';
  let index = 0;

  while (index < value.length) {
    const pair = latinToRussianPairs.find(([latin]) => value.startsWith(latin, index));

    if (pair) {
      result += pair[1];
      index += pair[0].length;
      continue;
    }

    const char = value[index];
    result += latinToRussianSingles[char] ?? char;
    index += 1;
  }

  return result;
}

function transliterateRussianToLatin(value) {
  return [...value].map((char) => russianToLatinMap[char] ?? char).join('');
}

module.exports = {
  createSearchVariants,
  matchesSearchVariants,
  normalizeSearchText,
};
