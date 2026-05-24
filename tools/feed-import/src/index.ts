import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { XMLParser } from 'fast-xml-parser';

import { loadFeedImportConfig } from './env';
import {
  GeneratedImageVariant,
  generateImageVariants,
  isImageVariantSourceMimeType,
} from './image-variants';
import { FeedImportStorage } from './storage';

type FeedImportCommand = 'preview' | 'run';

export type NormalizedFeedUnitType = 'RESIDENTIAL' | 'COMMERCIAL';
export type NormalizedFeedUnitStatus = 'AVAILABLE' | 'BOOKED' | 'RESERVED' | 'SOLD' | 'ARCHIVED' | 'UNKNOWN';

export type FeedParserWarning = {
  code: string;
  message: string;
  externalId?: string;
  field?: string;
  value?: unknown;
};

export type FeedStatusNormalizationResult = {
  status: NormalizedFeedUnitStatus;
  warning?: FeedParserWarning;
};

export type NormalizedFeedMedia = {
  sourceUrl: string;
  sortOrder: number;
  label: string | null;
};

export type NormalizedResidentialUnitDetails = {
  apartmentNumber: string | null;
  layoutType: string | null;
  livingArea: string | null;
  kitchenArea: string | null;
  balconyCount: number | null;
  detailsJson: Record<string, unknown>;
};

export type NormalizedCommercialUnitDetails = {
  commercialType: string | null;
  entrance: string | null;
  ceilingHeight: string | null;
  powerKw: string | null;
  separateEntrance: boolean | null;
  detailsJson: Record<string, unknown>;
};

export type NormalizedFeedUnit = {
  externalId: string;
  type: NormalizedFeedUnitType;
  status: NormalizedFeedUnitStatus;
  title: string | null;
  address: string | null;
  building: string | null;
  section: string | null;
  floor: number | null;
  rooms: number | null;
  price: string | null;
  currency: string | null;
  area: string | null;
  pricePerMeter: string | null;
  completionYear: number | null;
  completionQuarter: number | null;
  rawPayload: Record<string, unknown>;
  media: NormalizedFeedMedia[];
  residentialDetails: NormalizedResidentialUnitDetails | null;
  commercialDetails: NormalizedCommercialUnitDetails | null;
};

export type FeedParseResult = {
  units: NormalizedFeedUnit[];
  warnings: FeedParserWarning[];
};

export interface FeedParser {
  parse(xml: string): FeedParseResult;
}

type XmlRecord = Record<string, unknown>;

type FeedFetchResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
};

type FeedFetch = (url: string, init?: RequestInit) => Promise<FeedFetchResponse>;

type FeedMediaFetchResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  headers?: {
    get: (name: string) => string | null;
  };
  arrayBuffer: () => Promise<ArrayBuffer>;
};

type FeedMediaFetch = (url: string, init?: RequestInit) => Promise<FeedMediaFetchResponse>;

const textNodeName = '#text';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName,
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

export function isXmlParserAvailable() {
  return typeof XMLParser === 'function';
}

export function parseFeedImportCommand(value: string | undefined): FeedImportCommand | null {
  if (value === 'preview' || value === 'run') {
    return value;
  }

  return null;
}

