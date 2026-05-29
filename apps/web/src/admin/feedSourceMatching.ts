import type {
  FeedSourceAnalysis,
  FeedSourceAnalysisObject,
  ObjectDeveloper,
  RealEstateObjectSummary,
} from '@platforma/shared';

const genericFeedNameTokens = new Set([
  'ао',
  'ooo',
  'ооо',
  'пао',
  'гк',
  'group',
  'группа',
  'компаний',
  'жк',
  'жилой',
  'комплекс',
  'квартал',
  'клубный',
  'дом',
  'residence',
  'residences',
]);

const canonicalTokenAliases = new Map([
  ['cityzen', 'ситидзен'],
  ['citizen', 'ситидзен'],
  ['sityzen', 'ситидзен'],
  ['sitidzen', 'ситидзен'],
  ['ситидзен', 'ситидзен'],
  ['one', 'оне'],
  ['оне', 'оне'],
  ['beep', 'веер'],
  ['веер', 'веер'],
  ['jois', 'jois'],
  ['джойс', 'jois'],
  ['джоис', 'jois'],
  ['mr', 'мр'],
  ['мр', 'мр'],
  ['group', 'групп'],
  ['групп', 'групп'],
]);

const canonicalCompactAliases = new Map([
  ['cityzen', 'ситидзен'],
  ['citizen', 'ситидзен'],
  ['sityzen', 'ситидзен'],
  ['sitidzen', 'ситидзен'],
  ['ситидзен', 'ситидзен'],
  ['cityzenmoscow', 'ситидзен'],
  ['citizenmoscow', 'ситидзен'],
  ['onec', 'оне'],
  ['one', 'оне'],
  ['оне', 'оне'],
  ['beep', 'веер'],
  ['beep2', 'веер2'],
  ['веер', 'веер'],
  ['веер2', 'веер2'],
  ['jois', 'jois'],
  ['джойс', 'jois'],
  ['джоис', 'jois'],
]);

const cyrillicToLatinMap = new Map([
  ['а', 'a'],
  ['б', 'b'],
  ['в', 'v'],
  ['г', 'g'],
  ['д', 'd'],
  ['е', 'e'],
  ['ё', 'e'],
  ['ж', 'zh'],
  ['з', 'z'],
  ['и', 'i'],
  ['й', 'i'],
  ['к', 'k'],
  ['л', 'l'],
  ['м', 'm'],
  ['н', 'n'],
  ['о', 'o'],
  ['п', 'p'],
  ['р', 'r'],
  ['с', 's'],
  ['т', 't'],
  ['у', 'u'],
  ['ф', 'f'],
  ['х', 'h'],
  ['ц', 'c'],
  ['ч', 'ch'],
  ['ш', 'sh'],
  ['щ', 'sch'],
  ['ъ', ''],
  ['ы', 'y'],
  ['ь', ''],
  ['э', 'e'],
  ['ю', 'yu'],
  ['я', 'ya'],
]);

const latinToCyrillicPairs: Array<[string, string]> = [
  ['sch', 'щ'],
  ['sh', 'ш'],
  ['ch', 'ч'],
  ['zh', 'ж'],
  ['yu', 'ю'],
  ['ya', 'я'],
  ['yo', 'е'],
  ['kh', 'х'],
  ['a', 'а'],
  ['b', 'б'],
  ['c', 'к'],
  ['d', 'д'],
  ['e', 'е'],
  ['f', 'ф'],
  ['g', 'г'],
  ['h', 'х'],
  ['i', 'и'],
  ['j', 'дж'],
  ['k', 'к'],
  ['l', 'л'],
  ['m', 'м'],
  ['n', 'н'],
  ['o', 'о'],
  ['p', 'п'],
  ['q', 'к'],
  ['r', 'р'],
  ['s', 'с'],
  ['t', 'т'],
  ['u', 'у'],
  ['v', 'в'],
  ['w', 'в'],
  ['x', 'кс'],
  ['y', 'и'],
  ['z', 'з'],
];

const englishPhoneticPairs: Array<[string, string]> = [
  ['eigh', 'ей'],
  ['igh', 'ай'],
  ['sh', 'ш'],
  ['ch', 'ч'],
  ['zh', 'ж'],
  ['kh', 'х'],
  ['ph', 'ф'],
  ['th', 'т'],
  ['ts', 'ц'],
  ['yu', 'ю'],
  ['ya', 'я'],
  ['yo', 'е'],
  ['qu', 'кв'],
  ['ck', 'к'],
  ['ee', 'и'],
  ['ea', 'и'],
  ['oo', 'у'],
  ['ay', 'ей'],
  ['ey', 'ей'],
  ['oy', 'ой'],
];

