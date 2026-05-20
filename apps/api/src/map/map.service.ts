import { BadRequestException, Injectable } from '@nestjs/common';
import { LocationType, ObjectFileType, ObjectStatus, Prisma } from '@prisma/client';

import { findCatalogSearchObjectIds } from '../objects/object-search';
import { PrismaService } from '../prisma/prisma.service';

const mapObjectInclude = {
  developer: true,
  images: {
    include: {
      file: true,
    },
    orderBy: [
      {
        isCover: 'desc',
      },
      {
        sortOrder: 'asc',
      },
      {
        createdAt: 'asc',
      },
    ],
  },
  metroStations: {
    include: {
      metroStation: true,
    },
    orderBy: {
      sortOrder: 'asc',
    },
  },
  primaryLocation: true,
  locations: {
    include: {
      location: true,
    },
    orderBy: {
      sortOrder: 'asc',
    },
  },
} satisfies Prisma.RealEstateObjectInclude;

type MapObjectRecord = Prisma.RealEstateObjectGetPayload<{ include: typeof mapObjectInclude }>;

type MapObjectsQuery = {
  search?: string;
  status?: string;
  developerId?: string;
  krtName?: string;
  locationId?: string;
  areaId?: string;
  metroStationId?: string;
  completionYear?: string;
  completionQuarter?: string;
  priceFromMin?: string;
  priceFromMax?: string;
  hasPresentation?: string;
  limit?: string;
};

@Injectable()
export class MapService {
  constructor(private readonly prisma: PrismaService) {}

  async listObjects(query: MapObjectsQuery) {
    const limit = Math.min(this.parsePositiveInteger(query.limit, 1000), 2000);
    const filters = await this.buildFilters(query);
    const where: Prisma.RealEstateObjectWhereInput = {
      AND: [
        ...filters,
        {
          latitude: {
            not: null,
          },
          longitude: {
            not: null,
          },
        },
      ],
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.realEstateObject.findMany({
        where,
        include: mapObjectInclude,
        orderBy: [
          {
            createdAt: 'desc',
          },
          {
            title: 'asc',
          },
        ],
        take: limit,
      }),
      this.prisma.realEstateObject.count({ where }),
    ]);