export async function loadXmlFromUrl(url: string, fetchImpl: FeedFetch = getGlobalFetch()) {
  const feedUrl = new URL(url);
  const response = await fetchImpl(feedUrl.toString(), {
    headers: {
      accept: 'application/xml,text/xml,*/*',
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to download feed XML from ${feedUrl.toString()}: ${response.status} ${response.statusText}`,
    );
  }

  return response.text();
}

export function normalizeFeedUnitStatus(value: unknown): FeedStatusNormalizationResult {
  const normalized = getText(value)?.toLowerCase();

  if (normalized === 'free' || normalized === 'available') {
    return { status: 'AVAILABLE' };
  }

  if (normalized === 'booked') {
    return { status: 'BOOKED' };
  }

  if (normalized === 'reserved') {
    return { status: 'RESERVED' };
  }

  if (normalized === 'sold') {
    return { status: 'SOLD' };
  }

  if (normalized === 'archived' || normalized === 'archive') {
    return { status: 'ARCHIVED' };
  }

  return {
    status: 'UNKNOWN',
    warning: {
      code: 'UNKNOWN_STATUS',
      field: 'status',
      message: `Unknown feed unit status: ${normalized ?? 'empty'}`,
      value: normalized ?? null,
    },
  };
}

export class YandexRealtyFeedParser implements FeedParser {
  parse(xml: string): FeedParseResult {
    const root = parseXml(xml);
    const feed = asRecord(root['realty-feed']);

    if (!feed) {
      throw new Error('Yandex Realty feed must contain <realty-feed>');
    }

    const warnings: FeedParserWarning[] = [];
    const units = toArray(feed.offer)
      .map(asRecord)
      .filter((offer): offer is XmlRecord => offer !== null)
      .flatMap((offer, index) => {
        const externalId = getText(offer['@_internal-id']);

        if (!externalId) {
          warnings.push({
            code: 'MISSING_EXTERNAL_ID',
            field: 'externalId',
            message: `Yandex offer at index ${index} is missing internal-id`,
          });
          return [];
        }

        return [this.normalizeOffer(offer, externalId, warnings)];
      });

    return { units, warnings };
  }

  private normalizeOffer(offer: XmlRecord, externalId: string, warnings: FeedParserWarning[]): NormalizedFeedUnit {
    const location = asRecord(offer.location);
    const price = normalizeDecimal(offer.price, 'price', externalId, warnings);
    const area = normalizeDecimal(offer.area, 'area', externalId, warnings);
    const floor = normalizeInteger(offer.floor, 'floor', externalId, warnings);
    const rooms = normalizeInteger(offer.rooms, 'rooms', externalId, warnings);
    const completionYear = normalizeInteger(offer['built-year'], 'completionYear', externalId, warnings);
    const completionQuarter = normalizeQuarter(offer['ready-quarter'], externalId, warnings);
    const livingArea = normalizeDecimal(offer['living-space'], 'livingArea', externalId, warnings);

    return {
      externalId,
      type: getYandexUnitType(offer),
      status: 'AVAILABLE',
      title: buildYandexTitle(offer, location),
      address: getText(location?.address),
      building: getText(offer['building-name']),
      section: getText(offer['building-section']),
      floor,
      rooms,
      price,
      currency: getText(asRecord(offer.price)?.currency),
      area,
      pricePerMeter: calculatePricePerMeter(price, area),
      completionYear,
      completionQuarter,
      rawPayload: offer,
      media: collectYandexMedia(offer, externalId, warnings),
      residentialDetails:
        getYandexUnitType(offer) === 'RESIDENTIAL'
          ? {
              apartmentNumber: getText(location?.apartment),
              layoutType: getText(offer['rooms-type']),
              livingArea,
              kitchenArea: normalizeDecimal(offer['kitchen-space'], 'kitchenArea', externalId, warnings),
              balconyCount: normalizeInteger(offer.balconies, 'balconyCount', externalId, warnings),
              detailsJson: {
                buildingType: getText(offer['building-type']),
                ceilingHeight: normalizeDecimal(offer['ceiling-height'], 'ceilingHeight', externalId, warnings),
                renovation: getText(offer.renovation),
                yandexBuildingId: getText(offer['yandex-building-id']),
                yandexHouseId: getText(offer['yandex-house-id']),
              },
            }
          : null,
      commercialDetails:
        getYandexUnitType(offer) === 'COMMERCIAL'
          ? {
              commercialType: getText(offer.category),
              entrance: null,
              ceilingHeight: normalizeDecimal(offer['ceiling-height'], 'ceilingHeight', externalId, warnings),
              powerKw: null,
              separateEntrance: null,
              detailsJson: {
                buildingType: getText(offer['building-type']),
                propertyType: getText(offer['property-type']),
                renovation: getText(offer.renovation),
              },
            }
          : null,
    };
  }
}

export class CianXmlFeedParser implements FeedParser {
  parse(xml: string): FeedParseResult {
    const root = parseXml(xml);
    const feed = asRecord(root.feed);

    if (!feed) {
      throw new Error('Cian XML feed must contain <feed>');
    }

    const warnings: FeedParserWarning[] = [];
    const units = toArray(feed.object)
      .map(asRecord)
      .filter((object): object is XmlRecord => object !== null)
      .flatMap((object, index) => {
        const externalId = getText(object.ExternalId);

        if (!externalId) {
          warnings.push({
            code: 'MISSING_EXTERNAL_ID',
            field: 'externalId',
            message: `Cian object at index ${index} is missing ExternalId`,
          });
          return [];
        }

        return [this.normalizeObject(object, externalId, warnings)];
      });

    return { units, warnings };
  }

  private normalizeObject(object: XmlRecord, externalId: string, warnings: FeedParserWarning[]): NormalizedFeedUnit {
    const building = asRecord(object.Building);
    const bargainTerms = asRecord(object.BargainTerms);
    const statusResult = normalizeFeedUnitStatus(asRecord(object.Booking)?.Status);

    if (statusResult.warning) {
      warnings.push(withExternalId(statusResult.warning, externalId));
    }

    const price = normalizeDecimal(bargainTerms?.Price, 'price', externalId, warnings);
    const floor = normalizeInteger(object.FloorNumber, 'floor', externalId, warnings);
    const area = normalizeDecimal(object.TotalArea, 'area', externalId, warnings);
    const ceilingHeight = normalizeDecimal(building?.CeilingHeight, 'ceilingHeight', externalId, warnings);
    const powerKw = normalizeDecimal(object.Power, 'powerKw', externalId, warnings);
    const type = getCianUnitType(object);

    return {
      externalId,
      type,
      status: statusResult.status,
      title: buildCianTitle(object),
      address: getText(object.Address),
      building: getText(building?.Name),
      section: getText(object.Section),
      floor,
      rooms: normalizeInteger(object.RoomsCount, 'rooms', externalId, warnings),
      price,
      currency: getText(bargainTerms?.Currency),
      area,
      pricePerMeter: calculatePricePerMeter(price, area),
      completionYear: normalizeInteger(object.CompletionYear, 'completionYear', externalId, warnings),
      completionQuarter: normalizeQuarter(object.CompletionQuarter, externalId, warnings),
      rawPayload: object,
      media: collectCianMedia(object, externalId, warnings),
      residentialDetails:
        type === 'RESIDENTIAL'
          ? {
              apartmentNumber: getText(object.FlatNumber),
              layoutType: getText(object.Layout),
              livingArea: normalizeDecimal(object.LivingArea, 'livingArea', externalId, warnings),
              kitchenArea: normalizeDecimal(object.KitchenArea, 'kitchenArea', externalId, warnings),
              balconyCount: normalizeInteger(object.BalconiesCount, 'balconyCount', externalId, warnings),
              detailsJson: {
                propertyType: getText(object.PropertyType),
                category: getText(object.Category),
                conditionType: getText(object.ConditionType),
              },
            }
          : null,
      commercialDetails:
        type === 'COMMERCIAL'
          ? {
              commercialType: getText(object.Category),
              entrance: getText(object.Entrance),
              ceilingHeight,
              powerKw,
              separateEntrance: normalizeBoolean(object.HasSeparateEntrance),
              detailsJson: {
                propertyType: getText(object.PropertyType),
                category: getText(object.Category),
                conditionType: getText(object.ConditionType),
                layout: getText(object.Layout),
                buildingType: getText(building?.Type),
              },
            }
          : null,
    };
  }
}

function getGlobalFetch(): FeedFetch {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('Global fetch is unavailable for feed XML download');
  }

  return globalThis.fetch.bind(globalThis) as FeedFetch;
}

function parseXml(xml: string): XmlRecord {
  const parsed = parser.parse(xml.replace(/^\uFEFF/, ''));
  const root = asRecord(parsed);

  if (!root) {
    throw new Error('Feed XML must parse into an object');
  }

  return root;
}

function asRecord(value: unknown): XmlRecord | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as XmlRecord;
  }

  return null;
}

function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null || value === '') {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function getText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  const record = asRecord(value);

  if (record) {
    return getText(record[textNodeName]);
  }

  return null;
}

function normalizeDecimal(
  value: unknown,
  field: string,
  externalId: string,
  warnings: FeedParserWarning[],
): string | null {
  const raw = getDecimalText(value);

  if (raw === null) {
    return null;
  }

  const normalized = raw.replace(/\s+/g, '').replace(',', '.');
  const numeric = Number(normalized);

  if (!Number.isFinite(numeric)) {
    warnings.push({
      code: 'INVALID_DECIMAL',
      externalId,
      field,
      message: `Invalid decimal value for ${field}: ${raw}`,
      value: raw,
    });
    return null;
  }

  return formatDecimal(numeric);
}

function getDecimalText(value: unknown): string | null {
  const record = asRecord(value);

  if (record && 'value' in record) {
    return getText(record.value);
  }

  return getText(value);
}

function normalizeInteger(
  value: unknown,
  field: string,
  externalId: string,
  warnings: FeedParserWarning[],
): number | null {
  const raw = getText(value);

  if (raw === null) {
    return null;
  }

  const normalized = raw.replace(/\s+/g, '');
  const numeric = Number(normalized);

  if (!Number.isInteger(numeric)) {
    warnings.push({
      code: 'INVALID_INTEGER',
      externalId,
      field,
      message: `Invalid integer value for ${field}: ${raw}`,
      value: raw,
    });
    return null;
  }

  return numeric;
}

function normalizeQuarter(value: unknown, externalId: string, warnings: FeedParserWarning[]): number | null {
  const quarter = normalizeInteger(value, 'completionQuarter', externalId, warnings);

  if (quarter === null) {
    return null;
  }

  if (quarter < 1 || quarter > 4) {
    warnings.push({
      code: 'INVALID_QUARTER',
      externalId,
      field: 'completionQuarter',
      message: `Invalid completion quarter: ${quarter}`,
      value: quarter,
    });
    return null;
  }

  return quarter;
}

function normalizeBoolean(value: unknown): boolean | null {
  const text = getText(value)?.toLowerCase();

  if (text === 'true' || text === '1' || text === 'yes') {
    return true;
  }

  if (text === 'false' || text === '0' || text === 'no') {
    return false;
  }

  return null;
}

function formatDecimal(value: number): string {
  return value.toFixed(2);
}

function calculatePricePerMeter(price: string | null, area: string | null): string | null {
  if (!price || !area) {
    return null;
  }

  const priceNumber = Number(price);
  const areaNumber = Number(area);

  if (!Number.isFinite(priceNumber) || !Number.isFinite(areaNumber) || areaNumber <= 0) {
    return null;
  }

  return formatDecimal(priceNumber / areaNumber);
}

function withExternalId(warning: FeedParserWarning, externalId: string): FeedParserWarning {
  return {
    ...warning,
    externalId,
  };
}

function getYandexUnitType(offer: XmlRecord): NormalizedFeedUnitType {
  const propertyType = getText(offer['property-type'])?.toLowerCase() ?? '';
  const category = getText(offer.category)?.toLowerCase() ?? '';

  if (
    propertyType.includes('коммер') ||
    category.includes('коммер') ||
    category.includes('офис') ||
    category.includes('помещ')
  ) {
    return 'COMMERCIAL';
  }

  return 'RESIDENTIAL';
}

function getCianUnitType(object: XmlRecord): NormalizedFeedUnitType {
  const propertyType = getText(object.PropertyType)?.toLowerCase() ?? '';
  const category = getText(object.Category)?.toLowerCase() ?? '';

  if (
    propertyType.includes('flat') ||
    propertyType.includes('apartment') ||
    category.includes('flat') ||
    category.includes('apartment') ||
    category.includes('living')
  ) {
    return 'RESIDENTIAL';
  }

  return 'COMMERCIAL';
}

function buildYandexTitle(offer: XmlRecord, location: XmlRecord | null): string | null {
  const building = getText(offer['building-name']);
  const category = getText(offer.category);
  const apartment = getText(location?.apartment);

  return joinTitleParts([building, category, apartment ? `№ ${apartment}` : null]);
}

function buildCianTitle(object: XmlRecord): string | null {
  return joinTitleParts([getText(object.Address), getText(object.Category), getText(object.ExternalId)]);
}

function joinTitleParts(parts: Array<string | null>): string | null {
  const title = parts.filter((part): part is string => Boolean(part)).join(', ');
  return title.length > 0 ? title : null;
}

function collectYandexMedia(
  offer: XmlRecord,
  externalId: string,
  warnings: FeedParserWarning[],
): NormalizedFeedMedia[] {
  const media: NormalizedFeedMedia[] = [];
  const seen = new Set<string>();

  for (const image of toArray(offer.image)) {
    const record = asRecord(image);
    const sourceUrl = record ? getText(record[textNodeName]) : getText(image);
    const label = getText(record?.['@_tag']);
    addMedia(media, seen, sourceUrl, label, externalId, warnings);
  }

  return media;
}

function collectCianMedia(
  object: XmlRecord,
  externalId: string,
  warnings: FeedParserWarning[],
): NormalizedFeedMedia[] {
  const media: NormalizedFeedMedia[] = [];
  const seen = new Set<string>();
  const layoutPhoto = asRecord(object.LayoutPhoto);

  addMedia(media, seen, getText(layoutPhoto?.FullUrl), 'layout-photo', externalId, warnings);

  const photos = asRecord(object.Photos);
  for (const photo of toArray(photos?.PhotoSchema)) {
    const photoRecord = asRecord(photo);
    addMedia(media, seen, getText(photoRecord?.FullUrl), 'photo', externalId, warnings);
  }

  return media;
}

function addMedia(
  media: NormalizedFeedMedia[],
  seen: Set<string>,
  sourceUrl: string | null,
  label: string | null,
  externalId: string,
  warnings: FeedParserWarning[],
) {
  if (!sourceUrl) {
    return;
  }

  if (!isHttpUrl(sourceUrl)) {
    warnings.push({
      code: 'INVALID_MEDIA_URL',
      externalId,
      field: 'media',
      message: `Invalid media URL: ${sourceUrl}`,
      value: sourceUrl,
    });
    return;
  }

  if (seen.has(sourceUrl)) {
    return;
  }

  seen.add(sourceUrl);
  media.push({
    sourceUrl,
    sortOrder: media.length,
    label,
  });
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

type ImportModeValue = 'PREVIEW' | 'RUN';
type ImportStatusValue = 'PENDING' | 'SUCCESS' | 'PARTIAL' | 'FAILED';
type FeedSourceFormat = 'YANDEX_REALTY' | 'CIAN_XML';
type FeedSourceKind = 'URL' | 'FILE';
type FeedUnitStatusValue = NormalizedFeedUnitStatus;
type DecimalLike = string | number | { toString: () => string };

const activeFeedUnitStatuses: FeedUnitStatusValue[] = ['AVAILABLE', 'BOOKED', 'RESERVED'];

type FeedSourceXmlFileRecord = {
  id: string;
  key: string;
  url?: string | null;
  originalName?: string | null;
  mimeType?: string | null;
};

type FeedSourceRecord = {
  id: string;
  sourceKind: FeedSourceKind;
  url: string | null;
  xmlFileId: string | null;
  xmlFile?: FeedSourceXmlFileRecord | null;
  format: FeedSourceFormat;
  developerId: string;
  objectId: string;
  isActive: boolean;
  lastPreviewAt: Date | null;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
};

type ExistingFeedUnitRecord = {
  id: string;
  sourceId: string;
  objectId: string;
  externalId: string;
  status: FeedUnitStatusValue;
  price?: DecimalLike | null;
  area?: DecimalLike | null;
  pricePerMeter?: DecimalLike | null;
  floor?: number | null;
  completionYear?: number | null;
  completionQuarter?: number | null;
};

type FeedUnitWriteData = {
  objectId: string;
  type: NormalizedFeedUnitType;
  status: NormalizedFeedUnitStatus;
  title: string | null;
  address: string | null;
  building: string | null;
  section: string | null;
  floor: number | null;
  rooms: number | null;
  price: string | null;
  currency: string | null;
  area: string | null;
  pricePerMeter: string | null;
  completionYear: number | null;
  completionQuarter: number | null;
  rawPayload: Record<string, unknown>;
  archivedAt: Date | null;
};

type FeedMediaAssetRecord = {
  id: string;
  sourceUrl: string;
  fileId: string | null;
  contentType: string | null;
  checksum: string | null;
};

type FeedFileWriteData = {
  storage: 'MINIO';
  bucket: string;
  key: string;
  url: string;
  originalName: string;
  mimeType: string;
  sizeBytes: bigint;
  checksum: string;
};

type FeedFileVariantWriteData = {
  storage: 'MINIO';
  bucket: string;
  key: string;
  url: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: bigint;
  checksum: string;
};

type FeedObjectAggregateWriteData = {
  feedPriceFrom: string | null;
  feedPricePerMeterFrom: string | null;
  feedAreaRange: string | null;
  feedFloorRange: string | null;
  feedUnitsCount: number | null;
  feedUnitsCountText: string | null;
  feedCompletionYear: number | null;
  feedCompletionQuarter: number | null;
  feedUpdatedAt: Date | null;
};

export type FeedImportDatabase = {
  feedSource: {
    findUnique: (args: {
      where: { id: string };
      include?: {
        xmlFile?: true;
      };
    }) => Promise<FeedSourceRecord | null>;
    update: (args: { where: { id: string }; data: Partial<FeedSourceRecord> }) => Promise<unknown>;
  };
  feedImportRun: {
    create: (args: {
      data: {
        sourceId: string;
        mode: ImportModeValue;
        status: ImportStatusValue;
        startedAt: Date;
      };
    }) => Promise<{ id: string }>;
    update: (args: {
      where: { id: string };
      data: {
        status?: ImportStatusValue;
        finishedAt?: Date;
        summaryJson?: Record<string, unknown>;
        warningsJson?: FeedParserWarning[];
        errorsJson?: FeedParserWarning[];
      };
    }) => Promise<unknown>;
  };
  feedUnit: {
    findMany: (args: {
      where: {
        sourceId?: string;
        objectId?: string;
        status?: {
          in: FeedUnitStatusValue[];
        };
      };
      select?: Record<string, boolean>;
    }) => Promise<ExistingFeedUnitRecord[]>;
    upsert: (args: {
      where: { sourceId_externalId: { sourceId: string; externalId: string } };
      update: FeedUnitWriteData;
      create: FeedUnitWriteData & { sourceId: string; externalId: string };
      select: { id: true };
    }) => Promise<{ id: string }>;
    updateMany: (args: {
      where: {
        sourceId: string;
        externalId: { notIn: string[] };
        status: { not: 'ARCHIVED' };
      };
      data: {
        status: 'ARCHIVED';
        archivedAt: Date;
      };
    }) => Promise<{ count: number }>;
  };
  feedResidentialUnitDetails: {
    upsert: (args: {
      where: { unitId: string };
      update: NormalizedResidentialUnitDetails;
      create: NormalizedResidentialUnitDetails & { unitId: string };
    }) => Promise<unknown>;
    deleteMany: (args: { where: { unitId: string } }) => Promise<unknown>;
  };
  feedCommercialUnitDetails: {
    upsert: (args: {
      where: { unitId: string };
      update: NormalizedCommercialUnitDetails;
      create: NormalizedCommercialUnitDetails & { unitId: string };
    }) => Promise<unknown>;
    deleteMany: (args: { where: { unitId: string } }) => Promise<unknown>;
  };
  feedMediaAsset: {
    findMany: (args: {
      where: { sourceUrl: { in: string[] } };
      select?: Record<string, boolean>;
    }) => Promise<FeedMediaAssetRecord[]>;
    upsert: (args: {
      where: { sourceUrl: string };
      update: Partial<FeedMediaAssetRecord>;
      create: { sourceUrl: string };
    }) => Promise<FeedMediaAssetRecord>;
    update: (args: {
      where: { id: string };
      data: Partial<FeedMediaAssetRecord>;
    }) => Promise<FeedMediaAssetRecord>;
  };
  feedUnitMedia: {
    deleteMany: (args: { where: { unitId: string } }) => Promise<unknown>;
    createMany: (args: {
      data: Array<{
        unitId: string;
        mediaAssetId: string;
        sortOrder: number;
        label: string | null;
      }>;
    }) => Promise<unknown>;
  };
  file: {
    upsert: (args: {
      where: {
        storage_bucket_key: {
          storage: 'MINIO';
          bucket: string;
          key: string;
        };
      };
      update: FeedFileWriteData;
      create: FeedFileWriteData;
      select: { id: true };
    }) => Promise<{ id: string }>;
  };
  fileVariant: {
    upsert: (args: {
      where: {
        fileId_variant: {
          fileId: string;
          variant: GeneratedImageVariant['variant'];
        };
      };
      update: FeedFileVariantWriteData;
      create: FeedFileVariantWriteData & {
        fileId: string;
        variant: GeneratedImageVariant['variant'];
      };
    }) => Promise<unknown>;
  };
  realEstateObject: {
    update: (args: {
      where: { id: string };
      data: FeedObjectAggregateWriteData;
    }) => Promise<unknown>;
  };
};

export type FeedImportStorageClient = {
  getBucket: () => string;
  getPublicUrl: (key: string) => string;
  getObject: (key: string) => Promise<Buffer>;
  putObject: (params: { key: string; body: Buffer; contentType: string }) => Promise<void>;
};

export type DownloadedFeedMedia = {
  body: Buffer;
  contentType: string;
  originalName: string;
};

export type FeedImportMediaStats = {
  total: number;
  unique: number;
  existing: number;
  created: number;
  downloaded: number;
  failed: number;
  variantsCreated: number;
};

export type FeedImportProgressStage =
  | 'PROCESSING_UNITS'
  | 'ARCHIVING_UNITS'
  | 'REFRESHING_OBJECT'
  | 'COMPLETED'
  | 'FAILED';

export type FeedImportProgress = {
  stage: FeedImportProgressStage;
  unitsTotal: number;
  unitsProcessed: number;
  unitsRemaining: number;
  mediaTotal: number;
  mediaProcessed: number;
  mediaRemaining: number;
  updatedAt: string;
};

export type FeedImportSummary = {
  sourceId: string;
  sourceUrl: string;
  format: FeedSourceFormat;
  mode: ImportModeValue;
  dryRun: boolean;
  unitsParsed: number;
  created: number;
  updated: number;
  archived: number;
  media: FeedImportMediaStats;
  progress?: FeedImportProgress;
  warningsCount: number;
  errorsCount: number;
  durationMs: number;
};

export type FeedImportResult = {
  mode: FeedImportCommand;
  status: ImportStatusValue;
  summary: FeedImportSummary;
  warnings: FeedParserWarning[];
  errors: FeedParserWarning[];
  reportId: string;
};

export type ExecuteFeedImportOptions = {
  mode: FeedImportCommand;
  sourceId: string;
  db: FeedImportDatabase;
  storage?: FeedImportStorageClient;
  xmlFetcher?: (url: string) => Promise<string>;
  mediaDownloader?: (url: string) => Promise<DownloadedFeedMedia>;
  imageVariantGenerator?: (body: Buffer, key: string) => Promise<GeneratedImageVariant[]>;
  now?: () => Date;
};

type FeedImportPlan = {
  existingByExternalId: Map<string, ExistingFeedUnitRecord>;
  parsedExternalIds: Set<string>;
  uniqueMediaUrls: string[];
  mediaAssetBySourceUrl: Map<string, FeedMediaAssetRecord>;
  created: number;
  updated: number;
  archived: number;
  media: FeedImportMediaStats;
};

type PersistFeedImportContext = {
  db: FeedImportDatabase;
  reportId: string;
  source: FeedSourceRecord;
  storage: FeedImportStorageClient;
  warnings: FeedParserWarning[];
  mediaStats: FeedImportMediaStats;
  mediaAssetBySourceUrl: Map<string, FeedMediaAssetRecord>;
  failedMediaUrls: Set<string>;
  mediaDownloader: (url: string) => Promise<DownloadedFeedMedia>;
  imageVariantGenerator: (body: Buffer, key: string) => Promise<GeneratedImageVariant[]>;
  now: () => Date;
};

export type ParsedFeedImportCliArgs = {
  command: FeedImportCommand;
  sourceId: string;
};

export function parseFeedImportCliArgs(args: string[]): ParsedFeedImportCliArgs | null {
  const command = parseFeedImportCommand(args[0]);

  if (!command) {
    return null;
  }

  let sourceId: string | null = null;

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--source') {
      const nextValue = args[index + 1];

      if (!nextValue) {
        return null;
      }

      sourceId = nextValue;
      index += 1;
      continue;
    }

    if (arg?.startsWith('--source=')) {
      const value = arg.slice('--source='.length).trim();

      if (!value) {
        return null;
      }

      sourceId = value;
      continue;
    }

    return null;
  }

  if (!sourceId) {
    return null;
  }

  return {
    command,
    sourceId,
  };
}

export function createFeedParserForFormat(format: FeedSourceFormat): FeedParser {
  if (format === 'YANDEX_REALTY') {
    return new YandexRealtyFeedParser();
  }

  if (format === 'CIAN_XML') {
    return new CianXmlFeedParser();
  }

  throw new Error(`Unsupported feed format: ${format satisfies never}`);
}

async function loadXmlForFeedSource(source: FeedSourceRecord, options: ExecuteFeedImportOptions) {
  if (source.sourceKind === 'FILE') {
    if (!options.storage) {
      throw new Error('Feed file source requires storage client');
    }

    if (!source.xmlFile?.key) {
      throw new Error(`FeedSource ${source.id} XML file was not found`);
    }

    return (await options.storage.getObject(source.xmlFile.key)).toString('utf8');
  }

  if (!source.url) {
    throw new Error(`FeedSource ${source.id} URL is empty`);
  }

  return (options.xmlFetcher ?? loadXmlFromUrl)(source.url);
}

export async function executeFeedImport(options: ExecuteFeedImportOptions): Promise<FeedImportResult> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const source = await options.db.feedSource.findUnique({
    where: {
      id: options.sourceId,
    },
    include: {
      xmlFile: true,
    },
  });

  if (!source) {
    throw new Error(`FeedSource ${options.sourceId} was not found`);
  }

  const report = await options.db.feedImportRun.create({
    data: {
      sourceId: source.id,
      mode: toImportModeValue(options.mode),
      status: 'PENDING',
      startedAt,
    },
  });
  const warnings: FeedParserWarning[] = [];
  const errors: FeedParserWarning[] = [];

  try {
    const xml = await loadXmlForFeedSource(source, options);
    const parser = createFeedParserForFormat(source.format);
    const parsed = parser.parse(xml);
    warnings.push(...parsed.warnings);

    const plan = await buildFeedImportPlan(options.db, source.id, parsed.units);

    if (options.mode === 'run') {
      if (!options.storage) {
        throw new Error('Feed import run requires storage client');
      }

      await updateFeedImportProgress(
        options.db,
        report.id,
        createFeedImportProgress('PROCESSING_UNITS', parsed.units.length, 0, plan, now()),
      );
      await persistFeedImportRun(parsed.units, plan, {
        db: options.db,
        reportId: report.id,
        source,
        storage: options.storage,
        warnings,
        mediaStats: plan.media,
        mediaAssetBySourceUrl: new Map(plan.mediaAssetBySourceUrl),
        failedMediaUrls: new Set(),
        mediaDownloader: options.mediaDownloader ?? downloadMediaFile,
        imageVariantGenerator: options.imageVariantGenerator ?? generateImageVariants,
        now,
      });
      await updateFeedImportProgress(
        options.db,
        report.id,
        createFeedImportProgress('REFRESHING_OBJECT', parsed.units.length, parsed.units.length, plan, now()),
      );
      await refreshRealEstateObjectFeedAggregates(options.db, source.objectId, now());
    }

    const finishedAt = now();
    const status = resolveFeedImportStatus(warnings, errors);
    const summary = createFeedImportSummary({
      source,
      mode: options.mode,
      unitsParsed: parsed.units.length,
      plan,
      warnings,
      errors,
      startedAt,
      finishedAt,
    });

    await finishFeedImportRun(options.db, source.id, report.id, options.mode, status, finishedAt, summary, warnings, errors);

    return {
      mode: options.mode,
      status,
      summary,
      warnings,
      errors,
      reportId: report.id,
    };
  } catch (error) {
    const finishedAt = now();
    const importError = toFeedImportIssue(error);
    errors.push(importError);

    const summary = createFailedFeedImportSummary(source, options.mode, startedAt, finishedAt, warnings, errors);
    await finishFeedImportRun(options.db, source.id, report.id, options.mode, 'FAILED', finishedAt, summary, warnings, errors);

    throw error;
  }
}

async function buildFeedImportPlan(
  db: FeedImportDatabase,
  sourceId: string,
  units: NormalizedFeedUnit[],
): Promise<FeedImportPlan> {
  const existingUnits = await db.feedUnit.findMany({
    where: {
      sourceId,
    },
    select: {
      id: true,
      sourceId: true,
      objectId: true,
      externalId: true,
      status: true,
    },
  });
  const existingByExternalId = new Map(existingUnits.map((unit) => [unit.externalId, unit]));
  const parsedExternalIds = new Set(units.map((unit) => unit.externalId));
  const created = units.filter((unit) => !existingByExternalId.has(unit.externalId)).length;
  const updated = units.length - created;
  const archived = existingUnits.filter(
    (unit) => !parsedExternalIds.has(unit.externalId) && unit.status !== 'ARCHIVED',
  ).length;
  const mediaUrls = units.flatMap((unit) => unit.media.map((media) => media.sourceUrl));
  const uniqueMediaUrls = Array.from(new Set(mediaUrls));
  const existingMediaAssets =
    uniqueMediaUrls.length > 0
      ? await db.feedMediaAsset.findMany({
          where: {
            sourceUrl: {
              in: uniqueMediaUrls,
            },
          },
        })
      : [];
  const mediaAssetBySourceUrl = new Map(existingMediaAssets.map((asset) => [asset.sourceUrl, asset]));

  return {
    existingByExternalId,
    parsedExternalIds,
    uniqueMediaUrls,
    mediaAssetBySourceUrl,
    created,
    updated,
    archived,
    media: {
      total: mediaUrls.length,
      unique: uniqueMediaUrls.length,
      existing: existingMediaAssets.length,
      created: uniqueMediaUrls.length - existingMediaAssets.length,
      downloaded: 0,
      failed: 0,
      variantsCreated: 0,
    },
  };
}

async function persistFeedImportRun(
  units: NormalizedFeedUnit[],
  plan: FeedImportPlan,
  context: PersistFeedImportContext,
) {
  let unitsProcessed = 0;

  for (const unit of units) {
    const unitId = await upsertFeedUnit(context.db, context.source, unit, context.now());

    await syncFeedUnitDetails(context.db, unitId, unit);
    await syncFeedUnitMedia(context, unitId, unit);
    unitsProcessed += 1;
    await updateFeedImportProgress(
      context.db,
      context.reportId,
      createFeedImportProgress('PROCESSING_UNITS', units.length, unitsProcessed, plan, context.now()),
    );
  }

  await updateFeedImportProgress(
    context.db,
    context.reportId,
    createFeedImportProgress('ARCHIVING_UNITS', units.length, unitsProcessed, plan, context.now()),
  );
  await context.db.feedUnit.updateMany({
    where: {
      sourceId: context.source.id,
      externalId: {
        notIn: Array.from(plan.parsedExternalIds),
      },
      status: {
        not: 'ARCHIVED',
      },
    },
    data: {
      status: 'ARCHIVED',
      archivedAt: context.now(),
    },
  });
}

async function refreshRealEstateObjectFeedAggregates(
  db: FeedImportDatabase,
  objectId: string,
  updatedAt: Date,
) {
  const activeUnits = await db.feedUnit.findMany({
    where: {
      objectId,
      status: {
        in: activeFeedUnitStatuses,
      },
    },
    select: {
      id: true,
      sourceId: true,
      objectId: true,
      externalId: true,
      status: true,
      price: true,
      pricePerMeter: true,
      area: true,
      floor: true,
      completionYear: true,
      completionQuarter: true,
    },
  });

  if (activeUnits.length === 0) {
    await db.realEstateObject.update({
      where: {
        id: objectId,
      },
      data: createEmptyFeedObjectAggregates(),
    });
    return;
  }

  const completion = getEarliestCompletion(activeUnits);

  await db.realEstateObject.update({
    where: {
      id: objectId,
    },
    data: {
      feedPriceFrom: minDecimalString(activeUnits.map((unit) => unit.price ?? null)),
      feedPricePerMeterFrom: minDecimalString(activeUnits.map((unit) => unit.pricePerMeter ?? null)),
      feedAreaRange: formatDecimalRange(activeUnits.map((unit) => unit.area ?? null), 'м²'),
      feedFloorRange: formatFloorRange(activeUnits.map((unit) => unit.floor ?? null)),
      feedUnitsCount: activeUnits.length,
      feedUnitsCountText: formatLotsCount(activeUnits.length),
      feedCompletionYear: completion?.year ?? null,
      feedCompletionQuarter: completion?.quarter ?? null,
      feedUpdatedAt: updatedAt,
    },
  });
}

function createEmptyFeedObjectAggregates(): FeedObjectAggregateWriteData {
  return {
    feedPriceFrom: null,
    feedPricePerMeterFrom: null,
    feedAreaRange: null,
    feedFloorRange: null,
    feedUnitsCount: null,
    feedUnitsCountText: null,
    feedCompletionYear: null,
    feedCompletionQuarter: null,
    feedUpdatedAt: null,
  };
}

function minDecimalString(values: Array<DecimalLike | null>) {
  const numbers = values.map(decimalLikeToNumber).filter((value): value is number => value !== null);

  if (numbers.length === 0) {
    return null;
  }

  return Math.min(...numbers).toFixed(2);
}

function formatDecimalRange(values: Array<DecimalLike | null>, suffix: string) {
  const numbers = values.map(decimalLikeToNumber).filter((value): value is number => value !== null);

  if (numbers.length === 0) {
    return null;
  }

  const min = Math.min(...numbers);
  const max = Math.max(...numbers);

  if (min === max) {
    return `${formatCompactDecimal(min)} ${suffix}`;
  }

  return `${formatCompactDecimal(min)}-${formatCompactDecimal(max)} ${suffix}`;
}

function formatFloorRange(values: Array<number | null>) {
  const numbers = values.filter((value): value is number => value !== null);

  if (numbers.length === 0) {
    return null;
  }

  const min = Math.min(...numbers);
  const max = Math.max(...numbers);

  if (min === max) {
    return `${min} этаж`;
  }

  return `${min}-${max} этажей`;
}

function formatCompactDecimal(value: number) {
  return value.toFixed(2).replace(/\.00$/u, '').replace(/(\.\d)0$/u, '$1');
}

function decimalLikeToNumber(value: DecimalLike | null) {
  if (value === null) {
    return null;
  }

  const numeric = Number(value.toString());

  return Number.isFinite(numeric) ? numeric : null;
}

function getEarliestCompletion(units: ExistingFeedUnitRecord[]) {
  let earliest: { year: number; quarter: number | null } | null = null;

  for (const unit of units) {
    if (unit.completionYear === null || unit.completionYear === undefined) {
      continue;
    }

    const current = {
      year: unit.completionYear,
      quarter: unit.completionQuarter ?? null,
    };

    if (!earliest || compareCompletion(current, earliest) < 0) {
      earliest = current;
    }
  }

  return earliest;
}

function compareCompletion(
  left: { year: number; quarter: number | null },
  right: { year: number; quarter: number | null },
) {
  if (left.year !== right.year) {
    return left.year - right.year;
  }

  return getCompletionQuarterSortValue(left.quarter) - getCompletionQuarterSortValue(right.quarter);
}

function getCompletionQuarterSortValue(quarter: number | null) {
  return quarter ?? 5;
}

function formatLotsCount(count: number) {
  const mod100 = count % 100;
  const mod10 = count % 10;

  if (mod100 >= 11 && mod100 <= 14) {
    return `${count} лотов`;
  }

  if (mod10 === 1) {
    return `${count} лот`;
  }

  if (mod10 >= 2 && mod10 <= 4) {
    return `${count} лота`;
  }

  return `${count} лотов`;
}

async function upsertFeedUnit(
  db: FeedImportDatabase,
  source: FeedSourceRecord,
  unit: NormalizedFeedUnit,
  now: Date,
) {
  const writeData = createFeedUnitWriteData(source, unit, now);
  const persisted = await db.feedUnit.upsert({
    where: {
      sourceId_externalId: {
        sourceId: source.id,
        externalId: unit.externalId,
      },
    },
    update: writeData,
    create: {
      sourceId: source.id,
      externalId: unit.externalId,
      ...writeData,
    },
    select: {
      id: true,
    },
  });

  return persisted.id;
}

function createFeedUnitWriteData(
  source: FeedSourceRecord,
  unit: NormalizedFeedUnit,
  now: Date,
): FeedUnitWriteData {
  return {
    objectId: source.objectId,
    type: unit.type,
    status: unit.status,
    title: unit.title,
    address: unit.address,
    building: unit.building,
    section: unit.section,
    floor: unit.floor,
    rooms: unit.rooms,
    price: unit.price,
    currency: unit.currency,
    area: unit.area,
    pricePerMeter: unit.pricePerMeter,
    completionYear: unit.completionYear,
    completionQuarter: unit.completionQuarter,
    rawPayload: unit.rawPayload,
    archivedAt: unit.status === 'ARCHIVED' ? now : null,
  };
}

async function syncFeedUnitDetails(
  db: FeedImportDatabase,
  unitId: string,
  unit: NormalizedFeedUnit,
) {
  if (unit.type === 'RESIDENTIAL' && unit.residentialDetails) {
    await db.feedResidentialUnitDetails.upsert({
      where: {
        unitId,
      },
      update: unit.residentialDetails,
      create: {
        unitId,
        ...unit.residentialDetails,
      },
    });
    await db.feedCommercialUnitDetails.deleteMany({
      where: {
        unitId,
      },
    });
    return;
  }

  if (unit.type === 'COMMERCIAL' && unit.commercialDetails) {
    await db.feedCommercialUnitDetails.upsert({
      where: {
        unitId,
      },
      update: unit.commercialDetails,
      create: {
        unitId,
        ...unit.commercialDetails,
      },
    });
    await db.feedResidentialUnitDetails.deleteMany({
      where: {
        unitId,
      },
    });
    return;
  }

  await db.feedResidentialUnitDetails.deleteMany({
    where: {
      unitId,
    },
  });
  await db.feedCommercialUnitDetails.deleteMany({
    where: {
      unitId,
    },
  });
}

async function syncFeedUnitMedia(
  context: PersistFeedImportContext,
  unitId: string,
  unit: NormalizedFeedUnit,
) {
  await context.db.feedUnitMedia.deleteMany({
    where: {
      unitId,
    },
  });

  if (unit.media.length === 0) {
    return;
  }

  const links: Array<{
    unitId: string;
    mediaAssetId: string;
    sortOrder: number;
    label: string | null;
  }> = [];

  for (const media of unit.media) {
    const mediaAsset = await ensureFeedMediaAsset(context, media.sourceUrl, unit.externalId);

    links.push({
      unitId,
      mediaAssetId: mediaAsset.id,
      sortOrder: media.sortOrder,
      label: media.label,
    });
  }

  await context.db.feedUnitMedia.createMany({
    data: links,
  });
}

async function ensureFeedMediaAsset(
  context: PersistFeedImportContext,
  sourceUrl: string,
  externalId: string,
) {
  const cachedAsset = context.mediaAssetBySourceUrl.get(sourceUrl);

  if (cachedAsset?.fileId || context.failedMediaUrls.has(sourceUrl)) {
    return cachedAsset ?? createCachedFailedMediaAsset(context, sourceUrl);
  }

  let mediaAsset =
    cachedAsset ??
    (await context.db.feedMediaAsset.upsert({
      where: {
        sourceUrl,
      },
      update: {},
      create: {
        sourceUrl,
      },
    }));

  context.mediaAssetBySourceUrl.set(sourceUrl, mediaAsset);

  if (mediaAsset.fileId) {
    return mediaAsset;
  }

  try {
    const downloaded = await context.mediaDownloader(sourceUrl);
    const contentType = normalizeMediaContentType(downloaded.contentType, sourceUrl);
    const key = createFeedMediaStorageKey(sourceUrl, contentType, context.now());
    const checksum = createHash('sha256').update(downloaded.body).digest('hex');

    await context.storage.putObject({
      key,
      body: downloaded.body,
      contentType,
    });

    const file = await upsertFeedMediaFile(context, {
      key,
      body: downloaded.body,
      contentType,
      checksum,
      originalName: downloaded.originalName || getMediaOriginalName(sourceUrl, contentType),
    });

    mediaAsset = await context.db.feedMediaAsset.update({
      where: {
        id: mediaAsset.id,
      },
      data: {
        fileId: file.id,
        contentType,
        checksum,
      },
    });
    context.mediaAssetBySourceUrl.set(sourceUrl, mediaAsset);
    context.mediaStats.downloaded += 1;

    await ensureFeedMediaVariants(context, file.id, key, downloaded.body, contentType, externalId, sourceUrl);

    return mediaAsset;
  } catch (error) {
    context.failedMediaUrls.add(sourceUrl);
    context.mediaStats.failed += 1;
    context.warnings.push({
      code: 'MEDIA_DOWNLOAD_FAILED',
      externalId,
      field: 'media',
      message: `Cannot import feed media ${sourceUrl}: ${getErrorMessage(error)}`,
      value: sourceUrl,
    });

    return mediaAsset;
  }
}

function createCachedFailedMediaAsset(
  context: PersistFeedImportContext,
  sourceUrl: string,
) {
  const mediaAsset = context.mediaAssetBySourceUrl.get(sourceUrl);

  if (mediaAsset) {
    return mediaAsset;
  }

  throw new Error(`Feed media asset ${sourceUrl} was expected to be cached`);
}

async function upsertFeedMediaFile(
  context: PersistFeedImportContext,
  params: {
    key: string;
    body: Buffer;
    contentType: string;
    checksum: string;
    originalName: string;
  },
) {
  const writeData = {
    storage: 'MINIO',
    bucket: context.storage.getBucket(),
    key: params.key,
    url: context.storage.getPublicUrl(params.key),
    originalName: params.originalName,
    mimeType: params.contentType,
    sizeBytes: BigInt(params.body.length),
    checksum: params.checksum,
  } satisfies FeedFileWriteData;

  return context.db.file.upsert({
    where: {
      storage_bucket_key: {
        storage: 'MINIO',
        bucket: context.storage.getBucket(),
        key: params.key,
      },
    },
    update: writeData,
    create: writeData,
    select: {
      id: true,
    },
  });
}

async function ensureFeedMediaVariants(
  context: PersistFeedImportContext,
  fileId: string,
  key: string,
  body: Buffer,
  contentType: string,
  externalId: string,
  sourceUrl: string,
) {
  if (!isImageVariantSourceMimeType(contentType)) {
    return;
  }

  try {
    const variants = await context.imageVariantGenerator(body, key);

    for (const variant of variants) {
      await context.storage.putObject({
        key: variant.key,
        body: variant.body,
        contentType: variant.mimeType,
      });

      await context.db.fileVariant.upsert({
        where: {
          fileId_variant: {
            fileId,
            variant: variant.variant,
          },
        },
        update: createFeedFileVariantWriteData(context.storage, variant),
        create: {
          fileId,
          variant: variant.variant,
          ...createFeedFileVariantWriteData(context.storage, variant),
        },
      });
    }

    context.mediaStats.variantsCreated += variants.length;
  } catch (error) {
    context.warnings.push({
      code: 'MEDIA_VARIANTS_FAILED',
      externalId,
      field: 'media',
      message: `Cannot generate variants for feed media ${sourceUrl}: ${getErrorMessage(error)}`,
      value: sourceUrl,
    });
  }
}

function createFeedFileVariantWriteData(
  storage: FeedImportStorageClient,
  variant: GeneratedImageVariant,
): FeedFileVariantWriteData {
  return {
    storage: 'MINIO',
    bucket: storage.getBucket(),
    key: variant.key,
    url: storage.getPublicUrl(variant.key),
    mimeType: variant.mimeType,
    width: variant.width,
    height: variant.height,
    sizeBytes: variant.sizeBytes,
    checksum: variant.checksum,
  };
}

export async function downloadMediaFile(
  sourceUrl: string,
  fetchImpl: FeedMediaFetch = getGlobalFetch() as unknown as FeedMediaFetch,
): Promise<DownloadedFeedMedia> {
  const mediaUrl = new URL(sourceUrl);
  const response = await fetchImpl(mediaUrl.toString(), {
    headers: {
      accept: 'image/*,*/*',
    },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  const body = Buffer.from(await response.arrayBuffer());

  if (body.length === 0) {
    throw new Error('empty response body');
  }

  const contentType = normalizeMediaContentType(response.headers?.get('content-type') ?? null, mediaUrl.toString());

  return {
    body,
    contentType,
    originalName: getMediaOriginalName(mediaUrl.toString(), contentType),
  };
}

function createFeedImportSummary(params: {
  source: FeedSourceRecord;
  mode: FeedImportCommand;
  unitsParsed: number;
  plan: FeedImportPlan;
  warnings: FeedParserWarning[];
  errors: FeedParserWarning[];
  startedAt: Date;
  finishedAt: Date;
}): FeedImportSummary {
  const summary: FeedImportSummary = {
    sourceId: params.source.id,
    sourceUrl: params.source.url ?? params.source.xmlFile?.url ?? params.source.xmlFile?.key ?? '',
    format: params.source.format,
    mode: toImportModeValue(params.mode),
    dryRun: params.mode === 'preview',
    unitsParsed: params.unitsParsed,
    created: params.plan.created,
    updated: params.plan.updated,
    archived: params.plan.archived,
    media: {
      ...params.plan.media,
    },
    warningsCount: params.warnings.length,
    errorsCount: params.errors.length,
    durationMs: params.finishedAt.getTime() - params.startedAt.getTime(),
  };

  if (params.mode === 'run') {
    summary.progress = createFeedImportProgress('COMPLETED', params.unitsParsed, params.unitsParsed, params.plan, params.finishedAt);
  }

  return summary;
}

function createFeedImportProgress(
  stage: FeedImportProgressStage,
  unitsTotal: number,
  unitsProcessed: number,
  plan: FeedImportPlan,
  updatedAt: Date,
): FeedImportProgress {
  const safeUnitsTotal = Math.max(0, unitsTotal);
  const safeUnitsProcessed = clampNumber(unitsProcessed, 0, safeUnitsTotal);
  const mediaTotal = Math.max(0, plan.media.created);
  const mediaProcessed = clampNumber(plan.media.downloaded + plan.media.failed, 0, mediaTotal);

  return {
    stage,
    unitsTotal: safeUnitsTotal,
    unitsProcessed: safeUnitsProcessed,
    unitsRemaining: Math.max(safeUnitsTotal - safeUnitsProcessed, 0),
    mediaTotal,
    mediaProcessed,
    mediaRemaining: Math.max(mediaTotal - mediaProcessed, 0),
    updatedAt: updatedAt.toISOString(),
  };
}

async function updateFeedImportProgress(
  db: FeedImportDatabase,
  reportId: string,
  progress: FeedImportProgress,
) {
  await db.feedImportRun.update({
    where: {
      id: reportId,
    },
    data: {
      summaryJson: {
        progress,
      },
    },
  });
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function createFailedFeedImportSummary(
  source: FeedSourceRecord,
  mode: FeedImportCommand,
  startedAt: Date,
  finishedAt: Date,
  warnings: FeedParserWarning[],
  errors: FeedParserWarning[],
): FeedImportSummary {
  const summary: FeedImportSummary = {
    sourceId: source.id,
    sourceUrl: source.url ?? source.xmlFile?.url ?? source.xmlFile?.key ?? '',
    format: source.format,
    mode: toImportModeValue(mode),
    dryRun: mode === 'preview',
    unitsParsed: 0,
    created: 0,
    updated: 0,
    archived: 0,
    media: {
      total: 0,
      unique: 0,
      existing: 0,
      created: 0,
      downloaded: 0,
      failed: 0,
      variantsCreated: 0,
    },
    warningsCount: warnings.length,
    errorsCount: errors.length,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  };

  if (mode === 'run') {
    summary.progress = {
      stage: 'FAILED',
      unitsTotal: 0,
      unitsProcessed: 0,
      unitsRemaining: 0,
      mediaTotal: 0,
      mediaProcessed: 0,
      mediaRemaining: 0,
      updatedAt: finishedAt.toISOString(),
    };
  }

  return summary;
}

async function finishFeedImportRun(
  db: FeedImportDatabase,
  sourceId: string,
  reportId: string,
  mode: FeedImportCommand,
  status: ImportStatusValue,
  finishedAt: Date,
  summary: FeedImportSummary,
  warnings: FeedParserWarning[],
  errors: FeedParserWarning[],
) {
  await db.feedImportRun.update({
    where: {
      id: reportId,
    },
    data: {
      status,
      finishedAt,
      summaryJson: summary as unknown as Record<string, unknown>,
      warningsJson: warnings,
      errorsJson: errors,
    },
  });

  const sourceUpdate: Partial<FeedSourceRecord> =
    mode === 'preview'
      ? {
          lastPreviewAt: finishedAt,
        }
      : {
          lastRunAt: finishedAt,
        };

  if (status === 'SUCCESS' || status === 'PARTIAL') {
    sourceUpdate.lastSuccessAt = finishedAt;
  }

  await db.feedSource.update({
    where: {
      id: sourceId,
    },
    data: sourceUpdate,
  });
}

function resolveFeedImportStatus(warnings: FeedParserWarning[], errors: FeedParserWarning[]): ImportStatusValue {
  if (errors.length > 0) {
    return 'PARTIAL';
  }

  if (warnings.length > 0) {
    return 'PARTIAL';
  }

  return 'SUCCESS';
}

function toImportModeValue(mode: FeedImportCommand): ImportModeValue {
  return mode === 'preview' ? 'PREVIEW' : 'RUN';
}

function toFeedImportIssue(error: unknown): FeedParserWarning {
  return {
    code: 'FEED_IMPORT_FAILED',
    message: getErrorMessage(error),
  };
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeMediaContentType(value: string | null | undefined, sourceUrl: string) {
  const normalized = value?.split(';')[0]?.trim().toLowerCase();

  if (normalized) {
    return normalized;
  }

  return guessContentTypeFromUrl(sourceUrl);
}

function guessContentTypeFromUrl(sourceUrl: string) {
  const extension = getMediaExtension(sourceUrl).toLowerCase();

  if (extension === '.jpg' || extension === '.jpeg') {
    return 'image/jpeg';
  }

  if (extension === '.png') {
    return 'image/png';
  }

  if (extension === '.webp') {
    return 'image/webp';
  }

  if (extension === '.gif') {
    return 'image/gif';
  }

  if (extension === '.pdf') {
    return 'application/pdf';
  }

  return 'application/octet-stream';
}

function createFeedMediaStorageKey(sourceUrl: string, contentType: string, date: Date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const hash = createHash('sha256').update(sourceUrl).digest('hex');
  const extension = getMediaExtension(sourceUrl) || getExtensionByContentType(contentType);

  return `feeds/${year}/${month}/${hash}${extension}`;
}

function getMediaOriginalName(sourceUrl: string, contentType: string) {
  const url = new URL(sourceUrl);
  const fileName = basename(url.pathname);
  const decodedFileName = decodeURIComponent(fileName);

  if (decodedFileName && decodedFileName !== '/') {
    return decodedFileName;
  }

  const hash = createHash('sha256').update(sourceUrl).digest('hex').slice(0, 16);

  return `${hash}${getExtensionByContentType(contentType)}`;
}

function getMediaExtension(sourceUrl: string) {
  try {
    const url = new URL(sourceUrl);
    const extension = extname(url.pathname);

    return extension.length <= 12 ? extension : '';
  } catch {
    return '';
  }
}

function getExtensionByContentType(contentType: string) {
  if (contentType === 'image/jpeg') {
    return '.jpg';
  }

  if (contentType === 'image/png') {
    return '.png';
  }

  if (contentType === 'image/webp') {
    return '.webp';
  }

  if (contentType === 'image/gif') {
    return '.gif';
  }

  if (contentType === 'application/pdf') {
    return '.pdf';
  }

  return '.bin';
}

function printUsage() {
  console.error('Usage: pnpm --filter @platforma/feed-import run <preview|run> --source <feedSourceId>');
}

async function main() {
  const cliArgs = parseFeedImportCliArgs(process.argv.slice(2));

  if (!cliArgs) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (!isXmlParserAvailable()) {
    console.error('XML parser dependency is unavailable');
    process.exitCode = 1;
    return;
  }

  const config = loadFeedImportConfig();
  const prisma = new PrismaClient();

  try {
    const result = await executeFeedImport({
      mode: cliArgs.command,
      sourceId: cliArgs.sourceId,
      db: prisma as unknown as FeedImportDatabase,
      storage: new FeedImportStorage(config.s3),
    });

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