const englishPhoneticLetters = new Map([
  ['a', 'а'],
  ['b', 'б'],
  ['d', 'д'],
  ['e', 'е'],
  ['f', 'ф'],
  ['g', 'г'],
  ['h', 'х'],
  ['i', 'и'],
  ['j', 'дж'],
  ['k', 'к'],
  ['l', 'л'],
  ['m', 'м'],
  ['n', 'н'],
  ['o', 'о'],
  ['p', 'п'],
  ['q', 'к'],
  ['r', 'р'],
  ['s', 'с'],
  ['t', 'т'],
  ['u', 'у'],
  ['v', 'в'],
  ['w', 'в'],
  ['x', 'кс'],
  ['y', 'и'],
  ['z', 'з'],
]);

const visualLatinToCyrillicLetters = new Map([
  ['a', 'а'],
  ['b', 'в'],
  ['c', 'с'],
  ['e', 'е'],
  ['h', 'н'],
  ['k', 'к'],
  ['m', 'м'],
  ['o', 'о'],
  ['p', 'р'],
  ['t', 'т'],
  ['x', 'х'],
  ['y', 'у'],
]);

export function normalizeFeedMatchText(value: string) {
  return value
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/э/gu, 'е')
    .replace(/[«»"']/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/u)
    .filter((token) => token && !genericFeedNameTokens.has(token))
    .join(' ')
    .trim();
}

export function findFeedObjectSuggestion(
  feedObject: FeedSourceAnalysisObject,
  objectOptions: RealEstateObjectSummary[],
  currentObjectId = '',
) {
  if (currentObjectId) {
    return currentObjectId;
  }

  const match = findPreferredFeedObjectMatch(feedObject, objectOptions);

  return match?.id ?? '';
}

export function findFeedDeveloperSuggestion(
  analysis: FeedSourceAnalysis,
  developers: ObjectDeveloper[],
  objects: RealEstateObjectSummary[],
) {
  const developerByName = findDeveloperByNameSuggestion(analysis.developerName, developers);

  if (developerByName) {
    return developerByName;
  }

  const developerMatchCounts = new Map<string, number>();

  for (const feedObject of analysis.objects) {
    const developerIds = findFeedObjectDeveloperMatches(feedObject, objects);

    if (developerIds.length !== 1) {
      continue;
    }

    const developerId = developerIds[0];

    if (developerId) {
      developerMatchCounts.set(developerId, (developerMatchCounts.get(developerId) ?? 0) + 1);
    }
  }

  return findDominantDeveloperId(developerMatchCounts);
}

function findDeveloperByNameSuggestion(developerName: string | null, developers: ObjectDeveloper[]) {
  if (!developerName) {
    return '';
  }

  const matches = developers.filter((developer) => namesMatch(developerName, developer.name));

  return matches.length === 1 ? matches[0]?.id ?? '' : '';
}

function findFeedObjectMatches(feedObject: FeedSourceAnalysisObject, objectOptions: RealEstateObjectSummary[]) {
  const feedNames = getFeedObjectNames(feedObject);

  if (feedNames.length === 0) {
    return [];
  }

  return objectOptions.filter((object) =>
    feedNames.some((feedName) => [object.title, object.slug].some((objectName) => namesMatch(feedName, objectName))),
  );
}

function findPreferredFeedObjectMatch(
  feedObject: FeedSourceAnalysisObject,
  objectOptions: RealEstateObjectSummary[],
) {
  const matches = findFeedObjectMatches(feedObject, objectOptions);

  if (matches.length <= 1) {
    return matches[0] ?? null;
  }

  const feedNames = getFeedObjectNames(feedObject);
  const narrowedMatches = narrowMatchesByTrailingNumber(feedNames, matches);
  const scoredMatches = narrowedMatches
    .map((object) => ({ object, score: getFeedObjectMatchScore(feedNames, object) }))
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score);

  const bestScore = scoredMatches[0]?.score ?? 0;
  const bestMatches = scoredMatches.filter((match) => match.score === bestScore);

  return bestMatches.length === 1 ? bestMatches[0]?.object ?? null : null;
}

function findFeedObjectDeveloperMatches(
  feedObject: FeedSourceAnalysisObject,
  objectOptions: RealEstateObjectSummary[],
) {
  const developerIds = new Set(
    findFeedObjectMatches(feedObject, objectOptions)
      .map((object) => object.developer?.id)
      .filter((developerId): developerId is string => Boolean(developerId)),
  );

  return [...developerIds];
}

