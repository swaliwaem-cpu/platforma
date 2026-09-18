// «в Хамовниках», «в Марьине», «в Некрасовке»: a capitalised toponym right after «в» in the
// locative case. The canonical nominative name is resolved later against the locations table.
const locativeDistrictPattern = /(?:^|[\s,;(])в\s+(?<district>\p{Lu}[\p{L}-]{2,}(?:ах|ях|ине|ове|еве|ёве|ке))(?=[\s,.!?;)]|$)/u;

// Brokers type district names in every case and without capitals: «в Замоскворечье»,
// «на Беговой», «в марьиной роще», «в ЗАО». Listing the locative endings cannot cover that,
// so the planner path takes any toponym-shaped word after «в»/«во»/«на» and lets
// `findAdministrativeDistrict` decide: a candidate that matches no row in `locations` is
// dropped instead of becoming a hard filter. The geo resolver keeps the strict pattern above,
// because an unknown district on that path is sent to the paid geocoder as a landmark.
const looseLocativeDistrictPattern = /(?:^|[\s,;(])(?:в|во|на)\s+(?<district>\p{L}[\p{L}-]{2,})(?=[\s,.!?;)]|$)/iu;

// Words that follow «в»/«на» in ordinary listing talk and would otherwise be looked up as
// districts. Compass and city words are here because the russian stemmer matches them against
// «Северо-Запад», «Дегунино Западное» and the like.
const nonDistrictLocativeWords = new Set([
  'север', 'севере', 'юг', 'юге', 'запад', 'западе', 'восток', 'востоке',
  'северном', 'южном', 'западном', 'восточном', 'округе', 'округ',
  'центр', 'центре', 'москве', 'москва', 'подмосковье', 'области', 'область',
  'продаже', 'наличии', 'ипотеку', 'ипотеке', 'рассрочку', 'рассрочке', 'кредит',
  'новостройке', 'новостройках', 'доме', 'домах', 'квартире', 'квартирах', 'жк',
  'готовом', 'строящемся', 'сданном', 'первом', 'последнем', 'верхнем', 'нижнем',
  'целом', 'общем', 'среднем', 'этом', 'том', 'котором', 'которых', 'него', 'них',
  'районе', 'районах', 'радиусе', 'пределах', 'минутах', 'шаговой', 'пешей',
  'бюджете', 'пределе', 'стиле', 'виде', 'том числе', 'счет', 'счёт',
]);

// The «район X» wording and the strict locative form name a district outright. Everything the
// loose pattern adds is a guess, so `resolveDistrict` drops it when `locations` has no match.
export function extractAssistantStrictDistrictFromText(text: string, requireInPrefix = false) {
  const prefix = requireInPrefix ? '(?:^|[\\s,;])в\\s+' : '(?:в\\s+)?';
  const match = text.match(new RegExp(
    `${prefix}район(?:е)?\\s+[«"]?(.+?)[»"]?(?=\\s+(?:и\\s+)?(?:рядом\\s+с|возле|около|вокруг|у\\s+метро|метро|от\\s+[\\p{L}«"]|сдач\\p{L}*|\\d+\\s*квартал|площад\\p{L}*|этаж\\p{L}*|готов\\p{L}*|в\\s+готов\\p{L}*|класс\\p{L}*|до\\s+\\d|не\\s+(?:дороже|дешевле|позднее|раньше|меньше|больше))|[,.!?;\\r\\n]|$)`,
    'iu',
  ))?.[1]?.trim().replace(/^[«"]|[»"]$/gu, '');
  if (match && match.length <= 160) return match;
  const locative = text.match(locativeDistrictPattern)?.groups?.district;
  return locative && locative.length <= 160 ? locative : null;
}

export function extractAssistantDistrictFromText(text: string, requireInPrefix = false) {
  const strict = extractAssistantStrictDistrictFromText(text, requireInPrefix);
  if (strict || requireInPrefix) return strict;
  const loose = text.match(looseLocativeDistrictPattern)?.groups?.district;
  if (!loose || loose.length > 160) return null;
  return nonDistrictLocativeWords.has(loose.toLocaleLowerCase('ru-RU')) ? null : loose;
}
