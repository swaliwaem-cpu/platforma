import {
  AssistantKnowledgeSourceType,
  AssistantSourceFactKind,
} from '@prisma/client';
import type { AssistantPageContext } from '@platforma/shared' with { 'resolution-mode': 'import' };

import { createObjectSlugReference, normalizeObjectSlug } from '../assistant-object-identity';

const maximumKnowledgeQueryContextLength = 1_000;
const knowledgeScopeQueryCuePattern = /(?:\b(?:есть|где|какая|какие|какой|когда|покажи|расскажи|сколько|что)\b|акци|архитектур|ипотек|инфраструктур|метро|паркинг|рассроч|скидк|срок|стоимост|услов|фасад|цен)/iu;
const knowledgeProjectReferenceStopTokenPattern = /^(?:актуальн\p{L}*|акци\p{L}*|архитектур\p{L}*|все|где|действ\p{L}*|доступн\p{L}*|есть|ипотек\p{L}*|как|какая|какие|какой|когда|можно|покажи|предложен\p{L}*|прямо|работа\p{L}*|расскажи|рассроч\p{L}*|сейчас|сегодня|скидк\p{L}*|сколько|срок\p{L}*|стоимост\p{L}*|услов\p{L}*|цен\p{L}*|что)$/u;
const knowledgeProjectReferencePrepositionPattern = /^(?:без|в|во|для|до|за|из|к|ко|на|над|о|об|около|от|по|под|при|про|рядом|с|со|у)$/u;
const knowledgeProjectReferenceContextNounPattern = /^(?:благоустройств|детск|двор|инфраструктур|кафе|магазин|метро|паркинг|площадк|сад|садик|спорт|фитнес|школ)\p{L}*$/u;
const knowledgeProjectReferenceGrammarTokenPattern = /^(?:же|и|или|ли)$/u;
const knowledgeProjectReferenceModifierPattern = /^[\p{L}]{2,}(?:ая|яя|ое|ее|ые|ие|ый|ий|ой|ую|юю|ого|его|ому|ему|ым|им|ом|ем|ых|их|ыми|ими)$/u;
const knowledgeProjectReferenceModifiedTopicPattern = /^(?:акци|архитектур|ипотек|инфраструктур|паркинг|рассроч|скидк|услов)\p{L}*$/u;
const assistantKnowledgeCurrentSubjectSource = String.raw`(?:акци|ипотек|предложен|рассроч|скидк|ставк|срок|услов)\p{L}*`;
const assistantKnowledgeCurrentSubjectTokenPattern = new RegExp(
  `^${assistantKnowledgeCurrentSubjectSource}$`,
  'u',
);
const knowledgeProjectReferenceQualifierPrepositionPattern = /^(?:без|для|до|на|от|по|при|с|со)$/u;
const knowledgeProjectReferenceQualifierLeadPattern = /^(?:лишь|только)$/u;
const knowledgeProjectReferenceStrictQualifierNounByPreposition: Readonly<Record<string, RegExp>> = {
  без: /^(?:взнос|доход|комисс|переплат|подтвержден|процент|страхов)\p{L}*$/u,
  для: /^(?:it|ит|военнослужащ|взнос|врач|граждан|дет|заемщик|инвест|ипотек|молод|многодет|пенсионер|покупател|работник|рф|самозанят|сем|специалист|сотрудник|учител)\p{L}*$/u,
  до: /^(?:дат|дн|конц|квартал|месяц|начал|срок|год)\p{L}*$/u,
  на: /^(?:год|дн|квартир|лот|месяц|оплат|платеж|покупк|срок)\p{L}*$/u,
  от: /^(?:банк|девелопер|застройщик)\p{L}*$/u,
  по: /^(?:документ|ипотек|программ|ставк|услов)\p{L}*$/u,
  при: /^(?:оплат|приобретен|покупк)\p{L}*$/u,
  с: /^(?:взнос|господдержк|комисс|процент|ставк|субсид|скидк)\p{L}*$/u,
  со: /^(?:взнос|господдержк|комисс|процент|ставк|субсид|скидк)\p{L}*$/u,
};
const knowledgeProjectReferenceQualifierFillerPattern = /^(?:весь|все|всего|всю|дв|одн|перв|пят|тр|четыр)\p{L}*$/u;
const knowledgeProjectReferenceCommercialPredicatePattern = /^(?:доступн|подход)\p{L}*$/u;
const assistantKnowledgeCurrentModifiedSubjectSource = String.raw`(?:\p{L}+\s+){0,3}${assistantKnowledgeCurrentSubjectSource}`;
const assistantKnowledgeCurrentConditionClauseSource = [
  String.raw`(?:прямо\s+)?сейчас`,
  String.raw`сегодня`,
  String.raw`актуальн\p{L}*(?:\s+(?:прямо\s+)?(?:сейчас|сегодня))?`,
  String.raw`на\s+(?:(?:данн|текущ)\p{L}*\s+момент\p{L}*|сегодня)`,
  String.raw`по\s+состоян\p{L}*\s+на\s+(?:сейчас|сегодня|(?:данн|текущ)\p{L}*\s+момент\p{L}*)`,
  String.raw`(?:на|по)\s+(?:актуальн|действующ|последн|свеж|текущ)\p{L}*\s+услов\p{L}*`,
  String.raw`(?:последн|свеж)\p{L}*\s+(?:акци|ипотек|предложен|рассроч|ставк|услов)\p{L}*`,
  String.raw`текущ\p{L}*\s+услов\p{L}*`,
  String.raw`доступн\p{L}*\s+(?:сейчас|сегодня)`,
  String.raw`(?:все\s+)?еще\s+действ(?:ует|уют|ующ\p{L}*)`,
  String.raw`${assistantKnowledgeCurrentSubjectSource}\s+действ(?:ует|уют)`,
  String.raw`действ(?:ует|уют)\s+ли[^?!.,;:\n\r]{0,160}${assistantKnowledgeCurrentSubjectSource}`,
  String.raw`действующ\p{L}*\s+${assistantKnowledgeCurrentSubjectSource}`,
  String.raw`(?:все\s+)?еще\s+доступн\p{L}*`,
  String.raw`(?:все\s+)?еще\s+в\s+сил\p{L}*`,
  String.raw`действител(?:ен|ьна|ьны)(?:\s+ли)?\s+${assistantKnowledgeCurrentSubjectSource}`,
  String.raw`${assistantKnowledgeCurrentSubjectSource}\s+действител(?:ен|ьна|ьны)`,
  String.raw`(?:предложени|услови)\p{L}*\s+(?:(?:все\s+)?еще\s+)?действительно(?=$|[?!.,;:]|\s+до\s+(?:(?:конц|начал)\p{L}*\s+(?:дн|недел|месяц|квартал|год)\p{L}*|\d{1,2}(?:[\s./-]|$)|(?:завтра|сегодня)(?=$|[?!.,;:]|\s))|\s+по\s+\d{1,2}(?:[\s./-]|$)|\s+на\s+(?:сейчас|сегодня|(?:данн|текущ)\p{L}*\s+момент\p{L}*))`,
].join('|');
const assistantKnowledgeCurrentConditionPattern = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])(?:${assistantKnowledgeCurrentConditionClauseSource})(?![\\p{L}\\p{N}])`,
  'iu',
);
const assistantKnowledgeCurrentReferenceSuffixPattern = new RegExp(
  `^(?:${assistantKnowledgeCurrentConditionClauseSource})$`,
  'iu',
);
const assistantKnowledgeCurrentMechanicsQuestionPattern = new RegExp(
  String.raw`(?:^|[^\p{L}\p{N}])(?:(?:(?:на|для)\s+кого|на\s+что|как|почему)(?![\p{L}\p{N}])[^?!.,;:\n\r]{0,160}${assistantKnowledgeCurrentModifiedSubjectSource}\s+действ(?:ует|уют))(?:\s|[?!.,;:]|$)`,
  'iu',
);
const assistantKnowledgeValidityWindowCueSource = String.raw`(?:когда|(?:до\s+какого|по\s+какое|с\s+какого)\s+(?:врем|год|дн|квартал|месяц|момент|недел|срок|числ)\p{L}*|сколько(?:\s+времен\p{L}*)?|как\s+долго)`;
const assistantKnowledgeValidityWindowStateSource = String.raw`(?:(?:будет\s+)?(?:действ(?:ует|уют|овать)|доступн\p{L}*)|законч(?:ится|атся)|заканчива(?:ется|ются)|истека(?:ет|ют)|истечет|истекут)`;
const assistantKnowledgeValiditySubjectSource = String.raw`(?:${assistantKnowledgeCurrentModifiedSubjectSource}(?:\s+\p{L}+){0,2})`;
const assistantKnowledgeValidityWindowQuestionPattern = new RegExp(
  String.raw`(?:^|[^\p{L}\p{N}])${assistantKnowledgeValidityWindowCueSource}(?![\p{L}\p{N}])(?:(?:[^?!.,;:\n\r]{0,160}${assistantKnowledgeValiditySubjectSource}\s+${assistantKnowledgeValidityWindowStateSource})|(?:[^?!.,;:\n\r]{0,160}${assistantKnowledgeValidityWindowStateSource}\s+${assistantKnowledgeValiditySubjectSource}))(?![\p{L}\p{N}])`,
  'iu',
);
const assistantKnowledgeCalendarMonthSource = String.raw`(?:январ\p{L}*|феврал\p{L}*|март\p{L}*|апрел\p{L}*|май|мая|мае|маем|маю|июн\p{L}*|июл\p{L}*|август\p{L}*|сентябр\p{L}*|октябр\p{L}*|ноябр\p{L}*|декабр\p{L}*)`;
const assistantKnowledgeDayMonthSource = String.raw`(?:\d{1,2}\s+${assistantKnowledgeCalendarMonthSource}(?:\s+\d{4})?)`;
const assistantKnowledgeFullNumericDateSource = String.raw`(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4})`;
const assistantKnowledgeCalendarPointSource = String.raw`(?:${assistantKnowledgeDayMonthSource}|${assistantKnowledgeFullNumericDateSource}|\d{4}\s+год\p{L}*|${assistantKnowledgeCalendarMonthSource})`;
const assistantKnowledgeBareFutureBoundarySource = String.raw`(?:${assistantKnowledgeDayMonthSource}|${assistantKnowledgeFullNumericDateSource}|сегодня|завтра)`;
const assistantKnowledgeTemporalBoundarySource = String.raw`(?:(?:до|по|с|в)\s+(?:(?:конц|начал)\p{L}*\s+(?:(?:дн|год|квартал|месяц|недел)\p{L}*|\d{4}\s+год\p{L}*|${assistantKnowledgeCalendarMonthSource})|${assistantKnowledgeCalendarPointSource})|${assistantKnowledgeBareFutureBoundarySource})`;
const assistantKnowledgePostStateValidityWindowPattern = new RegExp(
  String.raw`(?:${assistantKnowledgeValiditySubjectSource}\s+${assistantKnowledgeValidityWindowStateSource}|${assistantKnowledgeValidityWindowStateSource}\s+${assistantKnowledgeValiditySubjectSource})[^?!.,;:\n\r]{0,40}${assistantKnowledgeTemporalBoundarySource}(?![\p{L}\p{N}])`,
  'iu',
);
const assistantKnowledgePreStateValidityWindowPattern = new RegExp(
  String.raw`(?:^|[^\p{L}\p{N}])${assistantKnowledgeTemporalBoundarySource}(?![\p{L}\p{N}])[^?!.,;:\n\r]{0,40}(?:${assistantKnowledgeValiditySubjectSource}\s+${assistantKnowledgeValidityWindowStateSource}|${assistantKnowledgeValidityWindowStateSource}\s+${assistantKnowledgeValiditySubjectSource})(?![\p{L}\p{N}])`,
  'iu',
);
const assistantKnowledgeExplicitTemporalMarkerPattern = /(?:^|[^\p{L}\p{N}])(?:(?:прямо\s+)?сейчас|сегодня|актуальн\p{L}*|(?:все\s+)?еще|на\s+(?:(?:данн|текущ)\p{L}*\s+момент\p{L}*|сегодня)|по\s+состоян\p{L}*\s+на)(?![\p{L}\p{N}])/iu;

type KnowledgeAuthorityInput = {
  kind: AssistantSourceFactKind;
  sourceType: AssistantKnowledgeSourceType;
  sourcePriority: number;
};

type KnowledgeConflictInput = {
  kind: AssistantSourceFactKind;
  label: string;
  sourceId: string;
  projectKey: string | null;
  developerKey: string | null;
};

export function assistantKnowledgeAuthorityTier(input: Pick<KnowledgeAuthorityInput, 'sourceType'>) {
  if (input.sourceType === AssistantKnowledgeSourceType.DEVELOPMENT_PAGE) return 3;
  if (input.sourceType === AssistantKnowledgeSourceType.DEVELOPER_PROMOTION
    || input.sourceType === AssistantKnowledgeSourceType.BANK_PROMOTION) return 2;
  return 1;
}

export function assistantKnowledgeAuthorityScore(input: KnowledgeAuthorityInput) {
  const boundedPriority = Math.max(-999_999, Math.min(999_999, input.sourcePriority));
  return assistantKnowledgeAuthorityTier(input) * 2_000_000 + boundedPriority;
}

export function assistantKnowledgeConflictKey(input: KnowledgeConflictInput) {
  const scopeKey = input.projectKey ?? input.developerKey ?? input.sourceId;
  return input.kind === AssistantSourceFactKind.PROMOTION
    ? `${input.kind}:${scopeKey}:${normalizeKnowledgeFactLabel(input.label)}`
    : `${input.kind}:${scopeKey}`;
}

export type AssistantKnowledgePromotionTopic = 'INSTALLMENT' | 'MORTGAGE' | 'PURCHASE';

export function createAssistantKnowledgeQueryContext(
  messages: readonly string[],
  context: AssistantPageContext | null,
) {
  const turns = messages
    .map((message) => message.trim().replace(/\s+/gu, ' '))
    .filter(Boolean);
  const latest = turns[turns.length - 1];
  if (!latest) return '';
  const previous = turns[turns.length - 2];
  const query = previous && isScopeOnlyKnowledgeContinuation(latest, context)
    ? `${latest}\n${previous}`
    : latest;
  return query.slice(0, maximumKnowledgeQueryContextLength).trimEnd();
}

export function createAssistantKnowledgePageContext(
  messages: readonly string[],
  context: AssistantPageContext | null,
) {
  const turns = messages
    .map((message) => message.trim().replace(/\s+/gu, ' '))
    .filter(Boolean);
  const latest = turns[turns.length - 1];
  if (!latest) return context;
  return hasExplicitAssistantKnowledgeProjectReference(latest) ? null : context;
}

export function hasExplicitAssistantKnowledgeProjectReference(value: string) {
  const referenceClause = extractAssistantKnowledgeProjectReferenceClause(value);
  if (referenceClause === null) return false;
  if (isDelimitedAssistantKnowledgeProjectReference(value)
    || hasCapitalizedAssistantKnowledgeProjectReference(value)) return true;
  return !isAssistantKnowledgeContextOnlyProjectReferenceClause(referenceClause);
}

export function extractAssistantKnowledgeProjectReferenceClause(value: string) {
  const rawReferenceClause = extractRawAssistantKnowledgeProjectReferenceClause(value);
  if (!rawReferenceClause) return null;
  const referenceClause = normalizeKnowledgeScopeReference(rawReferenceClause);
  return referenceClause.length > 0 && referenceClause.length <= 180 ? referenceClause : null;
}

export function isDelimitedAssistantKnowledgeProjectReference(value: string) {
  return /(?:^|[^\p{L}\p{N}])жк\s*[«„“"'(]/iu.test(value);
}

export function isAssistantKnowledgeContextOnlyProjectReferenceClause(value: string) {
  const normalized = normalizeKnowledgeScopeReference(value);
  if (!normalized) return false;
  if (assistantKnowledgeCurrentReferenceSuffixPattern.test(normalized)) return true;
  if (isAssistantKnowledgeCommercialContextClause(normalized, false)
    || isAssistantKnowledgeCommercialPredicateClause(normalized, false)
    || isAssistantKnowledgeModifiedContextClause(normalized)) return true;
  return isAssistantKnowledgeBoundedContextGrammar(normalized);
}

export function resolveAssistantKnowledgeProjectIdentity<
  T extends { projectKey: string; objectTitle: string },
>(
  referenceClause: string,
  identities: readonly T[],
  options: { allowReferenceTail?: boolean; referenceQuery?: string } = {},
): T | null {
  const normalizedReference = normalizeKnowledgeScopeReference(referenceClause);
  if (!normalizedReference || normalizedReference.length > 180) return null;
  const allowInfrastructureTail = options.referenceQuery
    ? isAssistantKnowledgeInfrastructureReferenceQuery(options.referenceQuery)
    : false;
  // Brands are written in either alphabet («Nicole» for «ЖК Николь»); the Latin project key
  // without its «zhiloj kompleks» prefix is the alphabet-neutral identity.
  const slugReference = createObjectSlugReference(referenceClause);
  const matches = new Map<string, { identity: T; specificity: number }>();
  for (const identity of identities) {
    const normalizedTitle = normalizeKnowledgeProjectTitle(identity.objectTitle);
    const normalizedProjectKey = normalizeKnowledgeScopeReference(identity.projectKey);
    const specificity = Math.max(
      projectIdentityMatchSpecificity(
        normalizedReference,
        normalizedTitle,
        options.allowReferenceTail !== false,
        allowInfrastructureTail,
      ) ?? -1,
      projectIdentityMatchSpecificity(
        normalizedReference,
        normalizedProjectKey,
        options.allowReferenceTail !== false,
        allowInfrastructureTail,
      ) ?? -1,
      slugReference.length >= 3
        ? projectIdentityMatchSpecificity(
            slugReference,
            normalizeObjectSlug(identity.projectKey),
            options.allowReferenceTail !== false,
            allowInfrastructureTail,
          ) ?? -1
        : -1,
    );
    if (specificity < 0) continue;
    const existing = matches.get(identity.projectKey);
    if (!existing || specificity > existing.specificity) {
      matches.set(identity.projectKey, { identity, specificity });
    }
  }
  const strongestSpecificity = Math.max(-1, ...[...matches.values()].map(({ specificity }) => specificity));
  const strongest = [...matches.values()].filter(({ specificity }) => specificity === strongestSpecificity);
  return strongest.length === 1 ? strongest[0]!.identity : null;
}

export function requiresAssistantKnowledgeCurrentVerification(value: string) {
  const normalized = normalizeKnowledgeText(value);
  if (assistantKnowledgeValidityWindowQuestionPattern.test(normalized)
    || assistantKnowledgePostStateValidityWindowPattern.test(normalized)
    || assistantKnowledgePreStateValidityWindowPattern.test(normalized)) return true;
  return (!assistantKnowledgeCurrentMechanicsQuestionPattern.test(normalized)
      || assistantKnowledgeExplicitTemporalMarkerPattern.test(normalized))
    && assistantKnowledgeCurrentConditionPattern.test(normalized);
}

export function assistantKnowledgePromotionTopic(value: string): AssistantKnowledgePromotionTopic | null {
  return assistantKnowledgePromotionTopics(value)[0] ?? null;
}

export function assistantKnowledgePromotionTopics(value: string): AssistantKnowledgePromotionTopic[] {
  const normalized = normalizeKnowledgeText(value);
  const topics: AssistantKnowledgePromotionTopic[] = [];
  if (/рассроч|первоначальн\S*\s+взнос|ежемесячн\S*\s+платеж/iu.test(normalized)) topics.push('INSTALLMENT');
  if (/ипотек|ипотеч|кредитн\S*\s+ставк/iu.test(normalized)) topics.push('MORTGAGE');
  if (/скидк|акци|услови\S*\s+(?:покупк|оплат)/iu.test(normalized)) topics.push('PURCHASE');
  return topics;
}

export function assistantKnowledgeMatchesPromotionTopic(
  value: string,
  topic: AssistantKnowledgePromotionTopic,
) {
  const topics = assistantKnowledgePromotionTopics(value);
  return topic === 'PURCHASE' ? topics.length > 0 : topics.includes(topic);
}

export function assistantKnowledgePromotionIdentity(input: {
  label: string;
  value: unknown;
}) {
  const topic = assistantKnowledgePromotionTopic(`${input.label} ${stringifyKnowledgeValue(input.value)}`);
  if (!topic) return null;
  const ignoredTokens = new Set([
    'акция', 'акции', 'банка', 'банк', 'для', 'девелопера', 'девелопер', 'жк',
    'застройщика', 'застройщик', 'предложение', 'предложения', 'проекта', 'проект',
    'условие', 'условия',
  ]);
  const identity = normalizeKnowledgeText(input.label)
    .replace(/[^\p{L}\p{N}%]+/gu, ' ')
    .split(' ')
    .filter((token) => token
      && !ignoredTokens.has(token)
      && !/^(?:акци|ипотек|рассроч|скидк)/u.test(token))
    .join(' ');
  return `${topic}:${identity || topic.toLocaleLowerCase('en-US')}`;
}

export function assistantKnowledgeSemanticConflictKey(
  input: KnowledgeConflictInput & { value: unknown },
) {
  if (input.kind !== AssistantSourceFactKind.PROMOTION) {
    return assistantKnowledgeConflictKey(input);
  }
  const identity = assistantKnowledgePromotionIdentity(input);
  return identity ? `${input.kind}:${identity}` : assistantKnowledgeConflictKey(input);
}

export function assistantKnowledgePromotionFocusScore(input: {
  kind: AssistantSourceFactKind;
  label: string;
  value: unknown;
}) {
  if (input.kind !== AssistantSourceFactKind.PROMOTION) return 0;
  const value = stringifyKnowledgeValue(input.value);
  const topic = assistantKnowledgePromotionTopic(`${input.label} ${value}`);
  const labelTopics = assistantKnowledgePromotionTopics(input.label);
  const labelMatchesTopic = topic !== null && labelTopics.includes(topic);
  const topicCount = assistantKnowledgePromotionTopics(value).length;
  return (labelMatchesTopic ? 2 : 0) + (topicCount === 1 ? 1 : 0);
}

export function isSafeOfficialHttpsUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

export function normalizeAssistantKnowledgeRegistryKey(value: string | null | undefined) {
  if (!value) return null;
  const normalized = value.trim().toLocaleLowerCase('ru-RU');
  return normalized.length <= 120
    && /^[\p{L}\p{N}](?:[\p{L}\p{N}._-]{0,118}[\p{L}\p{N}])?$/u.test(normalized)
    ? normalized
    : null;
}

function normalizeKnowledgeFactLabel(value: string) {
  return normalizeKnowledgeText(value);
}

function normalizeKnowledgeProjectTitle(value: string) {
  return normalizeKnowledgeScopeReference(value)
    .replace(/^(?:жк|жилой\s+комплекс)\s+/u, '');
}

function projectIdentityMatchSpecificity(
  reference: string,
  identity: string,
  allowReferenceTail: boolean,
  allowInfrastructureTail: boolean,
) {
  if (!identity) return null;
  if (reference === identity) return identity.length;
  if (!allowReferenceTail || !reference.startsWith(`${identity} `)) return null;
  const tail = reference.slice(identity.length + 1);
  return isKnowledgeProjectReferenceTail(tail, allowInfrastructureTail) ? identity.length : null;
}

function isKnowledgeProjectReferenceTail(value: string, allowInfrastructureTail: boolean) {
  const normalized = normalizeKnowledgeScopeReference(value);
  if (!normalized) return true;
  if (assistantKnowledgeCurrentReferenceSuffixPattern.test(normalized)
    || isAssistantKnowledgeStrictReferenceTailSegment(normalized, allowInfrastructureTail)) return true;
  const tokens = normalized.split(' ');
  if (tokens.length > 20) return false;
  for (let splitIndex = 1; splitIndex < tokens.length; splitIndex += 1) {
    const left = tokens.slice(0, splitIndex).join(' ');
    const right = tokens.slice(splitIndex).join(' ');
    const leftIsCurrent = assistantKnowledgeCurrentReferenceSuffixPattern.test(left);
    const rightIsCurrent = assistantKnowledgeCurrentReferenceSuffixPattern.test(right);
    if ((leftIsCurrent && isAssistantKnowledgeStrictReferenceTailSegment(
      right,
      allowInfrastructureTail,
    )) || (rightIsCurrent && isAssistantKnowledgeStrictReferenceTailSegment(
      left,
      allowInfrastructureTail,
    ))) return true;
  }
  return false;
}

function isAssistantKnowledgeStrictReferenceTailSegment(
  value: string,
  allowInfrastructureTail: boolean,
) {
  return isAssistantKnowledgeCommercialContextClause(value, true)
    || isAssistantKnowledgeCommercialPredicateClause(value, true)
    || (allowInfrastructureTail && isAssistantKnowledgeInfrastructureReferenceTail(value));
}

function isAssistantKnowledgeInfrastructureReferenceQuery(value: string) {
  const queryPrefix = value.split(/(?:^|[^\p{L}\p{N}])жк(?:\s|$)/iu, 1)[0] ?? '';
  const rawActiveClause = queryPrefix.split(/(?:[?!.,;:\n\r…—]+|\s[-–]\s)/u).at(-1) ?? '';
  const activeClause = normalizeKnowledgeText(rawActiveClause);
  if (/(?:^|[^\p{L}\p{N}])(?:благоустройств\p{L}*|двор\p{L}*|инфраструктур\p{L}*|метро|паркинг\p{L}*|сад\p{L}*|школ\p{L}*)(?![\p{L}\p{N}])/iu.test(activeClause)) {
    return true;
  }
  return /(?:^|[^\p{L}\p{N}])(?:есть\s+ли|где|что(?:\s+есть)?)\s+(?:в|во)$/iu.test(activeClause);
}

function isAssistantKnowledgeInfrastructureReferenceTail(value: string) {
  const tokens = normalizeKnowledgeScopeReference(value).split(' ').filter(Boolean);
  if (tokens.length === 0 || tokens.length > 8) return false;
  let detailTokens = tokens;
  if (/^(?:из|по|с|со)$/u.test(tokens[0]!)) detailTokens = tokens.slice(1);
  else if (knowledgeProjectReferencePrepositionPattern.test(tokens[0]!)) return false;
  const capacityIndex = detailTokens.indexOf('на');
  if (capacityIndex >= 0) {
    const capacityTokens = detailTokens.slice(capacityIndex);
    if (capacityTokens.length !== 3
      || !/^\d{1,5}$/u.test(capacityTokens[1]!)
      || !/^мест\p{L}*$/u.test(capacityTokens[2]!)) return false;
    detailTokens = detailTokens.slice(0, capacityIndex);
  }
  return detailTokens.length > 0
    && detailTokens.some((token) => knowledgeProjectReferenceContextNounPattern.test(token))
    && detailTokens.every((token) => (
      knowledgeProjectReferenceContextNounPattern.test(token)
      || knowledgeProjectReferenceModifierPattern.test(token)
      || knowledgeProjectReferenceGrammarTokenPattern.test(token)
    ));
}

function isAssistantKnowledgeCommercialContextClause(value: string, strictTail: boolean) {
  const tokens = normalizeKnowledgeScopeReference(value).split(' ').filter(Boolean);
  if (tokens.length < 2 || tokens.length > 12) return false;
  let prepositionIndex = -1;
  for (let index = 0; index < Math.min(tokens.length, 4); index += 1) {
    const token = tokens[index]!;
    if (assistantKnowledgeCurrentSubjectTokenPattern.test(token)) {
      prepositionIndex = index + 1;
      break;
    }
    if (!knowledgeProjectReferenceModifierPattern.test(token)) break;
  }
  if (prepositionIndex === tokens.length) return true;
  if (prepositionIndex < 0) prepositionIndex = 0;
  if (knowledgeProjectReferenceQualifierLeadPattern.test(tokens[prepositionIndex]!)) {
    prepositionIndex += 1;
  }
  const qualifierPreposition = tokens[prepositionIndex]!;
  if (!knowledgeProjectReferenceQualifierPrepositionPattern.test(qualifierPreposition)) return false;
  const qualifierTokens = tokens.slice(prepositionIndex + 1);
  if (qualifierTokens.length === 0 || qualifierTokens.length > 8) return false;
  if (!strictTail) return true;
  const allowedNestedPrepositions = qualifierPreposition === 'для'
    ? new Set(['с', 'со'])
    : new Set<string>();
  if (qualifierTokens.some((token) => (
    knowledgeProjectReferenceQualifierPrepositionPattern.test(token)
      && !allowedNestedPrepositions.has(token)
  ))) return false;
  const requiredNounPattern = knowledgeProjectReferenceStrictQualifierNounByPreposition[
    qualifierPreposition
  ];
  if (!requiredNounPattern
    || !qualifierTokens.some((token) => requiredNounPattern.test(token))) return false;
  return qualifierTokens.every((token) => (
    requiredNounPattern.test(token)
    || knowledgeProjectReferenceModifierPattern.test(token)
    || knowledgeProjectReferenceQualifierFillerPattern.test(token)
    || knowledgeProjectReferenceGrammarTokenPattern.test(token)
    || allowedNestedPrepositions.has(token)
    || /^\d{1,3}$/u.test(token)
  ));
}

function isAssistantKnowledgeCommercialPredicateClause(value: string, strictTail: boolean) {
  const tokens = normalizeKnowledgeScopeReference(value).split(' ').filter(Boolean);
  if (tokens.length < 2
    || tokens.length > 8
    || !knowledgeProjectReferenceCommercialPredicatePattern.test(tokens[0]!)) return false;
  let predicateTail = tokens.slice(1);
  if (knowledgeProjectReferenceQualifierLeadPattern.test(predicateTail[0]!)) {
    predicateTail = predicateTail.slice(1);
  }
  if (predicateTail.length === 0) return false;
  if (knowledgeProjectReferenceQualifierPrepositionPattern.test(predicateTail[0]!)) {
    return isAssistantKnowledgeCommercialContextClause(predicateTail.join(' '), strictTail);
  }
  if (!strictTail) return true;
  const audienceNounPattern = knowledgeProjectReferenceStrictQualifierNounByPreposition.для;
  const allowedNestedPrepositions = new Set(['с', 'со']);
  return audienceNounPattern !== undefined
    && predicateTail.some((token) => audienceNounPattern.test(token))
    && predicateTail.every((token) => (
      audienceNounPattern.test(token)
      || knowledgeProjectReferenceModifierPattern.test(token)
      || knowledgeProjectReferenceQualifierFillerPattern.test(token)
      || allowedNestedPrepositions.has(token)
    ));
}

function isAssistantKnowledgeBoundedContextGrammar(value: string) {
  const tokens = normalizeKnowledgeScopeReference(value).split(' ').filter(Boolean);
  return tokens.length <= 12 && tokens.every((token) => (
    knowledgeProjectReferenceStopTokenPattern.test(token)
    || knowledgeProjectReferencePrepositionPattern.test(token)
    || knowledgeProjectReferenceContextNounPattern.test(token)
    || knowledgeProjectReferenceGrammarTokenPattern.test(token)
  ));
}

function isAssistantKnowledgeModifiedContextClause(value: string) {
  const tokens = normalizeKnowledgeScopeReference(value).split(' ').filter(Boolean);
  const topic = tokens.at(-1);
  if (tokens.length < 2
    || tokens.length > 12
    || !topic
    || !knowledgeProjectReferenceModifiedTopicPattern.test(topic)) return false;
  const prefix = tokens.slice(0, -1);
  let index = 0;
  while (index < prefix.length
    && (knowledgeProjectReferenceStopTokenPattern.test(prefix[index]!)
      || knowledgeProjectReferenceGrammarTokenPattern.test(prefix[index]!))) index += 1;
  if (index < prefix.length
    && knowledgeProjectReferencePrepositionPattern.test(prefix[index]!)) index += 1;
  let modifierCount = 0;
  while (index < prefix.length
    && knowledgeProjectReferenceModifierPattern.test(prefix[index]!)) {
    modifierCount += 1;
    index += 1;
  }
  return modifierCount > 0 && index === prefix.length;
}

function isScopeOnlyKnowledgeContinuation(value: string, context: AssistantPageContext | null) {
  const normalizedValue = normalizeKnowledgeScopeValue(value);
  if (isNamedObjectScopeReference(normalizedValue)) return true;
  if (!context || context.kind === 'CATALOG_FILTERS') return false;
  const normalizedLabel = normalizeKnowledgeScopeReference(context.label);
  if (!normalizedLabel) return false;
  if (normalizedValue === normalizedLabel) return true;
  return false;
}

function isNamedObjectScopeReference(normalizedValue: string) {
  if (!normalizedValue.startsWith('жк ')) return false;
  const projectLabel = normalizedValue.slice(3).trim();
  return projectLabel.length > 0
    && projectLabel.length <= 120
    && projectLabel.split(' ').length <= 6
    && !knowledgeScopeQueryCuePattern.test(projectLabel);
}

function normalizeKnowledgeScopeValue(value: string) {
  return normalizeKnowledgeScopeReference(value)
    .replace(/^(?:а\s+)?(?:в|во|для|по)\s+/u, '');
}

function extractRawAssistantKnowledgeProjectReferenceClause(value: string) {
  const rawReferenceClause = value
    .match(/(?:^|[^\p{L}\p{N}])жк\s+([^\n\r?!.,;:]{1,180})/iu)?.[1]?.trim();
  if (!rawReferenceClause) return null;
  const delimited = rawReferenceClause.match(
    /^(?:«([^»]{1,180})»|“([^”]{1,180})”|„([^“]{1,180})“|"([^"]{1,180})"|'([^']{1,180})'|\(([^)]{1,180})\))/u,
  );
  return delimited?.slice(1).find((candidate) => candidate !== undefined)?.trim()
    ?? rawReferenceClause;
}

function hasCapitalizedAssistantKnowledgeProjectReference(value: string) {
  const rawReferenceClause = extractRawAssistantKnowledgeProjectReferenceClause(value);
  return rawReferenceClause !== null
    && /^\p{Lu}/u.test(rawReferenceClause);
}

function normalizeKnowledgeScopeReference(value: string) {
  return normalizeKnowledgeText(value)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function normalizeKnowledgeText(value: string) {
  return value.toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е').replace(/\s+/gu, ' ').trim();
}

function stringifyKnowledgeValue(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