function findDominantDeveloperId(developerMatchCounts: Map<string, number>) {
  const [first, second] = [...developerMatchCounts.entries()].sort((left, right) => right[1] - left[1]);

  if (!first) {
    return '';
  }

  if (second && second[1] >= first[1]) {
    return '';
  }

  return first[0];
}

function narrowMatchesByTrailingNumber(feedNames: string[], matches: RealEstateObjectSummary[]) {
  const feedNumber = feedNames.map(getTrailingNumberSuffix).find(Boolean);

  if (feedNumber) {
    const numberedMatches = matches.filter((object) =>
      [object.title, object.slug].some((value) => getTrailingNumberSuffix(value) === feedNumber),
    );

    return numberedMatches.length > 0 ? numberedMatches : matches;
  }

  const unnumberedMatches = matches.filter((object) =>
    [object.title, object.slug].every((value) => !getTrailingNumberSuffix(value)),
  );

  return unnumberedMatches.length > 0 ? unnumberedMatches : matches;
}

function getFeedObjectMatchScore(feedNames: string[], object: RealEstateObjectSummary) {
  return Math.max(
    ...feedNames.flatMap((feedName) => [
      getNameMatchScore(feedName, object.title, 20),
      getNameMatchScore(feedName, object.slug, 0),
    ]),
  );
}

function getNameMatchScore(sourceName: string, targetName: string | null | undefined, titleBonus: number) {
  if (!targetName || !namesMatch(sourceName, targetName)) {
    return 0;
  }

  const normalizedSource = normalizeFeedMatchText(sourceName);
  const normalizedTarget = normalizeFeedMatchText(targetName);
  const sourceKeys = createFeedNameMatchKeys(sourceName);
  const targetKeys = createFeedNameMatchKeys(targetName);

  if (normalizedSource === normalizedTarget) {
    return 120 + titleBonus;
  }

  if (sourceKeys.has(normalizedTarget)) {
    return 110 + titleBonus;
  }

  if (targetKeys.has(normalizedSource)) {
    return 100 + titleBonus;
  }

  if (hasSourceTokenCoverage(sourceKeys, targetKeys)) {
    return 90 + titleBonus;
  }

  return 70 + titleBonus;
}

function hasSourceTokenCoverage(sourceKeys: Set<string>, targetKeys: Set<string>) {
  for (const sourceKey of sourceKeys) {
    const sourceTokens = sourceKey.split(/\s+/u).filter((token) => token.length >= 2);

    if (sourceTokens.length === 0) {
      continue;
    }

    if (sourceTokens.every((token) => targetKeys.has(token))) {
      return true;
    }
  }

  return false;
}

function getFeedObjectNames(feedObject: FeedSourceAnalysisObject) {
  return [
    feedObject.title,
    ...feedObject.projectNames,
    ...feedObject.buildingNames,
  ].filter((value) => normalizeFeedMatchText(value).length > 0);
}

function namesMatch(sourceName: string, targetName: string | null | undefined) {
  if (!targetName) {
    return false;
  }

  const sourceKeys = createFeedNameMatchKeys(sourceName);
  const targetKeys = createFeedNameMatchKeys(targetName);

  if (sourceKeys.size === 0 || targetKeys.size === 0) {
    return false;
  }

  for (const key of sourceKeys) {
    if (targetKeys.has(key)) {
      return true;
    }
  }

  if (!hasTrailingNumberSuffix(sourceName)) {
    const targetBaseName = stripTrailingNumberSuffix(targetName);
    const targetBaseKeys = targetBaseName === normalizeFeedMatchText(targetName)
      ? new Set<string>()
      : createFeedNameMatchKeys(targetBaseName);

    for (const key of sourceKeys) {
      if (targetBaseKeys.has(key)) {
        return true;
      }
    }
  }

  return hasHighSimilarityMatch(sourceKeys, targetKeys);
}

function createFeedNameMatchKeys(value: string) {
  const normalized = normalizeFeedMatchText(value);
  const keys = new Set<string>();
  const hasCanonicalAlias = hasCanonicalNameAlias(normalized);

  addNameKeyVariants(keys, normalized);
  addNameKeyVariants(keys, transliterateCyrillicToLatin(normalized));
  addNameKeyVariants(keys, transliterateLatinToCyrillic(normalized));
  addNameKeyVariants(keys, transliterateVisualLatinToCyrillic(normalized));

  if (!hasCanonicalAlias) {
    addNameKeyVariants(keys, transliterateEnglishLatinToCyrillic(normalized));
  }

  return keys;
}

