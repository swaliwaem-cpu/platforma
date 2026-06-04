import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
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
type FeedAnalyzeCommand = 'analyze';

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
  projectName: string | null;
  address: string | null;
  building: string | null;
  section: string | null;
  floor: number | null;
  rooms: number | null;
  price: string | null;
  discountPrice: string | null;
  effectivePrice: string | null;
  currency: string | null;
  area: string | null;
  pricePerMeter: string | null;
  discountPricePerMeter: string | null;
  effectivePricePerMeter: string | null;
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

  if (normalized === 'archived' || normalized === 'archive' || normalized === 'unavailable') {
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
    const buildingName = normalizePlaceholderText(getText(offer['building-name']));
    const buildingSection = normalizePlaceholderText(getText(offer['building-section']));
    const price = normalizeDecimal(offer.price, 'price', externalId, warnings);
    const discount = asRecord(offer.discount);
    const discountPrice = normalizeDecimal(discount?.['final-price'], 'discountPrice', externalId, warnings);
    const effectivePrice = discountPrice ?? price;
    const area = normalizeDecimal(offer.area, 'area', externalId, warnings);
    const pricePerMeter = calculatePricePerMeter(price, area);
    const discountPricePerMeter = calculatePricePerMeter(discountPrice, area);
    const effectivePricePerMeter = calculatePricePerMeter(effectivePrice, area);
    const floor = normalizeInteger(offer.floor, 'floor', externalId, warnings);
    const rooms = normalizeYandexRooms(offer, externalId, warnings);
    const completionYear = normalizeInteger(offer['built-year'], 'completionYear', externalId, warnings);
    const completionQuarter = normalizeQuarter(offer['ready-quarter'], externalId, warnings);
    const livingArea = normalizeDecimal(offer['living-space'], 'livingArea', externalId, warnings);
    const apartmentNumber = getYandexApartmentNumber(offer, location);

    return {
      externalId,
      type: getYandexUnitType(offer),
      status: 'AVAILABLE',
      title: buildYandexTitle(offer, location),
      projectName: buildingName,
      address: getText(location?.address) ?? getText(offer.Address),
      building: buildingName,
      section: buildingSection,
      floor,
      rooms,
      price,
      discountPrice,
      effectivePrice,
      currency: getText(asRecord(offer.price)?.currency),
      area,
      pricePerMeter,
      discountPricePerMeter,
      effectivePricePerMeter,
      completionYear,
      completionQuarter,
      rawPayload: offer,
      media: collectYandexMedia(offer, externalId, warnings),
      residentialDetails:
        getYandexUnitType(offer) === 'RESIDENTIAL'
          ? {
              apartmentNumber,
              layoutType: getText(offer['rooms-type']),
              livingArea,
              kitchenArea: normalizeDecimal(offer['kitchen-space'], 'kitchenArea', externalId, warnings),
              balconyCount: normalizeInteger(offer.balconies ?? offer.balcony, 'balconyCount', externalId, warnings),
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
    const feed = getCianFeedRoot(root);

    if (!feed) {
      throw new Error('Cian XML feed must contain <feed>, <Feed> or CIAN-like <realty-feed>');
    }

    const warnings: FeedParserWarning[] = [];
    const units = toArray(feed.object ?? feed.Object)
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
    const jkSchema = asRecord(object.JKSchema);
    const cianHouse = asRecord(jkSchema?.House);
    const cianFlat = asRecord(cianHouse?.Flat);
    const statusResult = normalizeCianFeedUnitStatus(object);
    const completion = normalizeCianCompletion(object, building, cianHouse, externalId, warnings);
    const buildingName = normalizePlaceholderText(getText(building?.Name) ?? getText(cianHouse?.Name));
    const section = normalizePlaceholderText(getText(object.Section) ?? getText(cianFlat?.SectionNumber));

    if (statusResult.warning) {
      warnings.push(withExternalId(statusResult.warning, externalId));
    }

    const price = normalizeDecimal(bargainTerms?.Price, 'price', externalId, warnings);
    const discountPrice = normalizeCianDiscountPrice(object, bargainTerms, price, externalId, warnings);
    const effectivePrice = discountPrice ?? price;
    const floor = normalizeInteger(object.FloorNumber, 'floor', externalId, warnings);
    const area = normalizeDecimal(object.TotalArea, 'area', externalId, warnings);
    const ceilingHeight = normalizeDecimal(building?.CeilingHeight, 'ceilingHeight', externalId, warnings);
    const powerKw = normalizeDecimal(object.Power, 'powerKw', externalId, warnings);
    const type = getCianUnitType(object);
    const apartmentNumber = type === 'RESIDENTIAL' ? getCianApartmentNumber(object, cianFlat) : null;

    return {
      externalId,
      type,
      status: statusResult.status,
      title: buildCianUnitTitle(object, type, apartmentNumber),
      projectName: normalizePlaceholderText(getText(jkSchema?.Name)),
      address: getText(object.Address),
      building: buildingName,
      section,
      floor,
      rooms: normalizeCianRooms(object, externalId, warnings),
      price,
      discountPrice,
      effectivePrice,
      currency: getText(bargainTerms?.Currency),
      area,
      pricePerMeter: calculatePricePerMeter(price, area),
      discountPricePerMeter: calculatePricePerMeter(discountPrice, area),
      effectivePricePerMeter: calculatePricePerMeter(effectivePrice, area),
      completionYear: completion.year,
      completionQuarter: completion.quarter,
      rawPayload: object,
      media: collectCianMedia(object, externalId, warnings),
      residentialDetails:
        type === 'RESIDENTIAL'
          ? {
              apartmentNumber,
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

export class AvitoXmlFeedParser implements FeedParser {
  parse(xml: string): FeedParseResult {
    const root = parseXml(xml);
    const feed = asRecord(root.Ads);

    if (!feed) {
      throw new Error('Avito XML feed must contain <Ads>');
    }

    const warnings: FeedParserWarning[] = [];
    const units = toArray(feed.Ad)
      .map(asRecord)
      .filter((ad): ad is XmlRecord => ad !== null)
      .flatMap((ad, index) => {
        const externalId = getText(ad.Id);

        if (!externalId) {
          warnings.push({
            code: 'MISSING_EXTERNAL_ID',
            field: 'externalId',
            message: `Avito ad at index ${index} is missing Id`,
          });
          return [];
        }

        return [this.normalizeAd(ad, externalId, warnings)];
      });

    return { units, warnings };
  }

  private normalizeAd(ad: XmlRecord, externalId: string, warnings: FeedParserWarning[]): NormalizedFeedUnit {
    const type = getAvitoUnitType(ad);
    const price = normalizeDecimal(ad.Price, 'price', externalId, warnings);
    const area = normalizeDecimal(ad.Square, 'area', externalId, warnings);
    const floor = normalizeInteger(ad.Floor, 'floor', externalId, warnings);
    const rooms = normalizeAvitoRooms(ad.Rooms, externalId, warnings);
    const livingArea = normalizeDecimal(ad.LivingSpace, 'livingArea', externalId, warnings);
    const kitchenArea = normalizeDecimal(ad.KitchenSpace, 'kitchenArea', externalId, warnings);
    const ceilingHeight = normalizeDecimal(ad.CeilingHeight, 'ceilingHeight', externalId, warnings);
    const floorsTotal = normalizeInteger(ad.Floors, 'floorsTotal', externalId, warnings);
    const bathroomCount = normalizeInteger(ad.BathroomCount, 'bathroomCount', externalId, warnings);
    const address = getText(ad.Address);

    return {
      externalId,
      type,
      status: 'AVAILABLE',
      title: buildAvitoTitle(ad, externalId),
      projectName: null,
      address,
      building: extractAvitoBuilding(address),
      section: null,
      floor,
      rooms,
      price,
      discountPrice: null,
      effectivePrice: price,
      currency: 'RUR',
      area,
      pricePerMeter: calculatePricePerMeter(price, area),
      discountPricePerMeter: null,
      effectivePricePerMeter: calculatePricePerMeter(price, area),
      completionYear: null,
      completionQuarter: null,
      rawPayload: ad,
      media: collectAvitoMedia(ad, externalId, warnings),
      residentialDetails:
        type === 'RESIDENTIAL'
          ? {
              apartmentNumber: null,
              layoutType: getText(ad.Rooms),
              livingArea,
              kitchenArea,
              balconyCount: getAvitoBalconyCount(ad),
              detailsJson: {
                avitoDevelopmentId: getText(ad.NewDevelopmentId),
                marketType: getText(ad.MarketType),
                decoration: getText(ad.Decoration),
                ceilingHeight,
                status: getText(ad.Status),
                floorsTotal,
                bathroomCount,
                bathroomType: getText(ad.BathroomType),
              },
            }
          : null,
      commercialDetails:
        type === 'COMMERCIAL'
          ? {
              commercialType: getText(ad.Category) ?? getText(ad.Status),
              entrance: null,
              ceilingHeight,
              powerKw: normalizeDecimal(ad.Power, 'powerKw', externalId, warnings),
              separateEntrance: normalizeBoolean(ad.SeparateEntrance),
              detailsJson: {
                avitoDevelopmentId: getText(ad.NewDevelopmentId),
                marketType: getText(ad.MarketType),
                decoration: getText(ad.Decoration),
                status: getText(ad.Status),
                floorsTotal,
                bathroomCount,
              },
            }
          : null,
    };
  }
}

type FskUnitContext = {
  flatTypeNames: Map<string, string>;
  regionName: string | null;
  complexName: string | null;
  complexId: string | null;
  complexId1C: string | null;
  address: string | null;
  corpusNumber: string | null;
  corpusDelivery: string | null;
  sectionNumber: string | null;
  floorNumber: string | null;
};

const fskResidentialFlatTypeIds = new Set(['0', '1', '3', '4', '5', '7', '50']);
const fskStudioFlatTypeIds = new Set(['7']);

export class FskXmlFeedParser implements FeedParser {
  parse(xml: string): FeedParseResult {
    const root = parseXml(xml);
    const data = asRecord(root.Data);

    if (!data) {
      throw new Error('FSK XML feed must contain <Data>');
    }

    const warnings: FeedParserWarning[] = [];
    const units: NormalizedFeedUnit[] = [];
    const flatTypeNames = collectFskFlatTypeNames(data);
    const regions = asRecord(data.Regions);

    for (const regionNode of toArray(regions?.Region)) {
      const region = asRecord(regionNode);

      if (!region) {
        continue;
      }

      for (const objectNode of toArray(region.Object)) {
        const object = asRecord(objectNode);

        if (!object) {
          continue;
        }

        units.push(...this.normalizeObject(object, flatTypeNames, getXmlAttribute(region, 'Region_name'), warnings));
      }
    }

    return { units, warnings };
  }

  private normalizeObject(
    object: XmlRecord,
    flatTypeNames: Map<string, string>,
    regionName: string | null,
    warnings: FeedParserWarning[],
  ) {
    const info = asRecord(object.Info);
    const buildings = asRecord(object.Buildings);
    const contextBase = {
      flatTypeNames,
      regionName,
      complexName: getXmlAttribute(object, 'Complex_name'),
      complexId: getXmlAttribute(object, 'Complex_id'),
      complexId1C: getXmlAttribute(object, 'ID1C'),
      address: getText(info?.Complex_address) ?? getText(object.Complex_address),
    };
    const units: NormalizedFeedUnit[] = [];

    for (const corpusNode of toArray(buildings?.Corpus)) {
      const corpus = asRecord(corpusNode);

      if (!corpus) {
        continue;
      }

      for (const sectionNode of toArray(corpus.Section)) {
        const section = asRecord(sectionNode);

        if (!section) {
          continue;
        }

        for (const floorNode of toArray(section.Floor)) {
          const floor = asRecord(floorNode);

          if (!floor) {
            continue;
          }

          for (const flatNode of toArray(floor.Flat)) {
            const flat = asRecord(flatNode);

            if (!flat || !isFskResidentialFlat(flat)) {
              continue;
            }

            const context: FskUnitContext = {
              ...contextBase,
              corpusNumber: getXmlAttribute(corpus, 'Num'),
              corpusDelivery: getXmlAttribute(corpus, 'Corpus_Delivery'),
              sectionNumber: getXmlAttribute(section, 'Num'),
              floorNumber: getXmlAttribute(floor, 'Num'),
            };
            const unit = this.normalizeFlat(flat, context, warnings);

            if (unit) {
              units.push(unit);
            }
          }
        }
      }
    }

    return units;
  }

  private normalizeFlat(
    flat: XmlRecord,
    context: FskUnitContext,
    warnings: FeedParserWarning[],
  ): NormalizedFeedUnit | null {
    const externalId = getXmlAttribute(flat, 'Id1C') ?? getXmlAttribute(flat, 'Id');

    if (!externalId) {
      warnings.push({
        code: 'MISSING_EXTERNAL_ID',
        field: 'externalId',
        message: 'FSK flat is missing Id1C and Id',
      });
      return null;
    }

    const fskTypeId = getXmlAttribute(flat, 'Type');
    const flatTypeName = getFskFlatTypeName(context.flatTypeNames, fskTypeId);
    const basePrice = normalizeDecimal(getXmlAttribute(flat, 'Price_tot'), 'price', externalId, warnings);
    const salePrice = normalizePositiveDecimal(getXmlAttribute(flat, 'Price_tot_sale'), 'discountPrice', externalId, warnings);
    const price = basePrice ?? salePrice;
    const discountPrice = basePrice ? getLowerPositiveDecimal(salePrice, basePrice) : null;
    const effectivePrice = discountPrice ?? price;
    const area = normalizeDecimal(getXmlAttribute(flat, 'Square_tot'), 'area', externalId, warnings);
    const completion = parseFskCompletion(context.corpusDelivery);
    const basePricePerMeter =
      normalizeDecimal(getXmlAttribute(flat, 'Price_metr'), 'pricePerMeter', externalId, warnings) ??
      calculatePricePerMeter(price, area);
    const salePricePerMeter = normalizePositiveDecimal(getXmlAttribute(flat, 'Price_metr_sale'), 'discountPricePerMeter', externalId, warnings);
    const pricePerMeter = basePricePerMeter ?? salePricePerMeter;
    const discountPricePerMeter = basePricePerMeter
      ? getLowerPositiveDecimal(salePricePerMeter, basePricePerMeter) ?? calculatePricePerMeter(discountPrice, area)
      : null;
    const effectivePricePerMeter = discountPricePerMeter ?? pricePerMeter ?? calculatePricePerMeter(effectivePrice, area);

    return {
      externalId,
      type: 'RESIDENTIAL',
      status: 'AVAILABLE',
      title: buildFskTitle(context, flatTypeName, externalId),
      projectName: context.complexName,
      address: context.address,
      building: context.corpusNumber,
      section: context.sectionNumber,
      floor: normalizeInteger(getXmlAttribute(flat, 'Floor') ?? context.floorNumber, 'floor', externalId, warnings),
      rooms: normalizeFskRooms(flat, externalId, warnings),
      price,
      discountPrice,
      effectivePrice,
      currency: 'RUR',
      area,
      pricePerMeter,
      discountPricePerMeter,
      effectivePricePerMeter,
      completionYear: completion.year,
      completionQuarter: completion.quarter,
      rawPayload: {
        ...flat,
        DeveloperName: 'ФСК',
        FskRegionName: context.regionName,
        FskComplexName: context.complexName,
        FskComplexId: context.complexId,
        FskComplexId1C: context.complexId1C,
        FskFlatTypeName: flatTypeName,
      },
      media: collectFskMedia(flat, externalId, warnings),
      residentialDetails: {
        apartmentNumber: getXmlAttribute(flat, 'Number'),
        layoutType: flatTypeName,
        livingArea: normalizeDecimal(getXmlAttribute(flat, 'Square_live'), 'livingArea', externalId, warnings),
        kitchenArea: normalizeDecimal(getXmlAttribute(flat, 'Square_kitchen'), 'kitchenArea', externalId, warnings),
        balconyCount: normalizeInteger(getXmlAttribute(flat, 'Balcony_quantity'), 'balconyCount', externalId, warnings),
        detailsJson: {
          fskTypeId,
          fskTypeName: flatTypeName,
          numberOnFloor: getXmlAttribute(flat, 'Num_on_floor'),
          decoration: getXmlAttribute(flat, 'Decoration'),
          salePercent: getXmlAttribute(flat, 'Sale_percent'),
          corpusDelivery: context.corpusDelivery,
        },
      },
      commercialDetails: null,
    };
  }
}

type TektaProjectContext = {
  projectName: string | null;
  address: string | null;
  completionYear: number | null;
  completionQuarter: number | null;
};

type TektaUnitKind = 'flat' | 'office';

export class TektaXmlFeedParser implements FeedParser {
  parse(xml: string): FeedParseResult {
    const root = parseXml(xml);
    const projects = asRecord(root.projects);

    if (!projects) {
      throw new Error('Tekta XML feed must contain <projects>');
    }

    const warnings: FeedParserWarning[] = [];
    const units: NormalizedFeedUnit[] = [];

    for (const projectNode of toArray(projects.project)) {
      const project = asRecord(projectNode);

      if (!project) {
        continue;
      }

      const context = createTektaProjectContext(project);
      const flats = asRecord(project.flats);
      const offices = asRecord(project.offices);

      for (const flatNode of toArray(flats?.flat)) {
        const flat = asRecord(flatNode);

        if (!flat) {
          continue;
        }

        const unit = this.normalizeUnit(flat, 'flat', context, warnings);

        if (unit) {
          units.push(unit);
        }
      }

      for (const officeNode of toArray(offices?.office)) {
        const office = asRecord(officeNode);

        if (!office) {
          continue;
        }

        const unit = this.normalizeUnit(office, 'office', context, warnings);

        if (unit) {
          units.push(unit);
        }
      }
    }

    return { units, warnings };
  }

  private normalizeUnit(
    unit: XmlRecord,
    kind: TektaUnitKind,
    context: TektaProjectContext,
    warnings: FeedParserWarning[],
  ): NormalizedFeedUnit | null {
    const externalId = getTektaExternalId(unit, kind);

    if (!externalId) {
      warnings.push({
        code: 'MISSING_EXTERNAL_ID',
        field: 'externalId',
        message: `Tekta ${kind} is missing id`,
      });
      return null;
    }

    const statusResult = normalizeTektaFeedUnitStatus(unit.Status);

    if (!statusResult) {
      return null;
    }

    if (statusResult.warning) {
      warnings.push(withExternalId(statusResult.warning, externalId));
    }

    const type: NormalizedFeedUnitType = kind === 'office' ? 'COMMERCIAL' : 'RESIDENTIAL';
    const price = normalizeDecimal(unit.IntCost, 'price', externalId, warnings);
    const discountPrice = normalizePositiveDecimal(unit.IntDiscountedCostForSite, 'discountPrice', externalId, warnings);
    const effectivePrice = discountPrice ?? price;
    const area = normalizeDecimal(unit.IntProjectedArea, 'area', externalId, warnings);
    const pricePerMeter = normalizeDecimal(unit.IntPerSquareMeterPrice, 'pricePerMeter', externalId, warnings) ?? calculatePricePerMeter(price, area);
    const discountPricePerMeter =
      normalizePositiveDecimal(unit.IntDiscountedPriceForSite, 'discountPricePerMeter', externalId, warnings) ??
      calculatePricePerMeter(discountPrice, area);
    const effectivePricePerMeter = discountPricePerMeter ?? pricePerMeter;
    const apartmentNumber = getTektaUnitNumber(unit, kind);

    return {
      externalId,
      type,
      status: statusResult.status,
      title: buildTektaTitle(unit, kind, apartmentNumber),
      projectName: getText(unit.Project) ?? context.projectName,
      address: context.address,
      building: getText(unit.Korpus),
      section: getText(unit.IntSection),
      floor: normalizeInteger(unit.IntStorey, 'floor', externalId, warnings),
      rooms: kind === 'flat' ? normalizeTektaRooms(unit, externalId, warnings) : null,
      price,
      discountPrice,
      effectivePrice,
      currency: 'RUR',
      area,
      pricePerMeter,
      discountPricePerMeter,
      effectivePricePerMeter,
      completionYear: context.completionYear,
      completionQuarter: context.completionQuarter,
      rawPayload: {
        ...unit,
        DeveloperName: 'Tekta',
        TektaProjectName: context.projectName,
      },
      media: collectTektaMedia(unit),
      residentialDetails:
        type === 'RESIDENTIAL'
          ? {
              apartmentNumber,
              layoutType: getText(unit.Roominess),
              livingArea: normalizeDecimal(unit.IntLivingAreaByBTI, 'livingArea', externalId, warnings),
              kitchenArea: null,
              balconyCount: normalizeInteger(unit.IntLoggia, 'balconyCount', externalId, warnings),
              detailsJson: {
                objectIntName: getText(unit.ObjectIntName),
                objectType: getText(unit.ObjectType),
                roominess: getText(unit.Roominess),
                numberOnVenue: getText(unit.IntNumberOnVenue),
                decoration: getText(unit.IntDecorationType),
                ceilingHeight: normalizeDecimal(unit.IntCeilingHeight, 'ceilingHeight', externalId, warnings),
                corpusNumber: getText(unit.Korpusnumber),
              },
            }
          : null,
      commercialDetails:
        type === 'COMMERCIAL'
          ? {
              commercialType: getText(unit.IntOfficeType) ?? getText(unit.ObjectType),
              entrance: null,
              ceilingHeight: normalizeDecimal(unit.IntCeilingHeight, 'ceilingHeight', externalId, warnings),
              powerKw: normalizeDecimal(unit.IntPowerSupplyKW, 'powerKw', externalId, warnings),
              separateEntrance: normalizeBoolean(unit.IntSeparateInput),
              detailsJson: {
                officeIntName: getText(unit.officeIntName),
                objectType: getText(unit.ObjectType),
                numberOnVenue: getText(unit.IntNumberOnVenue),
                corpusNumber: getText(unit.Korpusnumber),
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
    const trimmed = decodeXmlText(value).trim();
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

function normalizePlaceholderText(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const normalized = value.trim();

  return normalized === '-' || normalized === '—' || normalized === '–' ? null : normalized;
}

function decodeXmlText(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (entity, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const codePoint = Number.parseInt(body.slice(2), 16);

      return decodeXmlCodePoint(entity, codePoint);
    }

    if (body.startsWith('#')) {
      const codePoint = Number.parseInt(body.slice(1), 10);

      return decodeXmlCodePoint(entity, codePoint);
    }

    const namedEntities: Record<string, string> = {
      amp: '&',
      lt: '<',
      gt: '>',
      quot: '"',
      apos: "'",
    };

    return namedEntities[body.toLowerCase()] ?? entity;
  });
}

function decodeXmlCodePoint(entity: string, codePoint: number): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return entity;
  }

  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return entity;
  }
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

function normalizePositiveDecimal(
  value: unknown,
  field: string,
  externalId: string,
  warnings: FeedParserWarning[],
) {
  const decimal = normalizeDecimal(value, field, externalId, warnings);

  return decimal !== null && Number(decimal) > 0 ? decimal : null;
}

function getLowerPositiveDecimal(value: string | null, baseValue: string | null) {
  if (value === null) {
    return null;
  }

  if (baseValue === null) {
    return value;
  }

  return Number(value) < Number(baseValue) ? value : null;
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

function normalizeFirstInteger(
  values: unknown[],
  field: string,
  externalId: string,
  warnings: FeedParserWarning[],
): number | null {
  for (const value of values) {
    if (getText(value) === null) {
      continue;
    }

    const integer = normalizeInteger(value, field, externalId, warnings);

    if (integer !== null) {
      return integer;
    }
  }

  return null;
}

function normalizeQuarter(value: unknown, externalId: string, warnings: FeedParserWarning[]): number | null {
  const raw = getText(value);

  if (raw === null) {
    return null;
  }

  const textQuarter = normalizeQuarterText(raw);

  if (textQuarter !== null) {
    return textQuarter;
  }

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

function normalizeFirstQuarter(values: unknown[], externalId: string, warnings: FeedParserWarning[]): number | null {
  for (const value of values) {
    if (getText(value) === null) {
      continue;
    }

    const quarter = normalizeQuarter(value, externalId, warnings);

    if (quarter !== null) {
      return quarter;
    }
  }

  return null;
}

function normalizeQuarterText(value: string): number | null {
  const normalized = normalizeFilterText(value).replace(/[\s._-]+/gu, '');
  const numericQuarter = normalized.match(/^([1-4])(?:й|ый|ой)?(?:кв|квартал)?$/u);

  if (numericQuarter) {
    return Number(numericQuarter[1]);
  }

  const quarterAliases: Record<string, number | undefined> = {
    i: 1,
    iкв: 1,
    iквартал: 1,
    first: 1,
    q1: 1,
    первый: 1,
    первыйквартал: 1,
    ii: 2,
    iiкв: 2,
    iiквартал: 2,
    second: 2,
    q2: 2,
    второй: 2,
    второйквартал: 2,
    iii: 3,
    iiiкв: 3,
    iiiквартал: 3,
    third: 3,
    q3: 3,
    третий: 3,
    третийквартал: 3,
    iv: 4,
    ivкв: 4,
    ivквартал: 4,
    fourth: 4,
    q4: 4,
    четвертый: 4,
    четвертыйквартал: 4,
    четвёртый: 4,
    четвёртыйквартал: 4,
  };

  return quarterAliases[normalized] ?? null;
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

function normalizeYandexRooms(
  offer: XmlRecord,
  externalId: string,
  warnings: FeedParserWarning[],
): number | null {
  if (getText(offer.rooms) !== null) {
    return normalizeInteger(offer.rooms, 'rooms', externalId, warnings);
  }

  if (normalizeBoolean(offer.studio) === true || isMangazeyaSeparateRoomsStudio(offer)) {
    return 0;
  }

  return null;
}

function isMangazeyaSeparateRoomsStudio(offer: XmlRecord) {
  const roomsType = normalizeFilterText(getText(offer['rooms-type']) ?? '');

  if (roomsType !== 'раздельные') {
    return false;
  }

  const salesAgent = asRecord(offer['sales-agent']);
  const developerName = normalizeFilterText(
    [
      getText(salesAgent?.organization),
      getText(salesAgent?.name),
      getText(offer['building-name']),
    ]
      .filter((value): value is string => value !== null)
      .join(' '),
  );

  return developerName.includes('мангазея') || developerName.includes('аура');
}

function normalizeCianFeedUnitStatus(object: XmlRecord): FeedStatusNormalizationResult {
  const bookingStatus = asRecord(object.Booking)?.Status;

  if (getText(bookingStatus) !== null) {
    return normalizeFeedUnitStatus(bookingStatus);
  }

  if (getText(object.fl_status) !== null) {
    return normalizeFeedUnitStatus(object.fl_status);
  }

  const numericStatus = normalizeCianNumericStatus(object.Status);

  if (numericStatus) {
    return numericStatus;
  }

  return { status: 'AVAILABLE' };
}

function normalizeCianDiscountPrice(
  object: XmlRecord,
  bargainTerms: XmlRecord | null,
  price: string | null,
  externalId: string,
  warnings: FeedParserWarning[],
) {
  const discountPrice = normalizeFirstPositiveDecimal(
    [
      bargainTerms?.DiscountPrice,
      bargainTerms?.discountPrice,
      bargainTerms?.DiscountedPrice,
      bargainTerms?.discountedPrice,
      bargainTerms?.FinalPrice,
      bargainTerms?.finalPrice,
      object.DiscountPrice,
      object.discountPrice,
      object.DiscountedPrice,
      object.discountedPrice,
    ],
    'discountPrice',
    externalId,
    warnings,
  );

  return getLowerPositiveDecimal(discountPrice, price);
}

function normalizeFirstPositiveDecimal(
  values: unknown[],
  field: string,
  externalId: string,
  warnings: FeedParserWarning[],
) {
  for (const value of values) {
    if (getText(value) === null) {
      continue;
    }

    const decimal = normalizePositiveDecimal(value, field, externalId, warnings);

    if (decimal !== null) {
      return decimal;
    }
  }

  return null;
}

function normalizeCianNumericStatus(value: unknown): FeedStatusNormalizationResult | null {
  const rawStatus = getText(value);

  if (rawStatus === null) {
    return null;
  }

  if (rawStatus === '0') {
    return { status: 'AVAILABLE' };
  }

  if (rawStatus === '1') {
    return { status: 'BOOKED' };
  }

  if (rawStatus === '2') {
    return { status: 'SOLD' };
  }

  if (!/^\d+$/u.test(rawStatus)) {
    return null;
  }

  return {
    status: 'UNKNOWN',
    warning: {
      code: 'UNKNOWN_STATUS',
      field: 'status',
      message: `Unknown Cian numeric feed unit status: ${rawStatus}`,
      value: rawStatus,
    },
  };
}

function normalizeCianCompletion(
  object: XmlRecord,
  building: XmlRecord | null,
  house: XmlRecord | null,
  externalId: string,
  warnings: FeedParserWarning[],
) {
  const deadline = asRecord(building?.Deadline) ?? asRecord(house?.Deadline) ?? asRecord(object.Deadline);
  const deadlineDateCompletion = parseCompletionDate(getText(deadline?.Date ?? deadline?.date));

  return {
    year: normalizeFirstInteger(
      [
        object.CompletionYear,
        object.completionYear,
        object.completion_year,
        object['built-year'],
        object.built_year,
        object.BuildYear,
        object.BuiltYear,
        object.buildYear,
        object.build_year,
        building?.CompletionYear,
        building?.BuildYear,
        building?.BuiltYear,
        building?.buildYear,
        building?.build_year,
        house?.CompletionYear,
        house?.BuildYear,
        house?.BuiltYear,
        house?.buildYear,
        house?.build_year,
        deadline?.Year,
        deadline?.year,
        deadlineDateCompletion.year,
      ],
      'completionYear',
      externalId,
      warnings,
    ),
    quarter: normalizeFirstQuarter(
      [
        object.CompletionQuarter,
        object.completionQuarter,
        object.completion_quarter,
        object['ready-quarter'],
        object.ready_quarter,
        object.ReadyQuarter,
        object.readyQuarter,
        building?.CompletionQuarter,
        building?.ReadyQuarter,
        building?.readyQuarter,
        house?.CompletionQuarter,
        house?.ReadyQuarter,
        house?.readyQuarter,
        deadline?.Quarter,
        deadline?.quarter,
        deadlineDateCompletion.quarter,
      ],
      externalId,
      warnings,
    ),
  };
}

function parseCompletionDate(value: string | null): { year: number | null; quarter: number | null } {
  const match = value?.match(/\b(20\d{2})-(\d{2})-\d{2}\b/u);

  if (!match) {
    return { year: null, quarter: null };
  }

  const year = Number(match[1]);
  const month = Number(match[2]);

  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return { year: null, quarter: null };
  }

  return {
    year,
    quarter: Math.floor((month - 1) / 3) + 1,
  };
}

function normalizeCianRooms(
  object: XmlRecord,
  externalId: string,
  warnings: FeedParserWarning[],
): number | null {
  if (getText(object.RoomsCount) !== null) {
    return normalizeInteger(object.RoomsCount, 'rooms', externalId, warnings);
  }

  const flatRoomsCount = normalizeInteger(object.FlatRoomsCount, 'rooms', externalId, warnings);

  return flatRoomsCount === 9 ? 0 : flatRoomsCount;
}

function normalizeAvitoRooms(
  value: unknown,
  externalId: string,
  warnings: FeedParserWarning[],
): number | null {
  const text = getText(value);

  if (text === null) {
    return null;
  }

  const normalized = normalizeFilterText(text);

  if (normalized.includes('студ')) {
    return 0;
  }

  if (normalized.includes('свобод')) {
    return null;
  }

  return normalizeInteger(value, 'rooms', externalId, warnings);
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

function getAvitoUnitType(ad: XmlRecord): NormalizedFeedUnitType {
  const text = [getText(ad.Category), getText(ad.Status), getText(ad.ObjectType)]
    .filter((value): value is string => value !== null)
    .join(' ')
    .toLowerCase();

  if (
    text.includes('квартир') ||
    text.includes('апартамент') ||
    text.includes('комнат') ||
    text.includes('студ')
  ) {
    return 'RESIDENTIAL';
  }

  return 'COMMERCIAL';
}

function buildYandexTitle(offer: XmlRecord, location: XmlRecord | null): string | null {
  const building = getText(offer['building-name']);
  const category = getText(offer.category);
  const apartment = getYandexApartmentNumber(offer, location);

  return joinTitleParts([building, category, apartment ? `№ ${apartment}` : null]);
}

function getYandexApartmentNumber(offer: XmlRecord, location: XmlRecord | null) {
  return getText(location?.apartment) ?? getText(offer['flat-number']) ?? extractYandexApartmentNumber(getText(offer.description));
}

function extractYandexApartmentNumber(description: string | null) {
  const match = description?.match(/(?:квартира|апартамент(?:ы)?)\s+([A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9./-]*)/iu);

  return match?.[1] ?? null;
}

function buildCianTitle(object: XmlRecord): string | null {
  return joinTitleParts([getText(object.Address), getText(object.Category), getText(object.ExternalId)]);
}

function getCianApartmentNumber(object: XmlRecord, cianFlat: XmlRecord | null) {
  return getText(object.FlatNumber) ?? getText(cianFlat?.FlatNumber) ?? getText(object.Apartment);
}

function buildCianUnitTitle(
  object: XmlRecord,
  type: NormalizedFeedUnitType,
  apartmentNumber: string | null,
): string | null {
  if (type === 'RESIDENTIAL' && apartmentNumber && shouldUseApartmentNumberTitleForCianObject(object)) {
    return `Квартира №${apartmentNumber}`;
  }

  const title = getText(object.title) ?? getText(object.Title);

  if (title) {
    return title;
  }

  if (type === 'RESIDENTIAL' && apartmentNumber) {
    return `Квартира №${apartmentNumber}`;
  }

  return buildCianTitle(object);
}

function shouldUseApartmentNumberTitleForCianObject(object: XmlRecord) {
  return isSminexCianObject(object) || isPioneerCianObject(object);
}

function isSminexCianObject(object: XmlRecord) {
  const developerName = getText(asRecord(object.Developer)?.Name) ?? getText(object.DeveloperName);
  const normalizedDeveloperName = developerName?.trim().toLocaleLowerCase('ru-RU') ?? '';

  return normalizedDeveloperName.includes('sminex') || normalizedDeveloperName.includes('смайнекс');
}

function isPioneerCianObject(object: XmlRecord) {
  const subAgent = asRecord(object.SubAgent);
  const normalizedSourceText = [
    getText(asRecord(object.Developer)?.Name),
    getText(object.DeveloperName),
    getText(subAgent?.FirstName),
    getText(subAgent?.LastName),
    getText(subAgent?.CompanyName),
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLocaleLowerCase('ru-RU');

  return isPioneerText(normalizedSourceText);
}

function buildAvitoTitle(ad: XmlRecord, externalId: string): string | null {
  return joinTitleParts([getText(ad.Address), getText(ad.Category) ?? getText(ad.Status), externalId]);
}

function extractAvitoBuilding(address: string | null) {
  const match = address?.match(/(?:^|[,;\s])((?:корпус|корп\.?|к\.)\s*[A-Za-zА-Яа-яЁё0-9./-]+)/iu);

  return match?.[1]?.trim() ?? null;
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

  for (const layoutPhotoNode of toArray(object.LayoutPhoto)) {
    const layoutPhoto = asRecord(layoutPhotoNode);

    for (const sourceUrl of getTextValues(layoutPhoto?.FullUrl)) {
      addMedia(media, seen, sourceUrl, 'layout-photo', externalId, warnings);
    }
  }

  for (const photosNode of toArray(object.Photos)) {
    const photos = asRecord(photosNode);

    for (const photo of toArray(photos?.PhotoSchema)) {
      const photoRecord = asRecord(photo);

      for (const sourceUrl of getTextValues(photoRecord?.FullUrl)) {
        addMedia(media, seen, sourceUrl, 'photo', externalId, warnings);
      }
    }
  }

  return media;
}

function collectAvitoMedia(
  ad: XmlRecord,
  externalId: string,
  warnings: FeedParserWarning[],
): NormalizedFeedMedia[] {
  const media: NormalizedFeedMedia[] = [];
  const seen = new Set<string>();
  const images = asRecord(ad.Images);

  for (const image of toArray(images?.Image ?? ad.Image)) {
    const imageRecord = asRecord(image);
    const sourceUrl = getText(imageRecord?.['@_url']) ?? getText(image);
    const label = getText(imageRecord?.['@_tag']) ?? 'photo';
    addMedia(media, seen, sourceUrl, label, externalId, warnings);
  }

  return media;
}

function getAvitoBalconyCount(ad: XmlRecord) {
  const values = [
    ...getTextValues(ad.BalconyOrLoggiaMulti),
    ...getTextValues(ad.BalconyOrLoggia),
  ];

  return values.length > 0 ? values.length : null;
}

function collectFskFlatTypeNames(data: XmlRecord) {
  const flatTypes = asRecord(data.FlatTypes);
  const names = new Map<string, string>();

  for (const flatTypeNode of toArray(flatTypes?.FlatType)) {
    const flatType = asRecord(flatTypeNode);
    const id = flatType ? getXmlAttribute(flatType, 'ID') : null;
    const name = flatType ? getXmlAttribute(flatType, 'Name') : null;

    if (id && name) {
      names.set(id, name);
    }
  }

  return names;
}

function isFskResidentialFlat(flat: XmlRecord) {
  const typeId = getXmlAttribute(flat, 'Type');

  return Boolean(typeId && fskResidentialFlatTypeIds.has(typeId));
}

function getFskFlatTypeName(flatTypeNames: Map<string, string>, typeId: string | null) {
  return (typeId ? flatTypeNames.get(typeId) : null) ?? 'Жилой лот';
}

function buildFskTitle(context: FskUnitContext, flatTypeName: string, externalId: string) {
  return joinTitleParts([context.complexName, flatTypeName, externalId]);
}

function normalizeFskRooms(flat: XmlRecord, externalId: string, warnings: FeedParserWarning[]) {
  const typeId = getXmlAttribute(flat, 'Type');

  if (typeId && fskStudioFlatTypeIds.has(typeId)) {
    return 0;
  }

  return normalizeInteger(getXmlAttribute(flat, 'Rooms'), 'rooms', externalId, warnings);
}

function parseFskCompletion(value: string | null): { year: number | null; quarter: number | null } {
  const match = value?.match(/^(\d{4})-(\d{2})-\d{2}/u);

  if (!match) {
    return { year: null, quarter: null };
  }

  const year = Number(match[1]);
  const month = Number(match[2]);

  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return { year: null, quarter: null };
  }

  return {
    year,
    quarter: Math.floor((month - 1) / 3) + 1,
  };
}

function collectFskMedia(
  flat: XmlRecord,
  externalId: string,
  warnings: FeedParserWarning[],
): NormalizedFeedMedia[] {
  const media: NormalizedFeedMedia[] = [];
  const seen = new Set<string>();
  const mediaAttributes: Array<[string, string]> = [
    ['Flat_plan', 'flat-plan'],
    ['Floor_plan', 'floor-plan'],
    ['Flat_plan_furniture', 'flat-plan-furniture'],
    ['Flat_plan_3d', 'flat-plan-3d'],
  ];

  for (const [attributeName, label] of mediaAttributes) {
    addMedia(media, seen, getXmlAttribute(flat, attributeName), label, externalId, warnings);
  }

  return media;
}

function createTektaProjectContext(project: XmlRecord): TektaProjectContext {
  const completion = parseTektaCompletion(getText(project.IntEstimatedCompletionDate));

  return {
    projectName: getText(project.IntName),
    address: getText(project.IntBuildingAddress) ?? getText(project.IntPostAdress),
    completionYear: completion.year,
    completionQuarter: completion.quarter,
  };
}

function getTektaExternalId(unit: XmlRecord, kind: TektaUnitKind) {
  return (
    getText(kind === 'office' ? unit.officeId : unit.ObjectId) ??
    getText(kind === 'office' ? unit.officeIntName : unit.ObjectIntName)
  );
}

function getTektaUnitNumber(unit: XmlRecord, kind: TektaUnitKind) {
  return (
    getText(unit.IntProjectNumber) ??
    getText(kind === 'office' ? unit.officeIntName : unit.IntBTINumber) ??
    getText(kind === 'office' ? unit.officeId : unit.ObjectId)
  );
}

function normalizeTektaFeedUnitStatus(value: unknown): FeedStatusNormalizationResult | null {
  const rawStatus = getText(value);
  const normalized = normalizeFilterText(rawStatus ?? '');

  if (normalized === 'сдан' || normalized === 'скрывать на сайте') {
    return null;
  }

  if (normalized === 'свободен') {
    return { status: 'AVAILABLE' };
  }

  if (normalized === 'устная бронь' || normalized === 'платная бронь') {
    return { status: 'BOOKED' };
  }

  if (normalized === 'резерв') {
    return { status: 'RESERVED' };
  }

  if (normalized === 'продан') {
    return { status: 'SOLD' };
  }

  if (normalized === 'снято с продажи') {
    return { status: 'ARCHIVED' };
  }

  return {
    status: 'UNKNOWN',
    warning: {
      code: 'UNKNOWN_STATUS',
      field: 'status',
      message: `Unknown Tekta feed unit status: ${rawStatus ?? 'empty'}`,
      value: rawStatus,
    },
  };
}

function buildTektaTitle(unit: XmlRecord, kind: TektaUnitKind, number: string | null) {
  const label = kind === 'office' ? 'Офис' : 'Квартира';

  if (number) {
    return `${label} №${number}`;
  }

  return joinTitleParts([label, getText(unit.Project), getText(unit.Korpus)]);
}

function normalizeTektaRooms(unit: XmlRecord, externalId: string, warnings: FeedParserWarning[]) {
  const layoutType = normalizeFilterText(getText(unit.Roominess) ?? '');

  if (layoutType.includes('ст') || /^[0-9]*с$/u.test(layoutType)) {
    return 0;
  }

  return normalizeInteger(unit.IntRoomCount, 'rooms', externalId, warnings);
}

function parseTektaCompletion(value: string | null): { year: number | null; quarter: number | null } {
  if (!value) {
    return { year: null, quarter: null };
  }

  const yearMatch = value.match(/\b(20\d{2})\b/u);
  const year = yearMatch ? Number(yearMatch[1]) : null;

  if (!year) {
    return { year: null, quarter: null };
  }

  const normalized = normalizeFilterText(value);
  const monthQuarters: Array<[string, number]> = [
    ['январ', 1],
    ['феврал', 1],
    ['март', 1],
    ['апрел', 2],
    ['май', 2],
    ['мая', 2],
    ['июн', 2],
    ['июл', 3],
    ['август', 3],
    ['сентябр', 3],
    ['октябр', 4],
    ['ноябр', 4],
    ['декабр', 4],
  ];
  const quarter = monthQuarters.find(([month]) => normalized.includes(month))?.[1] ?? null;

  return { year, quarter };
}

function collectTektaMedia(unit: XmlRecord): NormalizedFeedMedia[] {
  const media: NormalizedFeedMedia[] = [];
  const seen = new Set<string>();
  const mediaFields: Array<[unknown, string]> = [
    [unit.IntLayoutCode, 'layout'],
    [unit.IntLinkPhoto, 'photo'],
    [unit.IntProjectPhoto, 'photo'],
  ];

  for (const [value, label] of mediaFields) {
    const sourceUrl = getText(value);

    if (!sourceUrl || !isHttpUrl(sourceUrl) || seen.has(sourceUrl)) {
      continue;
    }

    seen.add(sourceUrl);
    media.push({
      sourceUrl,
      sortOrder: media.length,
      label,
    });
  }

  return media;
}

function getXmlAttribute(record: XmlRecord, name: string) {
  return getText(record[`@_${name}`]);
}

function getTextValues(value: unknown) {
  return toArray(value)
    .map((item) => getText(item))
    .filter((item): item is string => item !== null);
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
type FeedSourceFormat = 'YANDEX_REALTY' | 'CIAN_XML' | 'AVITO_XML' | 'FSK_XML' | 'TEKTA_XML';
type FeedAnalyzeFormat = FeedSourceFormat | 'AUTO';
type FeedSourceKind = 'URL' | 'FILE' | 'INDEX_URL';
type FeedUnitStatusValue = NormalizedFeedUnitStatus;
type DecimalLike = string | number | { toString: () => string };
type ParsedFeedIndexResult = {
  format: FeedSourceFormat;
  parsed: FeedParseResult;
};

type FeedIndexLinkCandidate = {
  url: string;
  objectName: string | null;
};

const activeFeedUnitStatuses: FeedUnitStatusValue[] = ['AVAILABLE', 'BOOKED', 'RESERVED'];
const supportedFeedSourceFormats: FeedSourceFormat[] = ['YANDEX_REALTY', 'CIAN_XML', 'AVITO_XML', 'FSK_XML', 'TEKTA_XML'];

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
  filterJson?: Record<string, unknown> | null;
  developerId: string;
  developer?: {
    name: string;
    normalizedName?: string | null;
  } | null;
  objectId: string | null;
  mappings?: FeedSourceMappingRecord[];
  isActive: boolean;
  deletedAt?: Date | null;
  lastPreviewAt: Date | null;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
};

type FeedSourceMappingRecord = {
  id: string;
  sourceId: string;
  objectId: string;
  sourceKey: string;
  sourceTitle: string;
  filterJson: Record<string, unknown>;
  isActive: boolean;
};

type RoutedFeedUnit = {
  unit: NormalizedFeedUnit;
  objectId: string;
};

type ExistingFeedUnitRecord = {
  id: string;
  sourceId: string;
  objectId: string;
  externalId: string;
  status: FeedUnitStatusValue;
  price?: DecimalLike | null;
  discountPrice?: DecimalLike | null;
  effectivePrice?: DecimalLike | null;
  area?: DecimalLike | null;
  pricePerMeter?: DecimalLike | null;
  discountPricePerMeter?: DecimalLike | null;
  effectivePricePerMeter?: DecimalLike | null;
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
  discountPrice: string | null;
  effectivePrice: string | null;
  currency: string | null;
  area: string | null;
  pricePerMeter: string | null;
  discountPricePerMeter: string | null;
  effectivePricePerMeter: string | null;
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
        developer?: {
          select: {
            name: true;
            normalizedName: true;
          };
        };
        mappings?: true | {
          orderBy: {
            sourceTitle: 'asc';
          };
        };
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
    }) => Promise<{
      id: string;
      sourceId: string;
      mode: ImportModeValue;
      status: ImportStatusValue;
      startedAt: Date;
    }>;
    findUnique: (args: {
      where: { id: string };
    }) => Promise<{
      id: string;
      sourceId: string;
      mode: ImportModeValue;
      status: ImportStatusValue;
      startedAt: Date;
    } | null>;
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
        source?: {
          deletedAt: null;
        };
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

export type FeedSourceAnalysisObject = {
  title: string;
  unitsCount: number;
  feedIndexSourceUrls: string[];
  projectNames: string[];
  externalIds: string[];
  buildingNames: string[];
  yandexBuildingIds: string[];
  yandexHouseIds: string[];
  avitoDevelopmentIds: string[];
  addresses: string[];
  filterJson: Record<string, string[]> | null;
};

export type FeedSourceAnalysis = {
  format: FeedSourceFormat;
  developerName: string | null;
  unitsCount: number;
  objects: FeedSourceAnalysisObject[];
  warningsCount: number;
  warnings: FeedParserWarning[];
};

export type FeedIndexFileCandidate = {
  url: string;
  format: FeedSourceFormat | null;
  unitsCount: number;
  warningsCount: number;
  error: string | null;
};

export type FeedIndexPlatformCandidate = {
  format: FeedSourceFormat;
  label: string;
  filesCount: number;
  unitsCount: number;
  warningsCount: number;
  errorsCount: number;
  files: FeedIndexFileCandidate[];
};

export type FeedIndexDiscovery = {
  sourceUrl: string;
  files: FeedIndexFileCandidate[];
  platforms: FeedIndexPlatformCandidate[];
};

export type FeedSourceAnalyzeResult = {
  discovery: FeedIndexDiscovery | null;
  analysis: FeedSourceAnalysis | null;
};

export type ExecuteFeedImportOptions = {
  mode: FeedImportCommand;
  sourceId: string;
  reportId?: string | null;
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
  affectedObjectIds: string[];
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
  runId: string | null;
};

export type ParsedFeedAnalyzeCliArgs = {
  command: FeedAnalyzeCommand;
  format: FeedAnalyzeFormat;
  sourceKind: FeedSourceKind;
  url: string | null;
  filePath: string | null;
  outputPath: string | null;
};

export function parseFeedImportCliArgs(args: string[]): ParsedFeedImportCliArgs | null {
  const command = parseFeedImportCommand(args[0]);

  if (!command) {
    return null;
  }

  let sourceId: string | null = null;
  let runId: string | null = null;

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

    if (arg === '--run-id') {
      const nextValue = args[index + 1];

      if (!nextValue) {
        return null;
      }

      runId = nextValue;
      index += 1;
      continue;
    }

    if (arg?.startsWith('--run-id=')) {
      const value = arg.slice('--run-id='.length).trim();

      if (!value) {
        return null;
      }

      runId = value;
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
    runId,
  };
}

export function parseFeedAnalyzeCliArgs(args: string[]): ParsedFeedAnalyzeCliArgs | null {
  if (args[0] !== 'analyze') {
    return null;
  }

  let format: FeedAnalyzeFormat | null = null;
  let sourceKind: FeedSourceKind | null = null;
  let url: string | null = null;
  let filePath: string | null = null;
  let outputPath: string | null = null;

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    const nextValue = args[index + 1];

    if (arg === '--') {
      continue;
    }

    if (arg === '--format' && nextValue) {
      format = parseFeedSourceFormatCliValue(nextValue);
      index += 1;
      continue;
    }

    if (arg?.startsWith('--format=')) {
      format = parseFeedSourceFormatCliValue(arg.slice('--format='.length));
      continue;
    }

    if (arg === '--source-kind' && nextValue) {
      sourceKind = parseFeedSourceKindCliValue(nextValue);
      index += 1;
      continue;
    }

    if (arg?.startsWith('--source-kind=')) {
      sourceKind = parseFeedSourceKindCliValue(arg.slice('--source-kind='.length));
      continue;
    }

    if (arg === '--url' && nextValue) {
      url = nextValue.trim();
      index += 1;
      continue;
    }

    if (arg?.startsWith('--url=')) {
      url = arg.slice('--url='.length).trim();
      continue;
    }

    if (arg === '--file' && nextValue) {
      filePath = nextValue.trim();
      index += 1;
      continue;
    }

    if (arg?.startsWith('--file=')) {
      filePath = arg.slice('--file='.length).trim();
      continue;
    }

    if (arg === '--output' && nextValue) {
      outputPath = nextValue.trim();
      index += 1;
      continue;
    }

    if (arg?.startsWith('--output=')) {
      outputPath = arg.slice('--output='.length).trim();
      continue;
    }

    return null;
  }

  if (!format || Boolean(url) === Boolean(filePath)) {
    return null;
  }

  if (url && !isHttpUrl(url)) {
    return null;
  }

  const resolvedSourceKind = sourceKind ?? (filePath ? 'FILE' : 'URL');

  if (resolvedSourceKind === 'FILE' && !filePath) {
    return null;
  }

  if (resolvedSourceKind !== 'FILE' && !url) {
    return null;
  }

  return {
    command: 'analyze',
    format,
    sourceKind: resolvedSourceKind,
    url,
    filePath,
    outputPath,
  };
}

function parseFeedSourceFormatCliValue(value: string): FeedAnalyzeFormat | null {
  const normalized = value.trim().toUpperCase();

  if (
    normalized === 'YANDEX_REALTY' ||
    normalized === 'CIAN_XML' ||
    normalized === 'AVITO_XML' ||
    normalized === 'FSK_XML' ||
    normalized === 'TEKTA_XML'
  ) {
    return normalized;
  }

  if (normalized === 'AUTO') {
    return normalized;
  }

  return null;
}

function parseFeedSourceKindCliValue(value: string): FeedSourceKind | null {
  const normalized = value.trim().toUpperCase();

  if (normalized === 'URL' || normalized === 'FILE' || normalized === 'INDEX_URL') {
    return normalized;
  }

  return null;
}

export function createFeedParserForFormat(format: FeedSourceFormat): FeedParser {
  if (format === 'YANDEX_REALTY') {
    return new YandexRealtyFeedParser();
  }

  if (format === 'CIAN_XML') {
    return new CianXmlFeedParser();
  }

  if (format === 'AVITO_XML') {
    return new AvitoXmlFeedParser();
  }

  if (format === 'FSK_XML') {
    return new FskXmlFeedParser();
  }

  if (format === 'TEKTA_XML') {
    return new TektaXmlFeedParser();
  }

  throw new Error(`Unsupported feed format: ${format satisfies never}`);
}

export function detectFeedFormatFromXml(xml: string): FeedSourceFormat | null {
  try {
    const root = parseXml(xml);
    const yandexFeed = asRecord(root['realty-feed']);

    if (yandexFeed) {
      if (hasXmlNodes(yandexFeed.object)) {
        return 'CIAN_XML';
      }

      if (hasXmlNodes(yandexFeed.offer)) {
        return 'YANDEX_REALTY';
      }

      return 'YANDEX_REALTY';
    }

    if (asRecord(root.feed) || asRecord(root.Feed)) {
      return 'CIAN_XML';
    }

    if (asRecord(root.Ads)) {
      return 'AVITO_XML';
    }

    const fskData = asRecord(root.Data);

    if (fskData && isFskFeedRoot(fskData)) {
      return 'FSK_XML';
    }

    const tektaProjects = asRecord(root.projects);

    if (tektaProjects && isTektaFeedRoot(tektaProjects)) {
      return 'TEKTA_XML';
    }
  } catch {
    return null;
  }

  return null;
}

function getCianFeedRoot(root: XmlRecord): XmlRecord | null {
  const feed = asRecord(root.feed) ?? asRecord(root.Feed);

  if (feed) {
    return feed;
  }

  const realtyFeed = asRecord(root['realty-feed']);

  if (realtyFeed && hasXmlNodes(realtyFeed.object)) {
    return realtyFeed;
  }

  return null;
}

function isFskFeedRoot(data: XmlRecord) {
  const flatTypes = asRecord(data.FlatTypes);
  const regions = asRecord(data.Regions);

  if (!hasXmlNodes(flatTypes?.FlatType) || !regions) {
    return false;
  }

  return toArray(regions.Region)
    .map(asRecord)
    .filter((region): region is XmlRecord => region !== null)
    .some((region) =>
      toArray(region.Object)
        .map(asRecord)
        .filter((object): object is XmlRecord => object !== null)
        .some((object) => hasXmlNodes(asRecord(object.Buildings)?.Corpus)),
    );
}

function isTektaFeedRoot(projects: XmlRecord) {
  return toArray(projects.project)
    .map(asRecord)
    .filter((project): project is XmlRecord => project !== null)
    .some((project) => {
      const flats = asRecord(project.flats);
      const offices = asRecord(project.offices);

      return hasXmlNodes(flats?.flat) || hasXmlNodes(offices?.office);
    });
}

function hasXmlNodes(value: unknown): boolean {
  return toArray(value).some((item) => asRecord(item) !== null);
}

export function discoverFeedIndexLinks(html: string, baseUrl: string): string[] {
  return discoverFeedIndexLinkCandidates(html, baseUrl).map((candidate) => candidate.url);
}

function discoverFeedIndexLinkCandidates(content: string, baseUrl: string): FeedIndexLinkCandidate[] {
  if (isGoogleSheetsUrl(baseUrl)) {
    return discoverGoogleSheetsFeedIndexLinks(content);
  }

  return discoverHtmlFeedIndexLinks(content, baseUrl);
}

function discoverHtmlFeedIndexLinks(html: string, baseUrl: string): FeedIndexLinkCandidate[] {
  const base = new URL(baseUrl);
  const urls: FeedIndexLinkCandidate[] = [];
  const seen = new Set<string>();
  const hrefPattern = /\bhref\s*=\s*["']([^"']+\.xml(?:\?[^"']*)?)["']/giu;

  for (const match of html.matchAll(hrefPattern)) {
    const href = match[1]?.trim();

    if (!href) {
      continue;
    }

    try {
      const resolved = new URL(href, base);

      if (resolved.origin !== base.origin) {
        continue;
      }

      const url = resolved.toString();

      if (!seen.has(url)) {
        seen.add(url);
        urls.push({
          url,
          objectName: null,
        });
      }
    } catch {
      continue;
    }
  }

  return urls;
}

function discoverGoogleSheetsFeedIndexLinks(csv: string): FeedIndexLinkCandidate[] {
  const urls: FeedIndexLinkCandidate[] = [];
  const seen = new Set<string>();

  for (const row of parseCsvRows(csv)) {
    const objectName = row[0]?.trim() ?? '';
    const feedUrl = row[1]?.trim() ?? '';

    if (!isHttpUrl(feedUrl) || seen.has(feedUrl)) {
      continue;
    }

    seen.add(feedUrl);
    urls.push({
      url: feedUrl,
      objectName: objectName || null,
    });
  }

  return urls;
}

function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];

    if (inQuotes) {
      if (char === '"' && csv[index + 1] === '"') {
        field += '"';
        index += 1;
        continue;
      }

      if (char === '"') {
        inQuotes = false;
        continue;
      }

      field += char;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }

    if (char === '\n' || char === '\r') {
      if (char === '\r' && csv[index + 1] === '\n') {
        index += 1;
      }

      row.push(field);
      pushCsvRow(rows, row);
      row = [];
      field = '';
      continue;
    }

    field += char;
  }

  row.push(field);
  pushCsvRow(rows, row);

  return rows;
}

function pushCsvRow(rows: string[][], row: string[]) {
  if (row.some((field) => field.trim().length > 0)) {
    rows.push(row);
  }
}

export async function analyzeFeedSourceInput(params: {
  format: FeedAnalyzeFormat;
  sourceKind?: FeedSourceKind;
  url?: string | null;
  filePath?: string | null;
  xmlFetcher?: (url: string) => Promise<string>;
}): Promise<FeedSourceAnalyzeResult> {
  const sourceKind = params.sourceKind ?? (params.filePath ? 'FILE' : 'URL');

  if (sourceKind === 'INDEX_URL') {
    if (!params.url) {
      throw new Error('Index feed analysis requires URL');
    }

    if (params.format === 'AUTO') {
      const { format, parsed } = await parseFeedIndexAutomatically({
        sourceUrl: params.url,
        xmlFetcher: params.xmlFetcher,
        namespaceExternalIds: false,
      });

      return {
        discovery: null,
        analysis: createFeedSourceAnalysis(format, parsed),
      };
    }

    const parsed = await parseFeedIndexForFormat({
      sourceUrl: params.url,
      format: params.format,
      xmlFetcher: params.xmlFetcher,
      namespaceExternalIds: false,
    });

    return {
      discovery: null,
      analysis: createFeedSourceAnalysis(params.format, parsed),
    };
  }

  const xml = params.filePath
    ? await readFile(params.filePath, 'utf8')
    : await fetchFeedText(params.url ?? '', params.xmlFetcher);
  const format = params.format === 'AUTO' ? detectFeedFormatFromXml(xml) : params.format;

  if (!format) {
    throw new Error('Could not detect feed XML format');
  }

  const parser = createFeedParserForFormat(format);

  return {
    discovery: null,
    analysis: createFeedSourceAnalysis(format, parser.parse(xml)),
  };
}

async function createFeedIndexDiscovery(params: {
  sourceUrl: string;
  xmlFetcher?: (url: string) => Promise<string>;
}): Promise<FeedIndexDiscovery> {
  const indexContent = await fetchFeedText(getFeedIndexContentUrl(params.sourceUrl), params.xmlFetcher);
  const links = discoverFeedIndexLinkCandidates(indexContent, params.sourceUrl);
  const files: FeedIndexFileCandidate[] = [];

  for (const link of links) {
    files.push(await analyzeFeedIndexFile(link.url, params.xmlFetcher));
  }

  return {
    sourceUrl: params.sourceUrl,
    files,
    platforms: createFeedIndexPlatformCandidates(files),
  };
}

async function analyzeFeedIndexFile(
  url: string,
  xmlFetcher?: (url: string) => Promise<string>,
): Promise<FeedIndexFileCandidate> {
  try {
    const xml = await fetchFeedText(url, xmlFetcher);
    const format = detectFeedFormatFromXml(xml);

    if (!format) {
      return {
        url,
        format: null,
        unitsCount: 0,
        warningsCount: 0,
        error: 'Unsupported XML feed format',
      };
    }

    const parsed = createFeedParserForFormat(format).parse(xml);

    return {
      url,
      format,
      unitsCount: parsed.units.length,
      warningsCount: parsed.warnings.length,
      error: null,
    };
  } catch (error) {
    return {
      url,
      format: null,
      unitsCount: 0,
      warningsCount: 0,
      error: getErrorMessage(error),
    };
  }
}

function createFeedIndexPlatformCandidates(files: FeedIndexFileCandidate[]): FeedIndexPlatformCandidate[] {
  return supportedFeedSourceFormats.flatMap((format) => {
    const formatFiles = files.filter((file) => file.format === format);

    if (formatFiles.length === 0) {
      return [];
    }

    return [
      {
        format,
        label: getFeedFormatLabel(format),
        filesCount: formatFiles.length,
        unitsCount: formatFiles.reduce((sum, file) => sum + file.unitsCount, 0),
        warningsCount: formatFiles.reduce((sum, file) => sum + file.warningsCount, 0),
        errorsCount: formatFiles.filter((file) => file.error !== null).length,
        files: formatFiles,
      },
    ];
  });
}

function getFeedFormatLabel(format: FeedSourceFormat) {
  if (format === 'YANDEX_REALTY') {
    return 'Yandex Realty';
  }

  if (format === 'CIAN_XML') {
    return 'Cian XML';
  }

  if (format === 'AVITO_XML') {
    return 'Avito XML';
  }

  if (format === 'FSK_XML') {
    return 'FSK XML';
  }

  if (format === 'TEKTA_XML') {
    return 'Tekta XML';
  }

  return format satisfies never;
}

async function parseFeedIndexForFormat(params: {
  sourceUrl: string;
  format: FeedSourceFormat;
  xmlFetcher?: (url: string) => Promise<string>;
  namespaceExternalIds: boolean;
}): Promise<FeedParseResult> {
  const indexContent = await fetchFeedText(getFeedIndexContentUrl(params.sourceUrl), params.xmlFetcher);
  const links = discoverFeedIndexLinkCandidates(indexContent, params.sourceUrl);
  const sources = links.length > 0 ? links : [{ url: params.sourceUrl, objectName: null }];
  const units: NormalizedFeedUnit[] = [];
  const warnings: FeedParserWarning[] = [];
  let matchedFilesCount = 0;

  for (const source of sources) {
    try {
      const xml = source.url === params.sourceUrl && links.length === 0
        ? indexContent
        : await fetchFeedText(source.url, params.xmlFetcher);
      const detectedFormat = detectFeedFormatFromXml(xml);

      if (detectedFormat !== params.format) {
        continue;
      }

      matchedFilesCount += 1;
      const parsed = createFeedParserForFormat(params.format).parse(xml);
      warnings.push(...parsed.warnings);
      units.push(
        ...parsed.units.map((unit) =>
          applyFeedIndexSourceMetadata(source, unit, params.namespaceExternalIds, detectedFormat),
        ),
      );
    } catch (error) {
      warnings.push({
        code: 'INDEX_XML_FAILED',
        field: 'url',
        message: `Failed to parse index XML file ${source.url}: ${getErrorMessage(error)}`,
        value: source.url,
      });
    }
  }

  if (matchedFilesCount === 0) {
    throw new Error(`Index URL ${params.sourceUrl} does not contain ${params.format} XML files`);
  }

  return { units, warnings };
}

async function parseFeedIndexAutomatically(params: {
  sourceUrl: string;
  xmlFetcher?: (url: string) => Promise<string>;
  namespaceExternalIds: boolean;
}): Promise<ParsedFeedIndexResult> {
  const indexContent = await fetchFeedText(getFeedIndexContentUrl(params.sourceUrl), params.xmlFetcher);
  const links = discoverFeedIndexLinkCandidates(indexContent, params.sourceUrl);
  const sources = links.length > 0 ? links : [{ url: params.sourceUrl, objectName: null }];
  const units: NormalizedFeedUnit[] = [];
  const warnings: FeedParserWarning[] = [];
  const formatUnitsCounts = new Map<FeedSourceFormat, number>();
  let matchedFilesCount = 0;

  for (const source of sources) {
    try {
      const xml = source.url === params.sourceUrl && links.length === 0
        ? indexContent
        : await fetchFeedText(source.url, params.xmlFetcher);
      const detectedFormat = detectFeedFormatFromXml(xml);

      if (!detectedFormat) {
        warnings.push({
          code: 'INDEX_XML_FAILED',
          field: 'url',
          message: `Failed to parse index XML file ${source.url}: Unsupported XML feed format`,
          value: source.url,
        });
        continue;
      }

      const parsed = createFeedParserForFormat(detectedFormat).parse(xml);

      matchedFilesCount += 1;
      formatUnitsCounts.set(detectedFormat, (formatUnitsCounts.get(detectedFormat) ?? 0) + parsed.units.length);
      warnings.push(...parsed.warnings);
      units.push(
        ...parsed.units.map((unit) =>
          applyFeedIndexSourceMetadata(source, unit, params.namespaceExternalIds, detectedFormat),
        ),
      );
    } catch (error) {
      warnings.push({
        code: 'INDEX_XML_FAILED',
        field: 'url',
        message: `Failed to parse index XML file ${source.url}: ${getErrorMessage(error)}`,
        value: source.url,
      });
    }
  }

  if (matchedFilesCount === 0) {
    throw new Error(`Index URL ${params.sourceUrl} does not contain supported XML files`);
  }

  return {
    format: getDominantFeedIndexFormat(formatUnitsCounts),
    parsed: { units, warnings },
  };
}

function getDominantFeedIndexFormat(formatUnitsCounts: Map<FeedSourceFormat, number>): FeedSourceFormat {
  const dominant = supportedFeedSourceFormats
    .map((format) => ({
      format,
      unitsCount: formatUnitsCounts.get(format) ?? 0,
    }))
    .sort((left, right) => right.unitsCount - left.unitsCount)[0];

  return dominant?.format ?? 'YANDEX_REALTY';
}

function getFeedIndexContentUrl(sourceUrl: string) {
  return createGoogleSheetsCsvExportUrl(sourceUrl) ?? sourceUrl;
}

function isGoogleSheetsUrl(sourceUrl: string) {
  return createGoogleSheetsCsvExportUrl(sourceUrl) !== null;
}

function createGoogleSheetsCsvExportUrl(sourceUrl: string) {
  try {
    const url = new URL(sourceUrl);

    if (url.hostname !== 'docs.google.com') {
      return null;
    }

    const spreadsheetId = url.pathname.match(/\/spreadsheets\/d\/([^/]+)/u)?.[1];

    if (!spreadsheetId) {
      return null;
    }

    const hashParams = new URLSearchParams(url.hash.replace(/^#/u, ''));
    const gid = url.searchParams.get('gid') ?? hashParams.get('gid') ?? '0';
    const exportUrl = new URL(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/export`);

    exportUrl.searchParams.set('format', 'csv');
    exportUrl.searchParams.set('gid', gid);

    return exportUrl.toString();
  } catch {
    return null;
  }
}

function applyFeedIndexSourceMetadata(
  source: FeedIndexLinkCandidate,
  unit: NormalizedFeedUnit,
  namespaceExternalIds: boolean,
  detectedFormat: FeedSourceFormat,
): NormalizedFeedUnit {
  const nextUnit = namespaceExternalIds ? namespaceIndexFeedUnitExternalId(source.url, unit) : unit;

  return {
    ...nextUnit,
    rawPayload: {
      ...nextUnit.rawPayload,
      __feedIndexSourceUrl: source.url,
      __feedDetectedFormat: detectedFormat,
      ...(source.objectName ? { __feedIndexObjectName: source.objectName } : {}),
    },
  };
}

function namespaceIndexFeedUnitExternalId(sourceUrl: string, unit: NormalizedFeedUnit): NormalizedFeedUnit {
  const namespace = createHash('sha1').update(sourceUrl).digest('hex').slice(0, 12);
  const maxRawLength = 255 - namespace.length - 1;
  const rawExternalId = unit.externalId;

  return {
    ...unit,
    externalId: `${namespace}:${rawExternalId.slice(0, maxRawLength)}`,
    rawPayload: {
      ...unit.rawPayload,
      __feedIndexSourceUrl: sourceUrl,
      __rawExternalId: rawExternalId,
    },
  };
}

async function fetchFeedText(url: string, xmlFetcher?: (url: string) => Promise<string>) {
  const text = await (xmlFetcher ?? loadXmlFromUrl)(url);

  if (typeof text !== 'string') {
    throw new Error(`Feed URL ${url} returned empty response`);
  }

  return text;
}

export function createFeedSourceAnalysis(format: FeedSourceFormat, parsed: FeedParseResult): FeedSourceAnalysis {
  const groups = new Map<string, FeedSourceAnalysisObject>();

  for (const unit of parsed.units) {
    const groupKey = getFeedAnalysisGroupKey(unit);
    const group = groups.get(groupKey) ?? createFeedAnalysisObject(unit);

    group.unitsCount += 1;
    pushUniqueText(group.feedIndexSourceUrls, getText(unit.rawPayload.__feedIndexSourceUrl));
    pushUniqueText(group.projectNames, getFeedIndexObjectName(unit) ?? getFeedUnitProjectName(unit));
    pushUniqueText(group.externalIds, unit.externalId);
    pushUniqueText(group.buildingNames, unit.building);
    pushUniqueText(group.yandexBuildingIds, getText(unit.rawPayload['yandex-building-id']));
    pushUniqueText(group.yandexHouseIds, getText(unit.rawPayload['yandex-house-id']));
    pushUniqueText(group.avitoDevelopmentIds, getText(unit.rawPayload.NewDevelopmentId));
    pushUniqueText(group.addresses, unit.address ?? getText(unit.rawPayload.Address));
    groups.set(groupKey, group);
  }

  const objects = [...groups.values()]
    .map((object) => ({
      ...object,
      filterJson: createFeedAnalysisFilterJson(format, object),
    }))
    .sort((left, right) => right.unitsCount - left.unitsCount || left.title.localeCompare(right.title, 'ru'));

  return {
    format,
    developerName: getMostFrequentText(parsed.units.map(getFeedUnitDeveloperName)),
    unitsCount: parsed.units.length,
    objects,
    warningsCount: parsed.warnings.length,
    warnings: parsed.warnings,
  };
}

function createFeedAnalysisObject(unit: NormalizedFeedUnit): FeedSourceAnalysisObject {
  const avitoDevelopmentId = getText(unit.rawPayload.NewDevelopmentId);

  return {
    title:
      getFeedIndexObjectName(unit) ??
      getFeedUnitProjectName(unit) ??
      (avitoDevelopmentId ? `Avito ЖК ${avitoDevelopmentId}` : null) ??
      unit.building ??
      unit.address ??
      'Без названия',
    unitsCount: 0,
    feedIndexSourceUrls: [],
    projectNames: [],
    externalIds: [],
    buildingNames: [],
    yandexBuildingIds: [],
    yandexHouseIds: [],
    avitoDevelopmentIds: [],
    addresses: [],
    filterJson: null,
  };
}

function getFeedAnalysisGroupKey(unit: NormalizedFeedUnit) {
  const feedIndexObjectName = getFeedIndexObjectName(unit);
  const avitoDevelopmentId = getText(unit.rawPayload.NewDevelopmentId);
  const yandexBuildingId = getText(unit.rawPayload['yandex-building-id']);
  const projectName = getFeedUnitProjectName(unit);
  const building = unit.building ?? getText(unit.rawPayload['building-name']);
  const address = unit.address ?? getText(unit.rawPayload.Address);

  if (feedIndexObjectName) {
    return normalizeFilterText(`sheet:${feedIndexObjectName}`);
  }

  if (avitoDevelopmentId) {
    return normalizeFilterText(`avito:${avitoDevelopmentId}`);
  }

  return normalizeFilterText(projectName ?? building ?? yandexBuildingId ?? address ?? unit.externalId);
}

function createFeedAnalysisFilterJson(
  format: FeedSourceFormat,
  object: FeedSourceAnalysisObject,
): Record<string, string[]> | null {
  if (object.feedIndexSourceUrls.length > 0) {
    return {
      feedIndexSourceUrls: object.feedIndexSourceUrls,
    };
  }

  if (format === 'YANDEX_REALTY') {
    return createYandexAnalysisFilterJson(object);
  }

  if (format === 'AVITO_XML') {
    return createAvitoAnalysisFilterJson(object);
  }

  return createGenericAnalysisFilterJson(object);
}

function createYandexAnalysisFilterJson(object: FeedSourceAnalysisObject): Record<string, string[]> | null {
  const filter: Record<string, string[]> = {};

  if (object.buildingNames.length > 0) {
    filter.buildingNames = object.buildingNames;
  }

  if (object.yandexBuildingIds.length > 0) {
    filter.yandexBuildingIds = object.yandexBuildingIds;
  }

  if (object.yandexHouseIds.length > 0) {
    filter.yandexHouseIds = object.yandexHouseIds;
  }

  if (object.addresses.length === 1) {
    filter.addressIncludes = object.addresses;
  }

  return Object.keys(filter).length > 0 ? filter : null;
}

function createGenericAnalysisFilterJson(object: FeedSourceAnalysisObject): Record<string, string[]> | null {
  if (object.projectNames.length > 0) {
    return {
      projectNames: object.projectNames,
    };
  }

  if (object.buildingNames.length > 0) {
    return {
      buildingNames: object.buildingNames,
    };
  }

  if (object.addresses.length === 1) {
    return {
      addressIncludes: object.addresses,
    };
  }

  if (object.externalIds.length > 0) {
    return {
      externalIds: object.externalIds,
    };
  }

  return null;
}

function createAvitoAnalysisFilterJson(object: FeedSourceAnalysisObject): Record<string, string[]> | null {
  if (object.avitoDevelopmentIds.length > 0) {
    return {
      avitoDevelopmentIds: object.avitoDevelopmentIds,
    };
  }

  if (object.addresses.length === 1) {
    return {
      addressIncludes: object.addresses,
    };
  }

  if (object.externalIds.length > 0) {
    return {
      externalIds: object.externalIds,
    };
  }

  return null;
}

function getFeedUnitDeveloperName(unit: NormalizedFeedUnit) {
  return (
    getText(asRecord(unit.rawPayload['sales-agent'])?.organization) ??
    getText(asRecord(unit.rawPayload.Developer)?.Name) ??
    getText(unit.rawPayload.CompanyName) ??
    getText(unit.rawPayload.DeveloperName)
  );
}

function getFeedUnitProjectName(unit: NormalizedFeedUnit) {
  return unit.projectName ?? getText(asRecord(unit.rawPayload.JKSchema)?.Name);
}

function getFeedIndexObjectName(unit: NormalizedFeedUnit) {
  return getText(unit.rawPayload.__feedIndexObjectName);
}

function getMostFrequentText(values: Array<string | null>) {
  const counts = new Map<string, number>();

  for (const value of values) {
    if (!value) {
      continue;
    }

    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'ru'))[0]?.[0] ?? null;
}

function pushUniqueText(target: string[], value: string | null) {
  const normalizedValue = value?.trim();

  if (normalizedValue && !target.includes(normalizedValue)) {
    target.push(normalizedValue);
  }
}

function filterFeedUnitsForSource(units: NormalizedFeedUnit[], source: FeedSourceRecord) {
  const filter = normalizeFeedSourceFilter(source.filterJson);

  if (!filter) {
    return units;
  }

  return units.filter((unit) => matchesFeedSourceFilter(unit, filter));
}

type NormalizedFeedSourceFilter = {
  externalIds: string[];
  feedIndexSourceUrls: string[];
  projectNames: string[];
  buildingNames: string[];
  yandexBuildingIds: string[];
  yandexHouseIds: string[];
  avitoDevelopmentIds: string[];
  addressIncludes: string[];
};

function normalizeFeedSourceFilter(value: Record<string, unknown> | null | undefined): NormalizedFeedSourceFilter | null {
  const filter = asRecord(value);

  if (!filter) {
    return null;
  }

  const normalized = {
    externalIds: normalizeFilterStringArray(filter.externalIds),
    feedIndexSourceUrls: normalizeFilterStringArray(filter.feedIndexSourceUrls),
    projectNames: normalizeFilterStringArray(filter.projectNames),
    buildingNames: normalizeFilterStringArray(filter.buildingNames),
    yandexBuildingIds: normalizeFilterStringArray(filter.yandexBuildingIds),
    yandexHouseIds: normalizeFilterStringArray(filter.yandexHouseIds),
    avitoDevelopmentIds: normalizeFilterStringArray(filter.avitoDevelopmentIds),
    addressIncludes: normalizeFilterStringArray(filter.addressIncludes),
  };

  return Object.values(normalized).some((items) => items.length > 0) ? normalized : null;
}

function normalizeFilterStringArray(value: unknown) {
  return toArray(value)
    .map((item) => getText(item))
    .filter((item): item is string => item !== null)
    .map(normalizeFilterText)
    .filter((item) => item.length > 0);
}

function matchesFeedSourceFilter(unit: NormalizedFeedUnit, filter: NormalizedFeedSourceFilter) {
  const payload = unit.rawPayload;
  const cianSchema = asRecord(payload.JKSchema);
  const cianHouse = asRecord(cianSchema?.House);

  return (
    matchesFilterExact(unit.externalId, filter.externalIds) &&
    matchesFilterExact(getText(payload.__feedIndexSourceUrl), filter.feedIndexSourceUrls) &&
    matchesFilterExact(unit.projectName ?? getText(cianSchema?.Name), filter.projectNames) &&
    matchesFilterExact(unit.building ?? getText(payload['building-name']) ?? getText(cianHouse?.Name), filter.buildingNames) &&
    matchesFilterExact(getText(payload['yandex-building-id']), filter.yandexBuildingIds) &&
    matchesFilterExact(getText(payload['yandex-house-id']), filter.yandexHouseIds) &&
    matchesFilterExact(getText(payload.NewDevelopmentId), filter.avitoDevelopmentIds) &&
    matchesFilterIncludes(unit.address ?? getText(payload.Address), filter.addressIncludes)
  );
}

function matchesFilterExact(value: string | null, allowedValues: string[]) {
  return allowedValues.length === 0 || (value !== null && allowedValues.includes(normalizeFilterText(value)));
}

function matchesFilterIncludes(value: string | null, needles: string[]) {
  if (needles.length === 0) {
    return true;
  }

  if (value === null) {
    return false;
  }

  const normalizedValue = normalizeFilterText(value);

  return needles.some((needle) => normalizedValue.includes(needle));
}

function normalizeFilterText(value: string) {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase();
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

async function parseFeedSourceForImport(
  source: FeedSourceRecord,
  options: ExecuteFeedImportOptions,
): Promise<FeedParseResult> {
  let parsed: FeedParseResult;

  if (source.sourceKind === 'INDEX_URL') {
    if (!source.url) {
      throw new Error(`FeedSource ${source.id} URL is empty`);
    }

    parsed = (await parseFeedIndexAutomatically({
      sourceUrl: source.url,
      xmlFetcher: options.xmlFetcher,
      namespaceExternalIds: true,
    })).parsed;
  } else {
    const xml = await loadXmlForFeedSource(source, options);
    const parser = createFeedParserForFormat(source.format);

    parsed = parser.parse(xml);
  }

  return applyFeedSourceUnitRules(parsed, source);
}

function applyFeedSourceUnitRules(parsed: FeedParseResult, source: FeedSourceRecord): FeedParseResult {
  return {
    ...parsed,
    units: parsed.units.map((unit) => applyFeedSourceUnitTitleRules(unit, source)),
  };
}

function applyFeedSourceUnitTitleRules(unit: NormalizedFeedUnit, source: FeedSourceRecord): NormalizedFeedUnit {
  if (shouldUseApartmentNumberTitleForSource(unit, source)) {
    return {
      ...unit,
      title: `Квартира №${unit.residentialDetails?.apartmentNumber}`,
    };
  }

  return unit;
}

function shouldUseApartmentNumberTitleForSource(unit: NormalizedFeedUnit, source: FeedSourceRecord) {
  const unitFormat = getText(unit.rawPayload.__feedDetectedFormat) ?? source.format;

  return (
    unit.type === 'RESIDENTIAL' &&
    Boolean(unit.residentialDetails?.apartmentNumber) &&
    (unitFormat === 'FSK_XML' ||
      unitFormat === 'TEKTA_XML' ||
      (unitFormat === 'CIAN_XML' &&
        (isMrGroupFeedSource(source) || isMangazeyaFeedSource(source) || isPioneerFeedSource(source))))
  );
}

function isMrGroupFeedSource(source: FeedSourceRecord) {
  const normalizedSourceText = [source.developer?.normalizedName, source.developer?.name, source.url]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLocaleLowerCase('ru-RU');

  return (
    /(?:^|[^a-z0-9])mr[\s.-]*group(?:$|[^a-z0-9])/iu.test(normalizedSourceText) ||
    normalizedSourceText.includes('мр групп') ||
    normalizedSourceText.includes('мр-групп')
  );
}

function isMangazeyaFeedSource(source: FeedSourceRecord) {
  const normalizedSourceText = [source.developer?.normalizedName, source.developer?.name, source.url]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLocaleLowerCase('ru-RU');

  return normalizedSourceText.includes('mangazeya') || normalizedSourceText.includes('мангазея');
}

function isPioneerFeedSource(source: FeedSourceRecord) {
  const normalizedSourceText = [source.developer?.normalizedName, source.developer?.name, source.url]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLocaleLowerCase('ru-RU');

  return (
    isPioneerText(normalizedSourceText) ||
    normalizedSourceText.includes('varshavskaya.life') ||
    normalizedSourceText.includes('pride-home.ru') ||
    normalizedSourceText.includes('highlife.ru') ||
    normalizedSourceText.includes('opus-home.ru') ||
    normalizedSourceText.includes('shift-home.ru')
  );
}

function isPioneerText(value: string) {
  return value.includes('пионер') || value.includes('pioneer') || value.includes('pioner');
}

function routeFeedUnitsForSource(units: NormalizedFeedUnit[], source: FeedSourceRecord): RoutedFeedUnit[] {
  const activeMappings = (source.mappings ?? []).filter((mapping) => mapping.isActive);
  let routedUnits: RoutedFeedUnit[];

  if (activeMappings.length > 0) {
    const normalizedMappings = activeMappings
      .map((mapping) => ({
        objectId: mapping.objectId,
        filter: normalizeFeedSourceFilter(mapping.filterJson),
      }))
      .filter((mapping): mapping is { objectId: string; filter: NormalizedFeedSourceFilter } => mapping.filter !== null);

    if (normalizedMappings.length === 0) {
      return [];
    }

    routedUnits = units.flatMap((unit) => {
      const mapping = normalizedMappings.find((candidate) => matchesFeedSourceFilter(unit, candidate.filter));

      return mapping ? [{ unit, objectId: mapping.objectId }] : [];
    });
  } else if (!source.objectId) {
    return [];
  } else {
    routedUnits = filterFeedUnitsForSource(units, source).map((unit) => ({
      unit,
      objectId: source.objectId as string,
    }));
  }

  return applyRoutedFeedUnitRules(routedUnits, source);
}

function applyRoutedFeedUnitRules(units: RoutedFeedUnit[], source: FeedSourceRecord): RoutedFeedUnit[] {
  if (shouldMergeSminexIndexDuplicates(source)) {
    return mergeSminexIndexDuplicates(units);
  }

  return units;
}

function shouldMergeSminexIndexDuplicates(source: FeedSourceRecord) {
  return source.sourceKind === 'INDEX_URL' && isSminexFeedSource(source);
}

function isSminexFeedSource(source: FeedSourceRecord) {
  const normalizedSourceText = [source.developer?.normalizedName, source.developer?.name, source.url]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLocaleLowerCase('ru-RU');

  return normalizedSourceText.includes('sminex') || normalizedSourceText.includes('смайнекс');
}

function mergeSminexIndexDuplicates(units: RoutedFeedUnit[]): RoutedFeedUnit[] {
  const groups = new Map<string, RoutedFeedUnit[]>();
  const passthrough: RoutedFeedUnit[] = [];

  for (const routedUnit of units) {
    const key = getSminexIndexDuplicateKey(routedUnit);

    if (!key) {
      passthrough.push(routedUnit);
      continue;
    }

    const group = groups.get(key) ?? [];
    group.push(routedUnit);
    groups.set(key, group);
  }

  return [
    ...passthrough,
    ...Array.from(groups.values()).flatMap((group) => mergeSminexIndexDuplicateGroup(group)),
  ];
}

function getSminexIndexDuplicateKey(routedUnit: RoutedFeedUnit) {
  const rawExternalId = getFeedIndexRawExternalId(routedUnit.unit);

  if (!rawExternalId || routedUnit.unit.type !== 'RESIDENTIAL') {
    return null;
  }

  return [routedUnit.objectId, rawExternalId].join('\u001f');
}

function getFeedIndexRawExternalId(unit: NormalizedFeedUnit) {
  return getText(unit.rawPayload.__rawExternalId);
}

function mergeSminexIndexDuplicateGroup(group: RoutedFeedUnit[]): RoutedFeedUnit[] {
  if (group.length < 2 || !canMergeSminexIndexDuplicateGroup(group)) {
    return group;
  }

  const canonical = chooseSminexIndexCanonicalUnit(group);

  if (!canonical) {
    return group;
  }

  const donors = group.filter((routedUnit) => routedUnit !== canonical);

  return [
    {
      ...canonical,
      unit: mergeSminexIndexDuplicateUnits(canonical.unit, donors.map((donor) => donor.unit)),
    },
  ];
}

function canMergeSminexIndexDuplicateGroup(group: RoutedFeedUnit[]) {
  const formats = new Set(group.map((routedUnit) => getText(routedUnit.unit.rawPayload.__feedDetectedFormat)).filter(Boolean));

  if (!formats.has('CIAN_XML') || !formats.has('YANDEX_REALTY')) {
    return false;
  }

  const reference = group[0]?.unit;

  if (!reference) {
    return false;
  }

  return group.every((routedUnit) => haveSameSminexIndexDuplicateSignature(reference, routedUnit.unit));
}

function haveSameSminexIndexDuplicateSignature(left: NormalizedFeedUnit, right: NormalizedFeedUnit) {
  return (
    left.status === right.status &&
    left.type === right.type &&
    left.residentialDetails?.apartmentNumber === right.residentialDetails?.apartmentNumber &&
    left.floor === right.floor &&
    left.rooms === right.rooms &&
    left.area === right.area &&
    left.effectivePrice === right.effectivePrice &&
    left.completionYear === right.completionYear &&
    left.completionQuarter === right.completionQuarter
  );
}

function chooseSminexIndexCanonicalUnit(group: RoutedFeedUnit[]) {
  return (
    group.find((routedUnit) => getText(routedUnit.unit.rawPayload.__feedDetectedFormat) === 'CIAN_XML') ??
    group[0]
  );
}

function mergeSminexIndexDuplicateUnits(canonical: NormalizedFeedUnit, donors: NormalizedFeedUnit[]): NormalizedFeedUnit {
  const donorWithBuilding = donors.find((unit) => unit.building);

  return {
    ...canonical,
    building: canonical.building ?? donorWithBuilding?.building ?? null,
    media: mergeFeedUnitMedia([canonical, ...donors].flatMap((unit) => unit.media)),
    rawPayload: {
      ...canonical.rawPayload,
      __mergedFeedIndexSourceUrls: [canonical, ...donors]
        .map((unit) => getText(unit.rawPayload.__feedIndexSourceUrl))
        .filter((value): value is string => value !== null),
      __mergedExternalIds: [canonical, ...donors].map((unit) => unit.externalId),
    },
  };
}

function mergeFeedUnitMedia(mediaItems: NormalizedFeedMedia[]) {
  const seen = new Set<string>();
  const merged: NormalizedFeedMedia[] = [];

  for (const media of mediaItems) {
    if (seen.has(media.sourceUrl)) {
      continue;
    }

    seen.add(media.sourceUrl);
    merged.push({
      ...media,
      sortOrder: merged.length,
    });
  }

  return merged;
}

export async function executeFeedImport(options: ExecuteFeedImportOptions): Promise<FeedImportResult> {
  const now = options.now ?? (() => new Date());
  const source = await options.db.feedSource.findUnique({
    where: {
      id: options.sourceId,
    },
    include: {
      xmlFile: true,
      developer: {
        select: {
          name: true,
          normalizedName: true,
        },
      },
      mappings: {
        orderBy: {
          sourceTitle: 'asc',
        },
      },
    },
  });

  if (!source || source.deletedAt) {
    throw new Error(`FeedSource ${options.sourceId} was not found`);
  }

  const mode = toImportModeValue(options.mode);
  const report = options.reportId
    ? await getExistingFeedImportRun(options.db, options.reportId, source.id, mode)
    : await options.db.feedImportRun.create({
        data: {
          sourceId: source.id,
          mode,
          status: 'PENDING',
          startedAt: now(),
        },
      });
  const startedAt = report.startedAt;
  const warnings: FeedParserWarning[] = [];
  const errors: FeedParserWarning[] = [];

  try {
    const parsed = await parseFeedSourceForImport(source, options);
    warnings.push(...parsed.warnings);
    const routedUnits = routeFeedUnitsForSource(parsed.units, source);

    const plan = await buildFeedImportPlan(options.db, source.id, routedUnits);

    if (options.mode === 'run') {
      if (!options.storage) {
        throw new Error('Feed import run requires storage client');
      }

      await updateFeedImportProgress(
          options.db,
          report.id,
          createFeedImportProgress('PROCESSING_UNITS', routedUnits.length, 0, plan, now()),
      );
      await persistFeedImportRun(routedUnits, plan, {
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
        createFeedImportProgress('REFRESHING_OBJECT', routedUnits.length, routedUnits.length, plan, now()),
      );
      await refreshAffectedRealEstateObjectFeedAggregates(options.db, plan.affectedObjectIds, now());
    }

    const finishedAt = now();
    const status = resolveFeedImportStatus(warnings, errors);
    const summary = createFeedImportSummary({
      source,
      mode: options.mode,
      unitsParsed: routedUnits.length,
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

async function getExistingFeedImportRun(
  db: FeedImportDatabase,
  reportId: string,
  sourceId: string,
  mode: ImportModeValue,
) {
  const report = await db.feedImportRun.findUnique({
    where: {
      id: reportId,
    },
  });

  if (!report) {
    throw new Error(`FeedImportRun ${reportId} was not found`);
  }

  if (report.sourceId !== sourceId || report.mode !== mode) {
    throw new Error(`FeedImportRun ${reportId} does not match feed source ${sourceId}`);
  }

  if (report.status !== 'PENDING') {
    throw new Error(`FeedImportRun ${reportId} is not pending`);
  }

  return report;
}

async function buildFeedImportPlan(
  db: FeedImportDatabase,
  sourceId: string,
  units: RoutedFeedUnit[],
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
  const parsedExternalIds = new Set(units.map(({ unit }) => unit.externalId));
  const created = units.filter(({ unit }) => !existingByExternalId.has(unit.externalId)).length;
  const updated = units.length - created;
  const archived = existingUnits.filter(
    (unit) => !parsedExternalIds.has(unit.externalId) && unit.status !== 'ARCHIVED',
  ).length;
  const affectedObjectIds = Array.from(
    new Set([
      ...existingUnits.map((unit) => unit.objectId),
      ...units.map((unit) => unit.objectId),
    ]),
  );
  const mediaUrls = units.flatMap(({ unit }) => unit.media.map((media) => media.sourceUrl));
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
    affectedObjectIds,
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
  units: RoutedFeedUnit[],
  plan: FeedImportPlan,
  context: PersistFeedImportContext,
) {
  let unitsProcessed = 0;

  for (const routedUnit of units) {
    const unitId = await upsertFeedUnit(context.db, context.source, routedUnit, context.now());

    await syncFeedUnitDetails(context.db, unitId, routedUnit.unit);
    await syncFeedUnitMedia(context, unitId, routedUnit.unit);
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
      source: {
        deletedAt: null,
      },
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
      discountPrice: true,
      effectivePrice: true,
      pricePerMeter: true,
      discountPricePerMeter: true,
      effectivePricePerMeter: true,
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
      feedPriceFrom: minDecimalString(activeUnits.map((unit) => unit.effectivePrice ?? unit.discountPrice ?? unit.price ?? null)),
      feedPricePerMeterFrom: minDecimalString(
        activeUnits.map((unit) => unit.effectivePricePerMeter ?? unit.discountPricePerMeter ?? unit.pricePerMeter ?? null),
      ),
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

async function refreshAffectedRealEstateObjectFeedAggregates(
  db: FeedImportDatabase,
  objectIds: string[],
  updatedAt: Date,
) {
  for (const objectId of objectIds) {
    await refreshRealEstateObjectFeedAggregates(db, objectId, updatedAt);
  }
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
  routedUnit: RoutedFeedUnit,
  now: Date,
) {
  const writeData = createFeedUnitWriteData(routedUnit, now);
  const persisted = await db.feedUnit.upsert({
    where: {
      sourceId_externalId: {
        sourceId: source.id,
        externalId: routedUnit.unit.externalId,
      },
    },
    update: writeData,
    create: {
      sourceId: source.id,
      externalId: routedUnit.unit.externalId,
      ...writeData,
    },
    select: {
      id: true,
    },
  });

  return persisted.id;
}

function createFeedUnitWriteData(
  routedUnit: RoutedFeedUnit,
  now: Date,
): FeedUnitWriteData {
  const { unit } = routedUnit;

  return {
    objectId: routedUnit.objectId,
    type: unit.type,
    status: unit.status,
    title: unit.title,
    address: unit.address,
    building: unit.building,
    section: unit.section,
    floor: unit.floor,
    rooms: unit.rooms,
    price: unit.price,
    discountPrice: unit.discountPrice,
    effectivePrice: unit.effectivePrice,
    currency: unit.currency,
    area: unit.area,
    pricePerMeter: unit.pricePerMeter,
    discountPricePerMeter: unit.discountPricePerMeter,
    effectivePricePerMeter: unit.effectivePricePerMeter,
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
  console.error('Usage: pnpm --filter @platforma/feed-import run <preview|run> --source <feedSourceId> [--run-id <feedImportRunId>]');
  console.error('Usage: pnpm --filter @platforma/feed-import run analyze --format <format|AUTO> [--source-kind <URL|FILE|INDEX_URL>] (--url <url> | --file <path>) [--output <path>]');
}

async function main() {
  const args = process.argv.slice(2);
  const analyzeArgs = parseFeedAnalyzeCliArgs(args);

  if (analyzeArgs) {
    if (!isXmlParserAvailable()) {
      console.error('XML parser dependency is unavailable');
      process.exitCode = 1;
      return;
    }

    const analysis = await analyzeFeedSourceInput({
      format: analyzeArgs.format,
      sourceKind: analyzeArgs.sourceKind,
      url: analyzeArgs.url,
      filePath: analyzeArgs.filePath,
    });
    const output = JSON.stringify(analysis, null, 2);

    if (analyzeArgs.outputPath) {
      await writeFile(analyzeArgs.outputPath, output);
    } else {
      console.log(output);
    }

    return;
  }

  const cliArgs = parseFeedImportCliArgs(args);

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
      reportId: cliArgs.runId,
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
