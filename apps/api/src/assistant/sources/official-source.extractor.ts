import { createHash } from 'node:crypto';

import { load, type CheerioAPI } from 'cheerio';
import { Injectable } from '@nestjs/common';

const maximumChunkCharacters = 1_200;
const promotionPattern = /(?:ипотек|рассроч|скидк|бонус|акци)/iu;

export type ExtractableKnowledgeSource = {
  id: string;
  type: string;
  canonicalUrl: string;
  projectKey: string | null;
  developerKey: string | null;
  priority: number;
  connectorConfig: unknown;
};

export type ExtractedSourceFact = {
  kind: 'STATIC_DESCRIPTION' | 'ARCHITECTURE' | 'INFRASTRUCTURE' | 'PROMOTION' | 'EXTERNAL_LOT';
  label: string;
  value: unknown;
  searchText: string;
  canonicalUrl: string;
  observedAt: Date;
  validFrom: Date | null;
};

export type ExtractedSourceChunk = {
  sourceRevisionId: string;
  ordinal: number;
  text: string;
  contentHash: string;
};

@Injectable()
export class OfficialSourceExtractor {
  extract(input: {
    source: ExtractableKnowledgeSource;
    revisionId: string;
    fetchedAt: Date;
    contentType: string;
    payload: Buffer;
  }): { facts: ExtractedSourceFact[]; chunks: ExtractedSourceChunk[] } {
    const text = input.payload.toString('utf8');
    if (input.contentType === 'application/json' || input.contentType === 'application/ld+json') {
      const documents = parseJsonDocuments([text]);
      return {
        facts: this.extractJsonLdFacts(documents, input.source, input.fetchedAt),
        chunks: createChunks(
          documents.flatMap((document) => collectJsonText(document)),
          input.revisionId,
        ),
      };
    }

    const $ = load(text);
    const jsonDocuments = parseJsonDocuments(
      $('script[type="application/ld+json"]').map((_index, element) => $(element).text()).get(),
    );
    const facts = [
      ...this.extractHtmlFacts($, input.source, input.fetchedAt),
      ...this.extractJsonLdFacts(jsonDocuments, input.source, input.fetchedAt),
    ];
    $('script,style,noscript,template,svg,canvas,iframe,form,nav,header,footer,aside,[role="navigation"],[class*="cookie" i],[id*="cookie" i]').remove();
    const semanticText = $('main h1,main h2,main h3,main p,main li,article h1,article h2,article h3,article p,article li')
      .map((_index, element) => normalizeText($(element).text()))
      .get();
    const fallbackText = semanticText.length > 0 ? semanticText : [normalizeText($('body').text())];

    return {
      facts: deduplicateFacts(facts),
      chunks: createChunks(fallbackText, input.revisionId),
    };
  }

  private extractHtmlFacts($: CheerioAPI, source: ExtractableKnowledgeSource, fetchedAt: Date) {
    const facts: ExtractedSourceFact[] = [];
    const title = normalizeText($('h1').first().text()) || normalizeText($('title').text()) || 'Официальный источник';
    const description = normalizeText(
      $('meta[property="og:description"]').attr('content')
      ?? $('meta[name="description"]').attr('content')
      ?? '',
    );
    if (description) {
      facts.push(createFact('STATIC_DESCRIPTION', title, description, source.canonicalUrl, fetchedAt));
    }

    $('h1,h2,h3,h4').each((_index, heading) => {
      const label = normalizeText($(heading).text());
      if (!label) return;
      const content = normalizeText($(heading).nextUntil('h1,h2,h3,h4').text())
        || normalizeText($(heading).parent().text());
      if (!content || content === label) return;
      if (/архитектур/iu.test(label)) {
        facts.push(createFact('ARCHITECTURE', label, content, source.canonicalUrl, fetchedAt));
      } else if (/инфраструктур|благоустрой|двор/iu.test(label)) {
        facts.push(createFact('INFRASTRUCTURE', label, content, source.canonicalUrl, fetchedAt));
      } else if (promotionPattern.test(label) || promotionPattern.test(content)) {
        facts.push(createFact('PROMOTION', label, content, source.canonicalUrl, fetchedAt));
      }
    });
    return facts;
  }

  private extractJsonLdFacts(
    documents: unknown[],
    source: ExtractableKnowledgeSource,
    fetchedAt: Date,
  ) {
    const facts: ExtractedSourceFact[] = [];
    for (const node of documents.flatMap((document) => flattenJsonLd(document))) {
      if (!isRecord(node)) continue;
      const description = readText(node.description);
      const name = readText(node.name) ?? 'Официальный источник';
      if (description && isStaticJsonLdType(node['@type'])) {
        facts.push(createFact('STATIC_DESCRIPTION', name, description, source.canonicalUrl, fetchedAt));
      }
      const lot = readExternalLot(node, source);
      if (lot) {
        facts.push({
          kind: 'EXTERNAL_LOT',
          label: lot.title,
          value: lot,
          searchText: normalizeText([
            lot.title,
            lot.rooms === null ? '' : `${lot.rooms} комнаты`,
            lot.area === null ? '' : `${lot.area} м²`,
            lot.floor === null ? '' : `${lot.floor} этаж`,
            `${lot.priceRub} RUB`,
          ].join(' ')),
          canonicalUrl: lot.href,
          observedAt: fetchedAt,
          validFrom: null,
        });
      }
    }
    return facts;
  }
}

