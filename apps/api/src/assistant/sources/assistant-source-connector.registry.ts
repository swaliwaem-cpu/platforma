import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { readAssistantCurrentFactRefreshMode } from '../assistant-runtime-config';
import {
  OfficialHtmlSourceConnector,
  SourceConnectorError,
  type SourceConnectorFetchResult,
  type SourceConnectorRegistryEntry,
} from './official-html-source.connector';

export type AssistantSourceConnector = {
  fetch(source: SourceConnectorRegistryEntry): Promise<SourceConnectorFetchResult>;
};

const connectorDefinitions = [
  { key: 'OFFICIAL_HTML', enabled: true },
  { key: 'CIAN', enabled: false },
  { key: 'DOMCLICK', enabled: false },
  { key: 'YANDEX_REALTY', enabled: false },
  { key: 'NOVOSTROY_M', enabled: false },
] as const;

@Injectable()
export class AssistantSourceConnectorRegistry {
  private readonly offlineFixture = new OfflineFixtureSourceConnector();

  constructor(
    private readonly officialHtml = createOfficialHtmlConnector(),
    private readonly environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  ) {}

  list() {
    return connectorDefinitions.map((definition) => ({ ...definition }));
  }

  get(key: string): AssistantSourceConnector {
    const definition = connectorDefinitions.find((candidate) => candidate.key === key);
    if (!definition) throw new SourceConnectorError('SOURCE_CONNECTOR_UNSUPPORTED', false);
    if (!definition.enabled) throw new SourceConnectorError('SOURCE_CONNECTOR_DISABLED', false);
    return readAssistantCurrentFactRefreshMode(this.environment) === 'fixture'
      ? this.offlineFixture
      : this.officialHtml;
  }
}

class OfflineFixtureSourceConnector implements AssistantSourceConnector {
  async fetch(source: SourceConnectorRegistryEntry): Promise<SourceConnectorFetchResult> {
    const fixture = readOfflineFixture(source);
    const externalLots = fixture.externalLots.map((lot) => ({
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: lot.title,
      url: lot.href,
      offers: {
        '@type': 'Offer',
        price: String(lot.priceRub),
        priceCurrency: 'RUB',
        availability: 'https://schema.org/InStock',
        url: lot.href,
      },
      numberOfRooms: lot.rooms,
      floorSize: { '@type': 'QuantitativeValue', value: lot.area, unitCode: 'MTK' },
      floorLevel: lot.floor,
    }));
    const payload = Buffer.from([
      '<!doctype html><html lang="ru"><head><meta charset="utf-8">',
      `<title>${escapeHtml(fixture.title)}</title>`,
      externalLots.length === 0 ? '' : `<script type="application/ld+json">${escapeJsonForHtml(
        JSON.stringify(externalLots.length === 1 ? externalLots[0] : externalLots),
      )}</script>`,
      '</head><body><main>',
      `<h1>${escapeHtml(fixture.title)}</h1>`,
      ...fixture.sections.map(({ label, value }) => (
        `<section><h2>${escapeHtml(label)}</h2><p>${escapeHtml(value)}</p></section>`
      )),
      ...fixture.promotions.map(({ label, value }) => (
        `<section class="promotion"><h2>${escapeHtml(label)}</h2><p>${escapeHtml(value)}</p></section>`
      )),
      '</main></body></html>',
    ].join(''), 'utf8');
    const checksum = createHash('sha256').update(payload).digest('hex');
    return {
      finalUrl: source.canonicalUrl,
      statusCode: 200,
      contentType: 'text/html; charset=utf-8',
      checksum,
      payload,
      etag: `"fixture-${checksum}"`,
      lastModified: null,
      redirects: [],
    };
  }
}

