import { resolveAssistantGeoLandmarkIdentity } from './geo/assistant-geo-landmark-identity';

export type AssistantLogicalPredicateV1 =
  | {
      type: 'SPATIAL';
      relation: 'INSIDE';
      referenceType: 'PLACE';
      place: string;
    }
  | {
      type: 'TRAVEL_TIME';
      mode: 'WALK';
      destination: 'NEAREST_METRO';
      operator: 'LTE';
      value: number;
      unit: 'MINUTES';
    };

export function extractAssistantLogicalPredicates(messages: string[]) {
  let spatial: string | null = null;
  let travel: ReturnType<typeof extractWalkingTimeToMetro> = { mentioned: false, minutes: null };
  for (const message of messages) {
    const text = message.replace(/\u00a0/gu, ' ');
    spatial = extractInsidePlace(text) ?? spatial;
    const nextTravel = extractWalkingTimeToMetro(text, travel.mentioned);
    if (nextTravel.mentioned) travel = nextTravel;
  }

  const predicates: AssistantLogicalPredicateV1[] = [];
  if (spatial) {
    predicates.push({
      type: 'SPATIAL',
      relation: 'INSIDE',
      referenceType: 'PLACE',
      place: resolveAssistantGeoLandmarkIdentity(spatial).label,
    });
  }
  if (travel.minutes !== null) {
    predicates.push({
      type: 'TRAVEL_TIME',
      mode: 'WALK',
      destination: 'NEAREST_METRO',
      operator: 'LTE',
      value: travel.minutes,
      unit: 'MINUTES',
    });
  }
  return { predicates, missingTravelValue: travel.mentioned && travel.minutes === null };
}

function extractInsidePlace(text: string) {
  const match = text.match(
    /(?:^|[\s,;])внутри\s+[«"]?(.+?)[»"]?(?=\s*(?:,|;|\.|\?|!|\s+и\s+)?\s*(?:(?:до|не\s+более|не\s+больше|максимум)\s+(?:\d+|одн\p{L}*|дв\p{L}*|три|трех|трёх|четыр\p{L}*|пят\p{L}*|шест\p{L}*|сем\p{L}*|восем\p{L}*|девят\p{L}*|десят\p{L}*)\s+мин\p{L}*[^.!?\r\n]{0,60}метро|$))/iu,
  );
  return match?.[1]?.trim().replace(/^[«"]|[»"]$/gu, '') || null;
}

function extractWalkingTimeToMetro(text: string, hasPriorMetroConstraint = false) {
  const mentioned = /(?:пешком[^.!?\r\n]{0,60}(?:ближайш\p{L}*\s+)?метро|(?:ближайш\p{L}*\s+)?метро[^.!?\r\n]{0,60}пешком)/iu.test(text);
  const match = text.match(
    /(?:до|не\s+более|не\s+больше|максимум)\s+(\d{1,3}|[\p{L}-]+)\s+мин\p{L}*[^.!?\r\n]{0,60}(?:ближайш\p{L}*\s+)?метро/iu,
  ) ?? (hasPriorMetroConstraint ? text.match(
    /(?:^|[,;]\s*)(?:нет[,;]?\s*)?(?:до|не\s+более|не\s+больше|максимум)\s+(\d{1,3}|[\p{L}-]+)\s+мин\p{L}*\s*[.!?]?$/iu,
  ) : null);
  if (!match) return { mentioned, minutes: null };
  return { mentioned: true, minutes: parseRussianCount(match[1]!) };
}

function parseRussianCount(value: string) {
  if (/^\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 240 ? parsed : null;
  }
  const normalized = value.toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е');
  const words: Record<string, number> = {
    одну: 1,
    одной: 1,
    один: 1,
    два: 2,
    двух: 2,
    три: 3,
    трех: 3,
    четыре: 4,
    четырех: 4,
    пять: 5,
    пяти: 5,
    шесть: 6,
    шести: 6,
    семь: 7,
    семи: 7,
    восемь: 8,
    восьми: 8,
    девять: 9,
    девяти: 9,
    десять: 10,
    десяти: 10,
    пятнадцать: 15,
    пятнадцати: 15,
    двадцать: 20,
    двадцати: 20,
    тридцать: 30,
    тридцати: 30,
    сорок: 40,
    сорока: 40,
    шестьдесят: 60,
    шестидесяти: 60,
  };
  return words[normalized] ?? null;
}