function createFact(
  kind: ExtractedSourceFact['kind'],
  label: string,
  value: string,
  canonicalUrl: string,
  observedAt: Date,
): ExtractedSourceFact {
  return {
    kind,
    label: normalizeText(label),
    value: normalizeText(value),
    searchText: normalizeText(`${label} ${value}`),
    canonicalUrl,
    observedAt,
    validFrom: null,
  };
}

function readExternalLot(node: Record<string, unknown>, source: ExtractableKnowledgeSource) {
  const offers = Array.isArray(node.offers) ? node.offers : [node.offers];
  for (const rawOffer of offers) {
    if (!isRecord(rawOffer)) continue;
    const priceRub = readPositiveNumber(rawOffer.price ?? node.price);
    const currency = readText(rawOffer.priceCurrency ?? node.priceCurrency)?.toLocaleUpperCase('en-US');
    const rawHref = readText(rawOffer.url ?? node.url);
    if (priceRub === null || (currency && currency !== 'RUB') || !rawHref) continue;
    const href = resolveAllowedOfficialUrl(rawHref, source);
    if (!href) continue;
    const title = readText(node.name) ?? readText(rawOffer.name);
    if (!title) continue;
    const availabilityValue = readText(rawOffer.availability)?.toLocaleLowerCase('en-US') ?? '';
    if (availabilityValue && !availabilityValue.includes('instock') && !availabilityValue.includes('limitedavailability')) {
      continue;
    }
    return {
      title,
      priceRub,
      availability: 'AVAILABLE' as const,
      rooms: readNonNegativeInteger(node.numberOfRooms ?? node.numberOfBedrooms),
      area: readArea(node.floorSize),
      floor: readIntegerInRange(node.floorLevel, -20, 500),
      href,
    };
  }
  return null;
}

function resolveAllowedOfficialUrl(value: string, source: ExtractableKnowledgeSource) {
  let url: URL;
  const canonical = new URL(source.canonicalUrl);
  try {
    url = new URL(value, canonical);
  } catch {
    return null;
  }
  const allowedHosts = new Set([canonical.hostname.toLocaleLowerCase('en-US')]);
  if (isRecord(source.connectorConfig) && Array.isArray(source.connectorConfig.allowedHosts)) {
    source.connectorConfig.allowedHosts.forEach((host) => {
      if (typeof host === 'string') allowedHosts.add(host.trim().toLocaleLowerCase('en-US'));
    });
  }
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash
    && allowedHosts.has(url.hostname.toLocaleLowerCase('en-US'))
    ? url.toString()
    : null;
}

function parseJsonDocuments(values: string[]) {
  return values.flatMap((value) => {
    try {
      return [JSON.parse(value) as unknown];
    } catch {
      return [];
    }
  });
}

function flattenJsonLd(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap((item) => flattenJsonLd(item));
  if (!isRecord(value)) return [];
  const graph = Array.isArray(value['@graph']) ? value['@graph'].flatMap((item) => flattenJsonLd(item)) : [];
  return [value, ...graph];
}

function collectJsonText(value: unknown): string[] {
  if (typeof value === 'string') return [normalizeText(value)];
  if (Array.isArray(value)) return value.flatMap((item) => collectJsonText(item));
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, item]) => key.startsWith('@') ? [] : collectJsonText(item));
}

function createChunks(values: string[], sourceRevisionId: string): ExtractedSourceChunk[] {
  const normalized = [...new Set(values.map(normalizeText).filter((value) => value.length >= 20))];
  const chunks: string[] = [];
  let current = '';
  for (const value of normalized) {
    if (value.length > maximumChunkCharacters) {
      if (current) chunks.push(current);
      current = '';
      for (let offset = 0; offset < value.length; offset += maximumChunkCharacters) {
        chunks.push(value.slice(offset, offset + maximumChunkCharacters));
      }
      continue;
    }
    const candidate = current ? `${current}\n${value}` : value;
    if (candidate.length > maximumChunkCharacters) {
      chunks.push(current);
      current = value;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks.map((text, ordinal) => ({
    sourceRevisionId,
    ordinal,
    text,
    contentHash: createHash('sha256').update(text).digest('hex'),
  }));
}

function deduplicateFacts(facts: ExtractedSourceFact[]) {
  const seen = new Set<string>();
  return facts.filter((fact) => {
    const key = `${fact.kind}:${fact.canonicalUrl}:${JSON.stringify(fact.value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readArea(value: unknown) {
  return isRecord(value) ? readPositiveNumber(value.value) : readPositiveNumber(value);
}

function readPositiveNumber(value: unknown) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.replace(/\s+/gu, '').replace(',', '.')) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function readNonNegativeInteger(value: unknown) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 20 ? parsed : null;
}

function readIntegerInRange(value: unknown, minimum: number, maximum: number) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function readText(value: unknown) {
  return typeof value === 'string' && normalizeText(value) ? normalizeText(value) : null;
}

function isStaticJsonLdType(value: unknown) {
  const types = Array.isArray(value) ? value : [value];
  return types.some((item) => typeof item === 'string'
    && ['Product', 'Apartment', 'Residence', 'Place', 'Organization'].includes(item));
}

function normalizeText(value: string) {
  return value.replace(/\u00a0/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