function readOfflineFixture(source: SourceConnectorRegistryEntry) {
  if (source.connectorKey !== 'OFFICIAL_HTML' || !isRecord(source.connectorConfig)) {
    throw new SourceConnectorError('SOURCE_FIXTURE_INVALID', false);
  }
  let canonicalUrl: URL;
  try {
    canonicalUrl = new URL(source.canonicalUrl);
  } catch {
    throw new SourceConnectorError('SOURCE_FIXTURE_INVALID', false);
  }
  const config = source.connectorConfig;
  const allowedHosts = Array.isArray(config.allowedHosts) ? config.allowedHosts : [];
  const fixture = config.offlineFixture;
  if (canonicalUrl.protocol !== 'https:' || canonicalUrl.username || canonicalUrl.password
    || canonicalUrl.hash || !allowedHosts.some((host) => typeof host === 'string'
      && host.trim().toLocaleLowerCase('en-US') === canonicalUrl.hostname.toLocaleLowerCase('en-US'))
    || !isRecord(fixture)
    || Object.keys(fixture).some((key) => ![
      'version', 'title', 'sections', 'promotions', 'externalLots',
    ].includes(key))
    || fixture.version !== 'assistant-current-fact-fixture-v1'
    || !isBoundedString(fixture.title, 200)
    || !Array.isArray(fixture.promotions)
    || fixture.promotions.length < 1
    || fixture.promotions.length > 50
    || fixture.sections !== undefined && (!Array.isArray(fixture.sections)
      || fixture.sections.length > 20)
    || fixture.externalLots !== undefined && (!Array.isArray(fixture.externalLots)
      || fixture.externalLots.length > 20)) {
    throw new SourceConnectorError('SOURCE_FIXTURE_INVALID', false);
  }
  const promotions = fixture.promotions.map((promotion) => {
    if (!isRecord(promotion)
      || Object.keys(promotion).some((key) => !['label', 'value'].includes(key))
      || !isBoundedString(promotion.label, 300)
      || !isBoundedString(promotion.value, 2_000)) {
      throw new SourceConnectorError('SOURCE_FIXTURE_INVALID', false);
    }
    return { label: promotion.label.trim(), value: promotion.value.trim() };
  });
  const sections = (fixture.sections ?? []).map((section) => {
    if (!isRecord(section)
      || Object.keys(section).some((key) => !['label', 'value'].includes(key))
      || !isBoundedString(section.label, 300)
      || !isBoundedString(section.value, 2_000)) {
      throw new SourceConnectorError('SOURCE_FIXTURE_INVALID', false);
    }
    return { label: section.label.trim(), value: section.value.trim() };
  });
  const externalLots = (fixture.externalLots ?? []).map((lot) => readOfflineFixtureLot(lot, allowedHosts));
  return { title: fixture.title.trim(), sections, promotions, externalLots };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]!);
}

function escapeJsonForHtml(value: string) {
  return value.replace(/</gu, '\\u003c');
}

function readOfflineFixtureLot(value: unknown, allowedHosts: unknown[]) {
  if (!isRecord(value)
    || Object.keys(value).some((key) => ![
      'title', 'priceRub', 'rooms', 'area', 'floor', 'href',
    ].includes(key))
    || !isBoundedString(value.title, 300)
    || typeof value.priceRub !== 'number' || !Number.isSafeInteger(value.priceRub) || value.priceRub < 1
    || typeof value.rooms !== 'number' || !Number.isSafeInteger(value.rooms)
    || value.rooms < 0 || value.rooms > 20
    || typeof value.area !== 'number' || !Number.isFinite(value.area) || value.area <= 0
    || typeof value.floor !== 'number' || !Number.isSafeInteger(value.floor)
    || value.floor < -20 || value.floor > 500
    || !isBoundedString(value.href, 2_048)) {
    throw new SourceConnectorError('SOURCE_FIXTURE_INVALID', false);
  }
  let href: URL;
  try {
    href = new URL(value.href);
  } catch {
    throw new SourceConnectorError('SOURCE_FIXTURE_INVALID', false);
  }
  if (href.protocol !== 'https:' || href.username || href.password || href.hash
    || !allowedHosts.some((host) => typeof host === 'string'
      && host.trim().toLocaleLowerCase('en-US') === href.hostname.toLocaleLowerCase('en-US'))) {
    throw new SourceConnectorError('SOURCE_FIXTURE_INVALID', false);
  }
  return {
    title: value.title.trim(),
    priceRub: value.priceRub,
    rooms: value.rooms,
    area: value.area,
    floor: value.floor,
    href: href.toString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximumLength;
}

function createOfficialHtmlConnector(environment: NodeJS.ProcessEnv = process.env) {
  const allowPrivateTestUrls = environment.NODE_ENV === 'test'
    && environment.ASSISTANT_SOURCE_ALLOW_PRIVATE_TEST_URLS === 'true';
  return new OfficialHtmlSourceConnector({
    allowHttp: allowPrivateTestUrls,
    allowPrivateNetwork: allowPrivateTestUrls,
    timeoutMs: readInteger(environment.ASSISTANT_SOURCE_FETCH_TIMEOUT_MS, 10_000, 100, 120_000),
    maxResponseBytes: readInteger(
      environment.ASSISTANT_SOURCE_MAX_RESPONSE_BYTES,
      5 * 1024 * 1024,
      1_024,
      25 * 1024 * 1024,
    ),
    maxRedirects: readInteger(environment.ASSISTANT_SOURCE_MAX_REDIRECTS, 3, 0, 10),
  });
}

function readInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new SourceConnectorError('SOURCE_CONNECTOR_CONFIG_INVALID', false);
  }
  return parsed;
}
