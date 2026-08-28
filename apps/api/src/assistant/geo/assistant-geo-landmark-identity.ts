import type { AssistantGeoKind } from '@platforma/shared' with { 'resolution-mode': 'import' };

export type AssistantGeoLandmarkIdentity = {
  version: 1;
  label: string;
  normalizedQuery: string;
  userAlias: string;
  aliases: string[];
  providerQuery: string;
  expectedKind: AssistantGeoKind | null;
  expectedCity: string | null;
  expectedCountry: string | null;
  overpassTagValues: string[];
};

type FixedIdentity = Omit<AssistantGeoLandmarkIdentity, 'userAlias'> & {
  inputAliases: readonly string[];
};

const moscowRoadScope = {
  expectedKind: 'LINE' as const,
  expectedCity: 'Москва',
  expectedCountry: 'ru',
};

const identities: readonly FixedIdentity[] = [
  {
    version: 1,
    label: 'Садовое кольцо',
    normalizedQuery: 'садовое кольцо',
    aliases: ['садовое кольцо'],
    inputAliases: [
      'садовое кольцо',
      'садового кольца',
      'садовому кольцу',
      'садовым кольцом',
      'садовом кольце',
    ],
    providerQuery: 'садовое кольцо',
    ...moscowRoadScope,
    overpassTagValues: ['Садовое кольцо'],
  },
  {
    version: 1,
    label: 'ТТК',
    normalizedQuery: 'третье транспортное кольцо',
    aliases: ['ттк', 'третье транспортное кольцо'],
    inputAliases: [
      'ттк',
      'третье транспортное кольцо',
      'третьего транспортного кольца',
      'третьему транспортному кольцу',
      'третьим транспортным кольцом',
      'третьем транспортном кольце',
    ],
    providerQuery: 'третье транспортное кольцо',
    ...moscowRoadScope,
    overpassTagValues: ['ТТК', 'Третье транспортное кольцо'],
  },
  {
    version: 1,
    label: 'МКАД',
    normalizedQuery: 'московская кольцевая автодорога',
    aliases: [
      'мкад',
      'московская кольцевая автодорога',
      'московская кольцевая автомобильная дорога',
    ],
    inputAliases: [
      'мкад',
      'московская кольцевая автодорога',
      'московской кольцевой автодороги',
      'московской кольцевой автодороге',
      'московскую кольцевую автодорогу',
      'московской кольцевой автодорогой',
      'московская кольцевая автомобильная дорога',
      'московской кольцевой автомобильной дороги',
      'московской кольцевой автомобильной дороге',
      'московскую кольцевую автомобильную дорогу',
      'московской кольцевой автомобильной дорогой',
    ],
    providerQuery: 'московская кольцевая автодорога',
    ...moscowRoadScope,
    overpassTagValues: ['МКАД', 'Московская кольцевая автодорога', 'Московская кольцевая автомобильная дорога'],
  },
  {
    version: 1,
    label: 'район Арбат',
    normalizedQuery: 'район арбат',
    aliases: ['арбат', 'район арбат'],
    inputAliases: ['арбат', 'район арбат', 'района арбат'],
    providerQuery: 'район арбат',
    expectedKind: 'AREA',
    expectedCity: 'Москва',
    expectedCountry: 'ru',
    overpassTagValues: [],
  },
];

export function resolveAssistantGeoLandmarkIdentity(value: string): AssistantGeoLandmarkIdentity {
  const label = normalizeDisplayText(value);
  const userAlias = normalizeAssistantGeoIdentityText(label);
  const fixed = identities.find(({ inputAliases }) => inputAliases.includes(userAlias));
  if (!fixed) {
    return {
      version: 1,
      label,
      normalizedQuery: userAlias,
      userAlias,
      aliases: [userAlias],
      providerQuery: label,
      expectedKind: null,
      expectedCity: null,
      expectedCountry: null,
      overpassTagValues: [label],
    };
  }
  return {
    version: fixed.version,
    label: fixed.label,
    normalizedQuery: fixed.normalizedQuery,
    userAlias,
    aliases: [...fixed.aliases],
    providerQuery: fixed.providerQuery,
    expectedKind: fixed.expectedKind,
    expectedCity: fixed.expectedCity,
    expectedCountry: fixed.expectedCountry,
    overpassTagValues: [...fixed.overpassTagValues],
  };
}

export function normalizeAssistantGeoIdentityText(value: string) {
  return value
    .normalize('NFKC')
    .replace(/\u00a0/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/gu, 'е');
}

function normalizeDisplayText(value: string) {
  return value.normalize('NFKC').replace(/\u00a0/gu, ' ').replace(/\s+/gu, ' ').trim();
}