    return {
      items: items.map((object) => this.serializeMapObject(object)),
      total,
    };
  }

  private async buildFilters(query: MapObjectsQuery) {
    const filters: Prisma.RealEstateObjectWhereInput[] = [
      {
        deletedAt: null,
      },
    ];
    const search = query.search?.trim();
    const priceFromMin = this.parseNullableDecimal(query.priceFromMin, 'Price from min', 14, 2);
    const priceFromMax = this.parseNullableDecimal(query.priceFromMax, 'Price from max', 14, 2);

    if (search) {
      const searchObjectIds = await findCatalogSearchObjectIds(this.prisma, search);

      filters.push({
        id: {
          in: searchObjectIds,
        },
      });
    }

    if (query.status) {
      filters.push({
        status: this.parseObjectStatus(query.status),
      });
    }

    if (query.developerId) {
      filters.push({
        developerId: this.parseUuid(query.developerId, 'Developer is invalid'),
      });
    }

    const krtName = query.krtName?.trim();

    if (krtName) {
      filters.push({
        krtName: {
          equals: krtName,
          mode: 'insensitive',
        },
      });
    }

    if (query.locationId) {
      const locationId = this.parseUuid(query.locationId, 'Location is invalid');

      filters.push({
        OR: [
          {
            primaryLocationId: locationId,
          },
          {
            locations: {
              some: {
                locationId,
              },
            },
          },
        ],
      });
    }

    if (query.areaId) {
      const areaId = this.parseUuid(query.areaId, 'Area is invalid');

      filters.push({
        locations: {
          some: {
            locationId: areaId,
            location: {
              type: LocationType.AREA,
            },
          },
        },
      });
    }

    if (query.metroStationId) {
      filters.push({
        metroStations: {
          some: {
            metroStationId: this.parseUuid(query.metroStationId, 'Metro station is invalid'),
          },
        },
      });
    }

    if (query.completionYear) {
      filters.push({
        completionYear: this.parseInteger(query.completionYear, 'Completion year is invalid', 1900, 2200),
      });
    }

    if (query.completionQuarter) {
      filters.push({
        completionQuarter: this.parseInteger(query.completionQuarter, 'Completion quarter is invalid', 1, 4),
      });
    }

    if (priceFromMin !== undefined || priceFromMax !== undefined) {
      if (priceFromMin === null || priceFromMax === null) {
        throw new BadRequestException('Price filters are invalid');
      }

      if (priceFromMin && priceFromMax && Number(priceFromMin) > Number(priceFromMax)) {
        throw new BadRequestException('Price from min cannot be greater than max');
      }

      filters.push({
        priceFrom: {
          ...(priceFromMin ? { gte: priceFromMin } : {}),
          ...(priceFromMax ? { lte: priceFromMax } : {}),
        },
      });
    }

    const hasPresentation = this.parseOptionalBoolean(query.hasPresentation, 'Has presentation is invalid');

    if (hasPresentation === true) {
      filters.push({
        files: {
          some: {
            type: ObjectFileType.PRESENTATION,
          },
        },
      });
    }

    if (hasPresentation === false) {
      filters.push({
        files: {
          none: {
            type: ObjectFileType.PRESENTATION,
          },
        },
      });
    }

    return filters;
  }

  private parseObjectStatus(value: string) {
    const normalizedStatus = value.trim().toUpperCase();

    if (!Object.values(ObjectStatus).includes(normalizedStatus as ObjectStatus)) {
      throw new BadRequestException('Object status is invalid');
    }

    return normalizedStatus as ObjectStatus;
  }

  private parseInteger(value: string, message: string, min: number, max: number) {
    const normalizedValue = value.trim();
    const parsed = Number(normalizedValue);

    if (!/^\d+$/.test(normalizedValue) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new BadRequestException(message);
    }

    return parsed;
  }

  private parseNullableDecimal(value: string | undefined, fieldName: string, precision: number, scale: number) {
    if (value === undefined) {
      return undefined;
    }

    if (value === '') {
      return null;
    }

    const normalizedValue = value.trim().replace(/\s+/g, '').replace(',', '.');

    if (!/^\d+(\.\d+)?$/.test(normalizedValue)) {
      throw new BadRequestException(`${fieldName} is invalid`);
    }

    this.validateDecimalShape(normalizedValue, fieldName, precision, scale);

    return this.trimDecimal(normalizedValue);
  }

  private validateDecimalShape(value: string, fieldName: string, precision: number, scale: number) {
    const [integerPart = '', fractionPart = ''] = value.split('.');
    const normalizedIntegerPart = integerPart.replace(/^0+/, '') || '0';
    const integerLimit = precision - scale;

    if (normalizedIntegerPart.length > integerLimit || fractionPart.length > scale) {
      throw new BadRequestException(`${fieldName} is invalid`);
    }
  }

  private trimDecimal(value: string) {
    const trimmedValue = value.replace(/^(-?)0+(\d)/, '$1$2');
    const result = trimmedValue.includes('.')
      ? trimmedValue.replace(/(\.\d*?[1-9])0+$/u, '$1').replace(/\.0+$/u, '')
      : trimmedValue;

    return result === '-0' ? '0' : result;
  }

  private parseUuid(value: string, message: string) {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (!uuidPattern.test(value)) {
      throw new BadRequestException(message);
    }

    return value;
  }

  private parseOptionalBoolean(value: string | undefined, message: string) {
    if (value === undefined || value.trim() === '') {
      return undefined;
    }

    const normalizedValue = value.trim().toLowerCase();

    if (['true', '1', 'yes'].includes(normalizedValue)) {
      return true;
    }

    if (['false', '0', 'no'].includes(normalizedValue)) {
      return false;
    }

    throw new BadRequestException(message);
  }

  private parsePositiveInteger(value: string | undefined, fallback: number) {
    if (!value) {
      return fallback;
    }

    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed < 1) {
      return fallback;
    }

    return parsed;
  }

  private serializeMapObject(object: MapObjectRecord) {
    const coverImage = object.images[0] ?? null;

    return {
      id: object.id,
      title: object.title,
      slug: object.slug,
      status: object.status,
      address: object.address,
      latitude: object.latitude?.toNumber() ?? 0,
      longitude: object.longitude?.toNumber() ?? 0,
      priceFrom: object.priceFrom?.toString() ?? null,
      pricePerMeterFrom: object.pricePerMeterFrom?.toString() ?? null,
      completionYear: object.completionYear,
      completionQuarter: object.completionQuarter,
      developer: object.developer
        ? {
            id: object.developer.id,
            wpTermId: object.developer.wpTermId,
            name: object.developer.name,
            slug: object.developer.slug,
          }
        : null,
      primaryLocation: object.primaryLocation
        ? {
            id: object.primaryLocation.id,
            wpTermId: object.primaryLocation.wpTermId,
            name: object.primaryLocation.name,
            slug: object.primaryLocation.slug,
            type: object.primaryLocation.type,
            parentId: object.primaryLocation.parentId,
          }
        : null,
      locations: object.locations.map((link) => ({
        id: link.location.id,
        wpTermId: link.location.wpTermId,
        name: link.location.name,
        slug: link.location.slug,
        type: link.location.type,
        parentId: link.location.parentId,
        isPrimary: link.isPrimary,
        sortOrder: link.sortOrder,
      })),
      metroStations: object.metroStations.map((link) => ({
        id: link.metroStation.id,
        wpTermId: link.metroStation.wpTermId,
        name: link.metroStation.name,
        slug: link.metroStation.slug,
        lineName: link.metroStation.lineName,
        lineColor: link.metroStation.lineColor,
        sortOrder: link.sortOrder,
      })),
      images: object.images.map((image) => this.serializeMapObjectImage(image)),
      coverImage: coverImage ? this.serializeMapObjectImage(coverImage) : null,
    };
  }

  private serializeMapObjectImage(image: MapObjectRecord['images'][number]) {
    return {
      id: image.id,
      file: this.serializeMapFile(image.file),
      sortOrder: image.sortOrder,
      isCover: image.isCover,
      section: image.section,
      alt: image.alt,
      title: image.title,
      sourceMetaKey: image.sourceMetaKey,
      createdAt: image.createdAt.toISOString(),
      updatedAt: image.updatedAt.toISOString(),
    };
  }

  private serializeMapFile(file: MapObjectRecord['images'][number]['file']) {
    return {
      id: file.id,
      wpAttachmentId: file.wpAttachmentId,
      storage: file.storage,
      bucket: file.bucket,
      key: file.key,
      url: file.url,
      originalName: file.originalName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes?.toString() ?? null,
      checksum: file.checksum,
      createdAt: file.createdAt.toISOString(),
      updatedAt: file.updatedAt.toISOString(),
    };
  }
}
