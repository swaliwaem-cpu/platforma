import type {
  AssistantObjectResultCard,
  AssistantObjectResultsAnswer,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import { AssistantPlannerFallbackValidationError } from '../assistant-query-planner';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const architecturePattern = /архитектур\p{L}*/iu;
const infrastructurePattern = /(?:инфраструктур\p{L}*|благоустрой\p{L}*)/iu;
const fillingPattern = /(?:наполнен\p{L}*|отделк\p{L}*|интерьер\p{L}*)/iu;
const maximumDescriptionLength = 1_200;

export type AssistantObjectEvidence = {
  evidenceType: 'PLATFORMA_OBJECT';
  objectId: string;
  objectType: 'RESIDENTIAL' | 'COMMERCIAL';
  title: string;
  slug: string;
  description: string | null;
  architectureDescription: string | null;
  infrastructureDescription: string | null;
  fillingDescription: string | null;
  developer: string | null;
  districts: string[];
  metros: string[];
  completionYear: number | null;
  completionQuarter: number | null;
  propertyClass: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  pdfs: Array<{ fileId: string; title: string }>;
  updatedAt: string;
};

export type AssistantObjectAnswer = AssistantObjectResultsAnswer & { content: string };

export class AssistantObjectAnswerValidationError extends AssistantPlannerFallbackValidationError {
  constructor(code = 'ASSISTANT_OBJECT_ANSWER_EVIDENCE_INVALID') {
    super(code);
    this.name = 'AssistantObjectAnswerValidationError';
  }
}

export function buildAssistantObjectAnswer(
  rawEvidence: AssistantObjectEvidence[],
  totalObjects: number,
  query = '',
): AssistantObjectAnswer {
  if (!Number.isSafeInteger(totalObjects) || totalObjects < 0) {
    throw new AssistantObjectAnswerValidationError('ASSISTANT_OBJECT_TOTAL_INVALID');
  }
  const seen = new Set<string>();
  const evidence = rawEvidence.filter((item) => {
    if (!isValidAssistantObjectEvidence(item) || seen.has(item.objectId)) return false;
    seen.add(item.objectId);
    return true;
  });
  const selected = evidence.slice(0, 8);
  if (selected.length !== Math.min(totalObjects, 8)) {
    throw new AssistantObjectAnswerValidationError('ASSISTANT_OBJECT_TOTAL_INVALID');
  }
  const cards = selected.map((item) => createObjectCard(item, query));
  return {
    kind: 'OBJECT_RESULTS',
    content: totalObjects === 0
      ? 'Не нашёл подходящих опубликованных объектов в каталоге Platforma.'
      : totalObjects === 1
        ? 'Нашёл объект в каталоге Platforma.'
        : 'Нашёл объекты в каталоге Platforma.',
    totalObjects,
    objects: cards.slice(0, 3),
    additionalObjects: cards.slice(3, 8),
  };
}

export function validateAssistantObjectAnswer(
  answer: AssistantObjectAnswer,
  evidence: AssistantObjectEvidence[],
  totalObjects: number,
  query = '',
) {
  const expected = buildAssistantObjectAnswer(evidence, totalObjects, query);
  if (JSON.stringify(answer) !== JSON.stringify(expected)) {
    throw new AssistantObjectAnswerValidationError();
  }
}

export function isValidAssistantObjectEvidence(evidence: AssistantObjectEvidence) {
  return evidence.evidenceType === 'PLATFORMA_OBJECT'
    && uuidPattern.test(evidence.objectId)
    && (evidence.objectType === 'RESIDENTIAL' || evidence.objectType === 'COMMERCIAL')
    && boundedText(evidence.title, 300) !== null
    && boundedText(evidence.slug, 300) !== null
    && evidence.districts.every((value) => boundedText(value, 240) !== null)
    && evidence.metros.every((value) => boundedText(value, 240) !== null)
    && Number.isFinite(Date.parse(evidence.updatedAt))
    && (evidence.latitude === null || (Number.isFinite(evidence.latitude) && Math.abs(evidence.latitude) <= 90))
    && (evidence.longitude === null || (Number.isFinite(evidence.longitude) && Math.abs(evidence.longitude) <= 180));
}

function createObjectCard(
  evidence: AssistantObjectEvidence,
  query: string,
): AssistantObjectResultCard {
  const district = uniqueText(evidence.districts)[0] ?? null;
  const description = selectDescription(evidence, query);
  const facts = uniqueText([
    evidence.developer,
    evidence.metros.length > 0 ? `м. ${uniqueText(evidence.metros).join(', ')}` : null,
    formatCompletion(evidence.completionYear, evidence.completionQuarter),
    evidence.propertyClass,
    evidence.address,
  ]).slice(0, 8);
  return {
    objectId: evidence.objectId,
    objectType: evidence.objectType,
    title: evidence.title.trim(),
    subtitle: [evidence.objectType === 'RESIDENTIAL' ? 'Жилой объект' : 'Коммерческий объект', district]
      .filter((value): value is string => Boolean(value))
      .join(' · '),
    description,
    href: `/objects/${encodeURIComponent(evidence.slug.trim())}`,
    facts,
    pdfs: collectPdfs(evidence.pdfs),
  };
}

function selectDescription(evidence: AssistantObjectEvidence, query: string) {
  const preferred = architecturePattern.test(query)
    ? evidence.architectureDescription
    : infrastructurePattern.test(query)
      ? evidence.infrastructureDescription
      : fillingPattern.test(query)
        ? evidence.fillingDescription
        : evidence.description;
  return boundedText(preferred, maximumDescriptionLength)
    ?? [
      evidence.description,
      evidence.architectureDescription,
      evidence.infrastructureDescription,
      evidence.fillingDescription,
    ].map((value) => boundedText(value, maximumDescriptionLength)).find(Boolean)
    ?? 'Описание объекта в Platforma не заполнено.';
}

function collectPdfs(pdfs: AssistantObjectEvidence['pdfs']) {
  const seen = new Set<string>();
  return pdfs.flatMap((pdf) => {
    if (!uuidPattern.test(pdf.fileId) || seen.has(pdf.fileId)) return [];
    const title = boundedText(pdf.title, 240);
    if (!title) return [];
    seen.add(pdf.fileId);
    return [{
      title,
      href: `/media/files/${pdf.fileId}/content?download=true`,
    }];
  }).slice(0, 4);
}

function formatCompletion(year: number | null, quarter: number | null) {
  if (year === null) return null;
  return quarter === null ? `${year} год` : `${quarter} кв. ${year}`;
}

function boundedText(value: string | null, maximumLength: number) {
  const normalized = value?.trim().replace(/\s+/gu, ' ') ?? '';
  if (!normalized) return null;
  return normalized.slice(0, maximumLength);
}

function uniqueText(values: Array<string | null>) {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const normalized = boundedText(value, 300);
    if (!normalized) return [];
    const key = normalized.toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е');
    if (seen.has(key)) return [];
    seen.add(key);
    return [normalized];
  });
}