function hasCanonicalNameAlias(value: string) {
  const normalized = normalizeFeedMatchText(value);
  const tokens = normalized.split(/\s+/u).filter(Boolean);

  if (tokens.some((token) => canonicalTokenAliases.has(token))) {
    return true;
  }

  return canonicalCompactAliases.has(tokens.join(''));
}

function addNameKeyVariants(keys: Set<string>, value: string) {
  const normalized = normalizeFeedMatchText(value);

  if (!normalized) {
    return;
  }

  addMeaningfulKey(keys, normalized);

  const tokens = normalized.split(/\s+/u).filter(Boolean);
  const canonicalTokens = tokens.map((token) => canonicalTokenAliases.get(token) ?? token);
  const canonical = canonicalTokens.join(' ');
  const compact = tokens.join('');
  const canonicalCompact = canonicalTokens.join('');
  const hasTrailingNumericToken = /^\d+$/u.test(tokens.at(-1) ?? '');

  addMeaningfulKey(keys, canonical);
  addMeaningfulKey(keys, compact);
  addMeaningfulKey(keys, canonicalCompact);
  addMeaningfulKey(keys, canonicalCompactAliases.get(compact) ?? '');
  addMeaningfulKey(keys, canonicalCompactAliases.get(canonicalCompact) ?? '');

  for (const token of tokens) {
    if ((token === 'beep' || token === 'веер') && hasTrailingNumericToken) {
      continue;
    }

    addMeaningfulKey(keys, canonicalTokenAliases.get(token) ?? '');
  }
}

function addMeaningfulKey(keys: Set<string>, key: string) {
  const normalized = key.trim();

  if (normalized.length >= 2) {
    keys.add(normalized);
  }
}

function hasHighSimilarityMatch(sourceKeys: Set<string>, targetKeys: Set<string>) {
  for (const sourceKey of sourceKeys) {
    if (sourceKey.length < 5) {
      continue;
    }

    for (const targetKey of targetKeys) {
      if (targetKey.length < 5) {
        continue;
      }

      if (calculateSimilarity(sourceKey, targetKey) >= 0.9) {
        return true;
      }
    }
  }

  return false;
}

function calculateSimilarity(left: string, right: string) {
  const maxLength = Math.max(left.length, right.length);

  if (maxLength === 0) {
    return 1;
  }

  return 1 - calculateLevenshteinDistance(left, right) / maxLength;
}

function calculateLevenshteinDistance(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;

      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + cost,
      );
    }

    for (let index = 0; index < previous.length; index += 1) {
      previous[index] = current[index] ?? 0;
    }
  }

  return previous[right.length] ?? 0;
}

function transliterateCyrillicToLatin(value: string) {
  return [...value]
    .map((letter) => cyrillicToLatinMap.get(letter) ?? letter)
    .join('');
}

function transliterateLatinToCyrillic(value: string) {
  let result = value;

  for (const [latin, cyrillic] of latinToCyrillicPairs) {
    result = result.replace(new RegExp(latin, 'gu'), cyrillic);
  }

  return result;
}

function transliterateEnglishLatinToCyrillic(value: string) {
  let result = '';
  let index = 0;

  while (index < value.length) {
    const rest = value.slice(index);
    const pair = englishPhoneticPairs.find(([latin]) => rest.startsWith(latin));

    if (pair) {
      result += pair[1];
      index += pair[0].length;
      continue;
    }

    const letter = value[index] ?? '';

    if (letter === 'c') {
      const nextLetter = value[index + 1] ?? '';
      result += /^[eiy]$/u.test(nextLetter) ? 'с' : 'к';
      index += 1;
      continue;
    }

    result += englishPhoneticLetters.get(letter) ?? letter;
    index += 1;
  }

  return result;
}

function transliterateVisualLatinToCyrillic(value: string) {
  return [...value]
    .map((letter) => visualLatinToCyrillicLetters.get(letter) ?? letter)
    .join('');
}

function hasTrailingNumberSuffix(value: string) {
  return Boolean(getTrailingNumberSuffix(value));
}

function stripTrailingNumberSuffix(value: string) {
  return normalizeFeedMatchText(value).replace(/\s+\d+$/u, '').trim();
}

function getTrailingNumberSuffix(value: string | null | undefined) {
  if (!value) {
    return '';
  }

  return normalizeFeedMatchText(value).match(/\s+(\d+)$/u)?.[1] ?? '';
}
