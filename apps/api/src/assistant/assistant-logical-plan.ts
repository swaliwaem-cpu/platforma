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
    const nextPlace = extractInsidePlace(text);
    if (nextPlace) spatial = nextPlace;
    else if (spatial && /^(?:парк\p{L}*|район\p{L}*|кольц\p{L}*)$/iu.test(spatial)
      && /^(?:парк\p{L}*|район\p{L}*|кольц\p{L}*)\s+\p{L}/iu.test(text.trim())) {
      spatial = text.trim().replace(/[.!?]+$/u, '');
    }
    if (/(?:без\s+ограничени\p{L}*\s+(?:по|до)\s+метро|(?:метро|время\s+до\s+метро)\s+(?:не\s*важ\p{L}*|не\s+учитыв\p{L}*))/iu.test(text)) {
      travel = { mentioned: false, minutes: null };
      continue;
    }
    const nextTravel = extractWalkingTimeToMetro(text, travel.mentioned && !travel.unsupportedMode);
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
  return {
    predicates,
    missingTravelValue: travel.mentioned && travel.minutes === null,
    ...(travel.unsupportedMode ? { unsupportedTravelConstraint: true } : {}),
  };
}

function extractInsidePlace(text: string) {
  const match = text.match(/(?:^|[\s,;])внутри\s+(?:[«"]([^»"]+)[»"]|([^.!?;\r\n]+))/iu);
  if (!match) return null;
  if (match[1]) return match[1].trim();
  return match[2]!.split(/,|\s+(?:и\s+)?(?=(?:пешком|(?:до|не\s+более|не\s+больше|максимум|в)\s+(?:\d+|[\p{L}-]+)\s+мин\p{L}*))/iu)[0]!.trim() || null;
}

function extractWalkingTimeToMetro(text: string, hasPriorMetroConstraint = false): {
  mentioned: boolean; minutes: number | null; unsupportedMode?: boolean;
} {
  const unsupported = { mentioned: true, minutes: null, unsupportedMode: true };
  const metroContext = hasPriorMetroConstraint || /метро/iu.test(text);
  if (!metroContext) return { mentioned: false, minutes: null };
  // V1 can represent only integer upper bounds. Do not turn the fractional
  // tail or a lower bound into a different, apparently grounded condition.
  if (/\d+[.,]\d+\s*мин\p{L}*/iu.test(text)
    || /(?:не\s+(?:менее|меньше)|минимум|ровно|от)\s+(?:\d+|[\p{L}-]+)(?:\s+до\s+(?:\d+|[\p{L}-]+))?\s+мин\p{L}*/iu.test(text)
    || (hasPriorMetroConstraint && /^(?:\d+[.,]\d+|(?:не\s+(?:менее|меньше)|минимум|ровно|от)\s+(?:\d+|[\p{L}-]+))\s*[.!?]?$/iu.test(text.trim()))) return unsupported;

  const numericReply = (clause: string) => clause.trim().match(
    /^(?:нет\s+)?(?:(?:до|не\s+более|не\s+больше|максимум)\s+)?(\d+|[\p{L}-]+)(?:\s+мин\p{L}*)?$/iu,
  );
  const clauses = text.split(/[,;.!?\r\n]+|\s+и\s+/iu).map((clause) => clause.trim()).filter(Boolean);
  const values: Array<number | null> = [];
  let mentioned = false;
  for (const clause of clauses) {
    const metro = /метро/iu.test(clause);
    const minutes = /(?:^|\s)мин\p{L}*/iu.test(clause);
    const reply = numericReply(clause);
    if (!metro) {
      if ((hasPriorMetroConstraint || /метро/iu.test(text)) && reply
        && (minutes || hasPriorMetroConstraint) && parseRussianCount(reply[1]!) !== null) {
        mentioned = true;
        values.push(parseRussianCount(reply[1]!));
      } else if (minutes) {
        // A time to school/work cannot be assigned to NEAREST_METRO or dropped.
        return unsupported;
      }
      continue;
    }
    if (/(?:на\s+(?:машин|автомобил|велосипед|транспорт)\p{L}*)/iu.test(clause)) return unsupported;
    const walking = /пешком/iu.test(clause) || hasPriorMetroConstraint;
    if (minutes && !walking) return unsupported;
    if (!walking) continue;
    mentioned = true;
    // Reject additional destinations even when punctuation was omitted.
    const destinations = [...clause.matchAll(/(?:^|\s)до\s+([\p{L}\p{N}-]+)/giu)];
    if (minutes && destinations.some((match) => !/^(?:метро|ближайш\p{L}*)$/iu.test(match[1]!)
      && parseRussianCount(match[1]!) === null)) return unsupported;
    values.push(...[...clause.matchAll(/(?:^|[^\p{L}\p{N}])(\d+|[\p{L}-]+)\s+мин\p{L}*/giu)]
      .map((match) => parseRussianCount(match[1]!)));
  }
  return {
    mentioned,
    minutes: values.length > 0 && values.every((value) => value !== null) ? Math.min(...values as number[]) : null,
  };
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
