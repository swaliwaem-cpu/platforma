import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  FeedUnitStatus,
  FeedUnitType,
  LocationType,
  ObjectFileType,
  ObjectImageSection,
  ObjectStatus,
  Prisma,
} from '@prisma/client';

import { AuthenticatedUser, RequestWithAuth } from '../auth/auth.types';
import { IMAGE_MIME_TYPES } from '../files/file-upload.constants';
import { FilesService, UploadedFileStream } from '../files/files.service';
import { UploadedFile } from '../files/uploaded-file.type';
import { PrismaService } from '../prisma/prisma.service';
import { createSearchContainsFilters } from '../search/search-filters';
import { findCatalogSearchObjectIds } from './object-search';

const objectPdfUploadLimit = 10;

const objectListInclude = {
  developer: true,
  primaryLocation: true,
  locations: {
    include: {
      location: true,
    },
    orderBy: {
      sortOrder: 'asc',
    },
  },
  metroStations: {
    include: {
      metroStation: true,
    },
    orderBy: {
      sortOrder: 'asc',
    },
  },
  images: {
    where: {
      isCover: true,
    },
    include: {
      file: true,
    },
    orderBy: {
      sortOrder: 'asc',
    },
    take: 1,
  },
  files: {
    where: {
      type: ObjectFileType.PRESENTATION,
    },
    include: {
      file: true,
    },
    orderBy: {
      sortOrder: 'asc',
    },
    take: 1,
  },
} as const;

const objectDetailInclude = {
  developer: true,
  primaryLocation: true,
  locations: {
    include: {
      location: true,
    },
    orderBy: {
      sortOrder: 'asc',
    },
  },
  metroStations: {
    include: {
      metroStation: true,
    },
    orderBy: {
      sortOrder: 'asc',
    },
  },
  images: {
    include: {
      file: true,
    },
    orderBy: {
      sortOrder: 'asc',
    },
  },
  files: {
    include: {
      file: true,
    },
    orderBy: {
      sortOrder: 'asc',
    },
  },
} as const;

const feedUnitInclude = {
  residentialDetails: true,
  commercialDetails: true,
  media: {
    include: {
      mediaAsset: {
        include: {
          file: true,
        },
      },
    },
    orderBy: {
      sortOrder: 'asc' as const,
    },
  },
} as const;

type ObjectListRecord = Prisma.RealEstateObjectGetPayload<{ include: typeof objectListInclude }>;
type ObjectDetailRecord = Prisma.RealEstateObjectGetPayload<{ include: typeof objectDetailInclude }>;
type ObjectFeedUnitRecord = Prisma.FeedUnitGetPayload<{ include: typeof feedUnitInclude }>;
type ObjectFeedMediaFileRecord = NonNullable<ObjectFeedUnitRecord['media'][number]['mediaAsset']['file']>;
type ObjectClient = PrismaService | Prisma.TransactionClient;

type RequestWithAudit = RequestWithAuth & {
  ip?: string;
  socket?: {
    remoteAddress?: string;
  };
};

type GalleryStreamUploadRequest = RequestWithAudit & NodeJS.ReadableStream;

type ListObjectsQuery = {
  page?: string;
  limit?: string;
  search?: string;
  status?: string;
  sortBy?: string;
  sortDirection?: string;
  developerId?: string;
  krtName?: string;
  locationId?: string;
  areaId?: string;
  metroStationId?: string;
  districtSearch?: string;
  areaSearch?: string;
  metroSearch?: string;
  completionYear?: string;
  completionQuarter?: string;
  priceFromMin?: string;
  priceFromMax?: string;
  lotPriceMin?: string;
  lotPriceMax?: string;
  lotRooms?: string;
  lotFloorMin?: string;
  lotFloorMax?: string;
  hasCoordinates?: string;
  hasPresentation?: string;
};

type ListObjectFeedUnitsQuery = {
  page?: string;
  limit?: string;
  status?: string;
  type?: string;
  search?: string;
  sortBy?: string;
  sortDirection?: string;
  priceMin?: string;
  priceMax?: string;
  pricePerMeterMin?: string;
  pricePerMeterMax?: string;
  areaMin?: string;
  areaMax?: string;
  rooms?: string;
  floorMin?: string;
  floorMax?: string;
  completionYear?: string;
  completionQuarter?: string;
};

type CreateObjectBody = {
  title?: unknown;
  status?: unknown;
  description?: unknown;
  architectureDescription?: unknown;
  infrastructureDescription?: unknown;
  fillingDescription?: unknown;
  shortDescription?: unknown;
  mapName?: unknown;
  layoutsUrl?: unknown;
  krtName?: unknown;
  apartmentAreaRange?: unknown;
  ceilingHeight?: unknown;
  propertyClass?: unknown;
  floorRange?: unknown;
  apartmentsCountText?: unknown;
  priceFrom?: unknown;
  pricePerMeterFrom?: unknown;
  completionYear?: unknown;
  completionQuarter?: unknown;
  address?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  featuresJson?: unknown;
  developerId?: unknown;
  primaryLocationId?: unknown;
  locationIds?: unknown;
  metroStationIds?: unknown;
};

type UpdateObjectBody = Partial<CreateObjectBody>;

type UpdateObjectStatusBody = {
  status?: unknown;
};

type SortGalleryBody = {
  imageIds?: unknown;
};

type GalleryLayoutBody = {
  imageIds?: unknown;
  coverImageId?: unknown;
  imageSections?: unknown;
};

type GalleryBatchBody = {
  layout?: unknown;
};

type GalleryBatchItem =
  | {
      kind: 'existing';
      imageId: string;
      section: ObjectImageSection | null;
    }
  | {
      kind: 'new';
      fileIndex: number;
      section: ObjectImageSection | null;
    }
  | {
      kind: 'staged';
      fileId: string;
      section: ObjectImageSection | null;
    };

type GalleryBatchLayout = {
  items: GalleryBatchItem[];
  coverIndex: number | null;
};

type UploadObjectFileBody = {
  type?: unknown;
  title?: unknown;
};

type ObjectLifecycleState = {
  title: string;
  slug: string;
  status: ObjectStatus;
  developerId: string | null;
  primaryLocationId: string | null;
  address: string | null;
  latitude: string | null;
  longitude: string | null;
  completionYear: number | null;
  completionQuarter: number | null;
};

@Injectable()
export class ObjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly filesService: FilesService,
  ) {}

  async list(query: ListObjectsQuery) {
    const page = this.parsePositiveInteger(query.page, 1);
    const limit = Math.min(this.parsePositiveInteger(query.limit, 20), 100);
    const filters: Prisma.RealEstateObjectWhereInput[] = [
      {
        deletedAt: null,
      },
    ];
    const search = query.search?.trim();
    const priceFromMin = this.parseNullableDecimal(query.priceFromMin, 'Price from min', 14, 2);
    const priceFromMax = this.parseNullableDecimal(query.priceFromMax, 'Price from max', 14, 2);
    const orderBy = this.parseObjectListOrderBy(query.sortBy, query.sortDirection);

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

    const districtSearch = query.districtSearch?.trim();

    if (districtSearch) {
      const locationSearchFilters = createSearchContainsFilters(districtSearch, ['name', 'slug']);

      filters.push({
        OR: [
          {
            primaryLocation: {
              is: {
                type: LocationType.DISTRICT,
                OR: locationSearchFilters,
              },
            },
          },
          {
            locations: {
              some: {
                location: {
                  type: LocationType.DISTRICT,
                  OR: locationSearchFilters,
                },
              },
            },
          },
        ],
      });
    }

    const areaSearch = query.areaSearch?.trim();

    if (areaSearch) {
      filters.push({
        locations: {
          some: {
            location: {
              type: LocationType.AREA,
              OR: createSearchContainsFilters(areaSearch, ['name', 'slug']),
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

    const metroSearch = query.metroSearch?.trim();

    if (metroSearch) {
      filters.push({
        metroStations: {
          some: {
            metroStation: {
              OR: createSearchContainsFilters(metroSearch, ['name', 'slug', 'lineName']),
            },
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

      filters.push(this.createFeedFallbackPriceFilter('priceFrom', 'feedPriceFrom', priceFromMin, priceFromMax));
    }

    const lotWhere = this.createObjectLotWhere({
      priceMin: query.lotPriceMin,
      priceMax: query.lotPriceMax,
      rooms: query.lotRooms,
      floorMin: query.lotFloorMin,
      floorMax: query.lotFloorMax,
    });

    if (lotWhere) {
      filters.push({
        feedUnits: {
          some: lotWhere,
        },
      });
    }

    const hasCoordinates = this.parseOptionalBoolean(query.hasCoordinates, 'Has coordinates is invalid');

    if (hasCoordinates === true) {
      filters.push({
        latitude: {
          not: null,
        },
        longitude: {
          not: null,
        },
      });
    }

    if (hasCoordinates === false) {
      filters.push({
        OR: [
          {
            latitude: null,
          },
          {
            longitude: null,
          },
        ],
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

    const where: Prisma.RealEstateObjectWhereInput = {
      AND: filters,
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.realEstateObject.findMany({
        where,
        include: objectListInclude,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.realEstateObject.count({ where }),
    ]);
    const matchedFeedUnitsCountByObjectId = await this.countMatchedFeedUnitsByObjectId(
      items.map((object) => object.id),
      lotWhere,
    );

    return {
      items: items.map((object) =>
        this.serializeObjectSummary(object, matchedFeedUnitsCountByObjectId.get(object.id) ?? null),
      ),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async getById(id: string) {
    const object = await this.findExistingObject(id);

    return {
      object: this.serializeObjectDetail(object),
    };
  }

  async getBySlug(slug: string) {
    const normalizedSlug = slug.trim();

    if (!normalizedSlug) {
      throw new BadRequestException('Object slug is required');
    }

    const object = await this.prisma.realEstateObject.findFirst({
      where: {
        slug: normalizedSlug,
        deletedAt: null,
      },
      include: objectDetailInclude,
    });

    if (!object) {
      throw new NotFoundException('Object not found');
    }

    return {
      object: this.serializeObjectDetail(object),
    };
  }

  async listFeedUnits(id: string, query: ListObjectFeedUnitsQuery) {
    const objectId = this.parseUuid(id, 'Object is invalid');
    await this.ensureObjectExists(objectId);

    const page = this.parsePositiveInteger(query.page, 1);
    const limit = Math.min(this.parsePositiveInteger(query.limit, 20), 100);
    const filters: Prisma.FeedUnitWhereInput[] = [
      {
        objectId,
      },
    ];

    if (query.status) {
      const statuses = this.parseFeedUnitStatuses(query.status);

      filters.push(
        statuses.length === 1
          ? {
              status: statuses[0],
            }
          : {
              status: {
                in: statuses,
              },
            },
      );
    }

    if (query.type) {
      filters.push({
        type: this.parseFeedUnitType(query.type),
      });
    }

    const search = query.search?.trim();

    if (search) {
      filters.push({
        OR: createSearchContainsFilters(search, ['externalId', 'title', 'address']),
      });
    }

    const priceFilter = this.createFeedUnitDecimalRangeFilter('effectivePrice', query.priceMin, query.priceMax, 'Price', 14, 2);
    const pricePerMeterFilter = this.createFeedUnitDecimalRangeFilter(
      'effectivePricePerMeter',
      query.pricePerMeterMin,
      query.pricePerMeterMax,
      'Price per meter',
      14,
      2,
    );
    const areaFilter = this.createFeedUnitDecimalRangeFilter('area', query.areaMin, query.areaMax, 'Area', 10, 2);
    const rooms = this.parseOptionalIntegerList(query.rooms, 'Rooms is invalid', 0, 5);
    const floorMin = this.parseOptionalInteger(query.floorMin, 'Floor min is invalid', 1, 300);
    const floorMax = this.parseOptionalInteger(query.floorMax, 'Floor max is invalid', 1, 300);
    const completionYear = this.parseOptionalInteger(query.completionYear, 'Completion year is invalid', 1900, 2200);
    const completionQuarter = this.parseOptionalInteger(query.completionQuarter, 'Completion quarter is invalid', 1, 4);

    if (floorMin !== undefined && floorMax !== undefined && floorMin > floorMax) {
      throw new BadRequestException('Floor min cannot be greater than max');
    }

    if (completionQuarter !== undefined && completionYear === undefined) {
      throw new BadRequestException('Completion year is required when completion quarter is set');
    }

    for (const filter of [priceFilter, pricePerMeterFilter, areaFilter]) {
      if (filter) {
        filters.push(filter);
      }
    }

    if (rooms !== undefined) {
      filters.push(this.createFeedUnitRoomsFilter(rooms));
    }

    if (floorMin !== undefined || floorMax !== undefined) {
      filters.push({
        floor: {
          ...(floorMin !== undefined ? { gte: floorMin } : {}),
          ...(floorMax !== undefined ? { lte: floorMax } : {}),
        },
      });
    }

    if (completionYear !== undefined) {
      filters.push({ completionYear });
    }

    if (completionQuarter !== undefined) {
      filters.push({ completionQuarter });
    }

    const where: Prisma.FeedUnitWhereInput = {
      AND: filters,
    };
    const orderBy = this.parseFeedUnitOrderBy(query.sortBy, query.sortDirection);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.feedUnit.findMany({
        where,
        include: feedUnitInclude,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.feedUnit.count({ where }),
    ]);

    return {
      items: items.map((unit) => this.serializeFeedUnit(unit)),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      hasDiscountPrices: items.some((unit) => unit.discountPrice !== null),
    };
  }

  async getFeedUnit(id: string, unitId: string) {
    const objectId = this.parseUuid(id, 'Object is invalid');
    const normalizedUnitId = this.parseUuid(unitId, 'Feed unit is invalid');
    await this.ensureObjectExists(objectId);

    const unit = await this.prisma.feedUnit.findFirst({
      where: {
        id: normalizedUnitId,
        objectId,
      },
      include: feedUnitInclude,
    });

    if (!unit) {
      throw new NotFoundException('Feed unit not found');
    }

    return {
      unit: this.serializeFeedUnit(unit),
    };
  }

  async create(body: CreateObjectBody, actor: AuthenticatedUser, request: RequestWithAudit) {
    if ('status' in body) {
      const status = this.parseObjectStatus(body.status);

      if (status !== ObjectStatus.DRAFT) {
        throw new BadRequestException('Use publish endpoint to publish object');
      }
    }

    const title = this.parseRequiredString(body.title, 'Title is required', 240);
    const slug = await this.generateUniqueSlug(title);
    const description = this.parseNullableText(body.description, 'Description', 30000);
    const architectureDescription = this.parseNullableText(body.architectureDescription, 'Architecture description', 10000);
    const infrastructureDescription = this.parseNullableText(
      body.infrastructureDescription,
      'Infrastructure description',
      10000,
    );
    const fillingDescription = this.parseNullableText(body.fillingDescription, 'Filling description', 10000);
    const shortDescription = this.parseNullableText(body.shortDescription, 'Short description', 2000);
    const mapName = this.parseNullableText(body.mapName, 'Map name', 16);
    const layoutsUrl = this.parseNullableUrl(body.layoutsUrl, 'Layouts URL', 2048);
    const krtName = this.parseNullableText(body.krtName, 'KRT name', 240);
    const apartmentAreaRange = this.parseNullableText(body.apartmentAreaRange, 'Apartment area range', 120);
    const ceilingHeight = this.parseNullableText(body.ceilingHeight, 'Ceiling height', 120);
    const propertyClass = this.parseNullableText(body.propertyClass, 'Property class', 120);
    const floorRange = this.parseNullableText(body.floorRange, 'Floor range', 120);
    const apartmentsCountText = this.parseNullableText(body.apartmentsCountText, 'Apartments count text', 120);
    const priceFrom = this.parseNullableDecimal(body.priceFrom, 'Price from', 14, 2);
    const pricePerMeterFrom = this.parseNullableDecimal(body.pricePerMeterFrom, 'Price per meter from', 14, 2);
    const completionYear = this.parseNullableInteger(body.completionYear, 'Completion year', 1900, 2200);
    const completionQuarter = this.parseNullableInteger(body.completionQuarter, 'Completion quarter', 1, 4);
    const address = this.parseNullableText(body.address, 'Address', 1000);
    const latitude = this.parseNullableCoordinate(body.latitude, 'Latitude', -90, 90);
    const longitude = this.parseNullableCoordinate(body.longitude, 'Longitude', -180, 180);
    const featuresJson = this.parseFeaturesJson(body.featuresJson);
    const developerId = this.parseNullableUuidField(body.developerId, 'Developer is invalid');
    const primaryLocationId = this.parseNullableUuidField(body.primaryLocationId, 'Primary location is invalid');
    const locationIds = this.normalizeObjectLocationIds(
      this.parseUuidArray(body.locationIds, 'Location is invalid') ?? [],
      primaryLocationId ?? null,
    );
    const metroStationIds = this.parseUuidArray(body.metroStationIds, 'Metro station is invalid') ?? [];
    const nextCompletionYear = completionYear ?? null;
    const nextCompletionQuarter = completionQuarter ?? null;
    const nextLatitude = latitude ?? null;
    const nextLongitude = longitude ?? null;

    this.validateCompletion(nextCompletionYear, nextCompletionQuarter);
    this.validateCoordinatePair(nextLatitude, nextLongitude);

    if (developerId) {
      await this.ensureDeveloperExists(developerId);
    }

    await this.ensureLocationIdsExist(locationIds);
    await this.ensureMetroStationIdsExist(metroStationIds);

    const object = await this.prisma.$transaction(async (tx) => {
      const createdObject = await tx.realEstateObject.create({
        data: {
          title,
          slug,
          status: ObjectStatus.DRAFT,
          ...(description !== undefined ? { description } : {}),
          ...(architectureDescription !== undefined ? { architectureDescription } : {}),
          ...(infrastructureDescription !== undefined ? { infrastructureDescription } : {}),
          ...(fillingDescription !== undefined ? { fillingDescription } : {}),
          ...(shortDescription !== undefined ? { shortDescription } : {}),
          ...(mapName !== undefined ? { mapName } : {}),
          ...(layoutsUrl !== undefined ? { layoutsUrl } : {}),
          ...(krtName !== undefined ? { krtName } : {}),
          ...(apartmentAreaRange !== undefined ? { apartmentAreaRange } : {}),
          ...(ceilingHeight !== undefined ? { ceilingHeight } : {}),
          ...(propertyClass !== undefined ? { propertyClass } : {}),
          ...(floorRange !== undefined ? { floorRange } : {}),
          ...(apartmentsCountText !== undefined ? { apartmentsCountText } : {}),
          ...(priceFrom !== undefined ? { priceFrom } : {}),
          ...(pricePerMeterFrom !== undefined ? { pricePerMeterFrom } : {}),
          ...(completionYear !== undefined ? { completionYear } : {}),
          ...(completionQuarter !== undefined ? { completionQuarter } : {}),
          ...(address !== undefined ? { address } : {}),
          ...(latitude !== undefined ? { latitude } : {}),
          ...(longitude !== undefined ? { longitude } : {}),
          ...(featuresJson !== undefined ? { featuresJson } : {}),
          ...(developerId !== undefined ? { developerId } : {}),
          ...(primaryLocationId !== undefined ? { primaryLocationId } : {}),
        },
      });

      await this.replaceLocationLinks(tx, createdObject.id, locationIds, primaryLocationId ?? null);
      await this.replaceMetroStationLinks(tx, createdObject.id, metroStationIds);

      return this.findExistingObject(createdObject.id, tx);
    });

    await this.logObjectAction({
      action: 'object.create',
      actor,
      request,
      objectId: object.id,
      metadata: {
        after: this.toAuditSnapshot(object),
      },
    });

    return {
      object: this.serializeObjectDetail(object),
    };
  }

  async update(id: string, body: UpdateObjectBody, actor: AuthenticatedUser, request: RequestWithAudit) {
    if ('status' in body) {
      throw new BadRequestException('Use publish endpoint to change object status');
    }

    const object = await this.findExistingObject(id);
    const data: Prisma.RealEstateObjectUncheckedUpdateInput = {};
    const changes: Record<string, Prisma.InputJsonValue> = {};
    let hasScalarChanges = false;

    let nextTitle = object.title;
    let nextDeveloperId = object.developerId;
    let nextPrimaryLocationId = object.primaryLocationId;
    let nextAddress = object.address;
    let nextLatitude = this.decimalToString(object.latitude);
    let nextLongitude = this.decimalToString(object.longitude);
    let nextCompletionYear = object.completionYear;
    let nextCompletionQuarter = object.completionQuarter;

    if ('title' in body) {
      const title = this.parseRequiredString(body.title, 'Title is required', 240);
      nextTitle = title;

      if (title !== object.title) {
        data.title = title;
        changes.title = this.change(object.title, title);
        hasScalarChanges = true;
      }
    }

    if ('description' in body) {
      const description = this.parseNullableText(body.description, 'Description', 30000) ?? null;

      if (description !== object.description) {
        data.description = description;
        changes.description = this.change(object.description, description);
        hasScalarChanges = true;
      }
    }

    if ('architectureDescription' in body) {
      const architectureDescription =
        this.parseNullableText(body.architectureDescription, 'Architecture description', 10000) ?? null;

      if (architectureDescription !== object.architectureDescription) {
        data.architectureDescription = architectureDescription;
        changes.architectureDescription = this.change(object.architectureDescription, architectureDescription);
        hasScalarChanges = true;
      }
    }

    if ('infrastructureDescription' in body) {
      const infrastructureDescription =
        this.parseNullableText(body.infrastructureDescription, 'Infrastructure description', 10000) ?? null;

      if (infrastructureDescription !== object.infrastructureDescription) {
        data.infrastructureDescription = infrastructureDescription;
        changes.infrastructureDescription = this.change(object.infrastructureDescription, infrastructureDescription);
        hasScalarChanges = true;
      }
    }

    if ('fillingDescription' in body) {
      const fillingDescription =
        this.parseNullableText(body.fillingDescription, 'Filling description', 10000) ?? null;

      if (fillingDescription !== object.fillingDescription) {
        data.fillingDescription = fillingDescription;
        changes.fillingDescription = this.change(object.fillingDescription, fillingDescription);
        hasScalarChanges = true;
      }
    }

    if ('shortDescription' in body) {
      const shortDescription = this.parseNullableText(body.shortDescription, 'Short description', 2000) ?? null;

      if (shortDescription !== object.shortDescription) {
        data.shortDescription = shortDescription;
        changes.shortDescription = this.change(object.shortDescription, shortDescription);
        hasScalarChanges = true;
      }
    }

    if ('mapName' in body) {
      const mapName = this.parseNullableText(body.mapName, 'Map name', 16) ?? null;

      if (mapName !== object.mapName) {
        data.mapName = mapName;
        changes.mapName = this.change(object.mapName, mapName);
        hasScalarChanges = true;
      }
    }

    if ('layoutsUrl' in body) {
      const layoutsUrl = this.parseNullableUrl(body.layoutsUrl, 'Layouts URL', 2048) ?? null;

      if (layoutsUrl !== object.layoutsUrl) {
        data.layoutsUrl = layoutsUrl;
        changes.layoutsUrl = this.change(object.layoutsUrl, layoutsUrl);
        hasScalarChanges = true;
      }
    }

    if ('krtName' in body) {
      const krtName = this.parseNullableText(body.krtName, 'KRT name', 240) ?? null;

      if (krtName !== object.krtName) {
        data.krtName = krtName;
        changes.krtName = this.change(object.krtName, krtName);
        hasScalarChanges = true;
      }
    }

    if ('apartmentAreaRange' in body) {
      const apartmentAreaRange = this.parseNullableText(body.apartmentAreaRange, 'Apartment area range', 120) ?? null;

      if (apartmentAreaRange !== object.apartmentAreaRange) {
        data.apartmentAreaRange = apartmentAreaRange;
        changes.apartmentAreaRange = this.change(object.apartmentAreaRange, apartmentAreaRange);
        hasScalarChanges = true;
      }
    }

    if ('ceilingHeight' in body) {
      const ceilingHeight = this.parseNullableText(body.ceilingHeight, 'Ceiling height', 120) ?? null;

      if (ceilingHeight !== object.ceilingHeight) {
        data.ceilingHeight = ceilingHeight;
        changes.ceilingHeight = this.change(object.ceilingHeight, ceilingHeight);
        hasScalarChanges = true;
      }
    }

    if ('propertyClass' in body) {
      const propertyClass = this.parseNullableText(body.propertyClass, 'Property class', 120) ?? null;

      if (propertyClass !== object.propertyClass) {
        data.propertyClass = propertyClass;
        changes.propertyClass = this.change(object.propertyClass, propertyClass);
        hasScalarChanges = true;
      }
    }

    if ('floorRange' in body) {
      const floorRange = this.parseNullableText(body.floorRange, 'Floor range', 120) ?? null;

      if (floorRange !== object.floorRange) {
        data.floorRange = floorRange;
        changes.floorRange = this.change(object.floorRange, floorRange);
        hasScalarChanges = true;
      }
    }

    if ('apartmentsCountText' in body) {
      const apartmentsCountText = this.parseNullableText(body.apartmentsCountText, 'Apartments count text', 120) ?? null;

      if (apartmentsCountText !== object.apartmentsCountText) {
        data.apartmentsCountText = apartmentsCountText;
        changes.apartmentsCountText = this.change(object.apartmentsCountText, apartmentsCountText);
        hasScalarChanges = true;
      }
    }

    if ('priceFrom' in body) {
      const priceFrom = this.parseNullableDecimal(body.priceFrom, 'Price from', 14, 2) ?? null;
      const currentPriceFrom = this.decimalToString(object.priceFrom);

      if (priceFrom !== currentPriceFrom) {
        data.priceFrom = priceFrom;
        changes.priceFrom = this.change(currentPriceFrom, priceFrom);
        hasScalarChanges = true;
      }
    }

    if ('pricePerMeterFrom' in body) {
      const pricePerMeterFrom = this.parseNullableDecimal(body.pricePerMeterFrom, 'Price per meter from', 14, 2) ?? null;
      const currentPricePerMeterFrom = this.decimalToString(object.pricePerMeterFrom);

      if (pricePerMeterFrom !== currentPricePerMeterFrom) {
        data.pricePerMeterFrom = pricePerMeterFrom;
        changes.pricePerMeterFrom = this.change(currentPricePerMeterFrom, pricePerMeterFrom);
        hasScalarChanges = true;
      }
    }

    if ('completionYear' in body) {
      const completionYear = this.parseNullableInteger(body.completionYear, 'Completion year', 1900, 2200) ?? null;
      nextCompletionYear = completionYear;

      if (completionYear !== object.completionYear) {
        data.completionYear = completionYear;
        changes.completionYear = this.changeNumber(object.completionYear, completionYear);
        hasScalarChanges = true;
      }
    }

    if ('completionQuarter' in body) {
      const completionQuarter = this.parseNullableInteger(body.completionQuarter, 'Completion quarter', 1, 4) ?? null;
      nextCompletionQuarter = completionQuarter;

      if (completionQuarter !== object.completionQuarter) {
        data.completionQuarter = completionQuarter;
        changes.completionQuarter = this.changeNumber(object.completionQuarter, completionQuarter);
        hasScalarChanges = true;
      }
    }

    if ('address' in body) {
      const address = this.parseNullableText(body.address, 'Address', 1000) ?? null;
      nextAddress = address;

      if (address !== object.address) {
        data.address = address;
        changes.address = this.change(object.address, address);
        hasScalarChanges = true;
      }
    }

    if ('latitude' in body) {
      const latitude = this.parseNullableCoordinate(body.latitude, 'Latitude', -90, 90) ?? null;
      nextLatitude = latitude;

      if (latitude !== this.decimalToString(object.latitude)) {
        data.latitude = latitude;
        changes.latitude = this.change(this.decimalToString(object.latitude), latitude);
        hasScalarChanges = true;
      }
    }

    if ('longitude' in body) {
      const longitude = this.parseNullableCoordinate(body.longitude, 'Longitude', -180, 180) ?? null;
      nextLongitude = longitude;

      if (longitude !== this.decimalToString(object.longitude)) {
        data.longitude = longitude;
        changes.longitude = this.change(this.decimalToString(object.longitude), longitude);
        hasScalarChanges = true;
      }
    }

    if ('featuresJson' in body) {
      const featuresJson = this.parseFeaturesJson(body.featuresJson) ?? {};
      const currentFeaturesJson = object.featuresJson as Prisma.InputJsonValue;

      if (JSON.stringify(featuresJson) !== JSON.stringify(currentFeaturesJson)) {
        data.featuresJson = featuresJson;
        changes.featuresJson = {
          changed: true,
        };
        hasScalarChanges = true;
      }
    }

    if ('developerId' in body) {
      const developerId = this.parseNullableUuidField(body.developerId, 'Developer is invalid') ?? null;
      nextDeveloperId = developerId;

      if (developerId) {
        await this.ensureDeveloperExists(developerId);
      }

      if (developerId !== object.developerId) {
        data.developerId = developerId;
        changes.developerId = this.change(object.developerId, developerId);
        hasScalarChanges = true;
      }
    }

    const currentLocationIds = object.locations.map((link) => link.locationId);
    let nextLocationIds = currentLocationIds;
    let hasLocationChanges = false;

    if ('primaryLocationId' in body) {
      const primaryLocationId = this.parseNullableUuidField(body.primaryLocationId, 'Primary location is invalid') ?? null;
      nextPrimaryLocationId = primaryLocationId;

      if (primaryLocationId !== object.primaryLocationId) {
        data.primaryLocationId = primaryLocationId;
        changes.primaryLocationId = this.change(object.primaryLocationId, primaryLocationId);
        hasScalarChanges = true;
        hasLocationChanges = true;
      }
    }

    if ('locationIds' in body) {
      nextLocationIds = this.parseUuidArray(body.locationIds, 'Location is invalid') ?? [];
      hasLocationChanges = true;
    }

    nextLocationIds = this.normalizeObjectLocationIds(nextLocationIds, nextPrimaryLocationId);

    if (!this.sameStringArray(currentLocationIds, nextLocationIds)) {
      changes.locationIds = this.changeArray(currentLocationIds, nextLocationIds);
      hasLocationChanges = true;
    }

    const currentMetroStationIds = object.metroStations.map((link) => link.metroStationId);
    let nextMetroStationIds = currentMetroStationIds;
    let hasMetroStationChanges = false;

    if ('metroStationIds' in body) {
      nextMetroStationIds = this.parseUuidArray(body.metroStationIds, 'Metro station is invalid') ?? [];

      if (!this.sameStringArray(currentMetroStationIds, nextMetroStationIds)) {
        changes.metroStationIds = this.changeArray(currentMetroStationIds, nextMetroStationIds);
        hasMetroStationChanges = true;
      }
    }

    this.validateCompletion(nextCompletionYear, nextCompletionQuarter);
    this.validateCoordinatePair(nextLatitude, nextLongitude);

    if (object.status === ObjectStatus.PUBLISHED) {
      this.validatePublishedObjectUpdate(
        {
          title: object.title,
          slug: object.slug,
          status: object.status,
          developerId: object.developerId,
          primaryLocationId: object.primaryLocationId,
          address: object.address,
          latitude: this.decimalToString(object.latitude),
          longitude: this.decimalToString(object.longitude),
          completionYear: object.completionYear,
          completionQuarter: object.completionQuarter,
        },
        {
          title: nextTitle,
          slug: object.slug,
          status: object.status,
          developerId: nextDeveloperId,
          primaryLocationId: nextPrimaryLocationId,
          address: nextAddress,
          latitude: nextLatitude,
          longitude: nextLongitude,
          completionYear: nextCompletionYear,
          completionQuarter: nextCompletionQuarter,
        },
      );
    }

    if (nextPrimaryLocationId && !nextLocationIds.includes(nextPrimaryLocationId)) {
      nextLocationIds = this.normalizeObjectLocationIds(nextLocationIds, nextPrimaryLocationId);
      hasLocationChanges = true;
    }

    await this.ensureLocationIdsExist(nextLocationIds);
    await this.ensureMetroStationIdsExist(nextMetroStationIds);

    if (!hasScalarChanges && !hasLocationChanges && !hasMetroStationChanges) {
      return {
        object: this.serializeObjectDetail(object),
      };
    }

    const updatedObject = await this.prisma.$transaction(async (tx) => {
      if (hasScalarChanges) {
        await tx.realEstateObject.update({
          where: {
            id: object.id,
          },
          data,
        });
      }

      if (hasLocationChanges) {
        await this.replaceLocationLinks(tx, object.id, nextLocationIds, nextPrimaryLocationId);
      }

      if (hasMetroStationChanges) {
        await this.replaceMetroStationLinks(tx, object.id, nextMetroStationIds);
      }

      return this.findExistingObject(object.id, tx);
    });

    await this.logObjectAction({
      action: 'object.update',
      actor,
      request,
      objectId: updatedObject.id,
      metadata: {
        before: this.toAuditSnapshot(object),
        after: this.toAuditSnapshot(updatedObject),
        changes,
      },
    });

    return {
      object: this.serializeObjectDetail(updatedObject),
    };
  }

  async publish(id: string, actor: AuthenticatedUser, request: RequestWithAudit) {
    return this.updateStatus(id, { status: ObjectStatus.PUBLISHED }, actor, request);
  }

  async updateStatus(id: string, body: UpdateObjectStatusBody, actor: AuthenticatedUser, request: RequestWithAudit) {
    const status = this.parseQuickEditStatus(body.status);
    const object = await this.findExistingObject(id);

    if (object.status === status) {
      return {
        object: this.serializeObjectDetail(object),
      };
    }

    if (status === ObjectStatus.PUBLISHED) {
      this.validatePublishRequirements({
        title: object.title,
        slug: object.slug,
        status: object.status,
        developerId: object.developerId,
        primaryLocationId: object.primaryLocationId,
        address: object.address,
        latitude: this.decimalToString(object.latitude),
        longitude: this.decimalToString(object.longitude),
        completionYear: object.completionYear,
        completionQuarter: object.completionQuarter,
      });
    }

    const updatedObject = await this.prisma.realEstateObject.update({
      where: {
        id: object.id,
      },
      data:
        status === ObjectStatus.PUBLISHED
          ? {
              status: ObjectStatus.PUBLISHED,
              publishedAt: object.publishedAt ?? new Date(),
              archivedAt: null,
            }
          : {
              status: ObjectStatus.ARCHIVED,
              archivedAt: object.archivedAt ?? new Date(),
            },
      include: objectDetailInclude,
    });

    await this.logObjectAction({
      action: status === ObjectStatus.PUBLISHED ? 'object.publish' : 'object.archive',
      actor,
      request,
      objectId: updatedObject.id,
      metadata: {
        before: this.toAuditSnapshot(object),
        after: this.toAuditSnapshot(updatedObject),
      },
    });

    return {
      object: this.serializeObjectDetail(updatedObject),
    };
  }

  async uploadCover(
    id: string,
    file: UploadedFile | undefined,
    actor: AuthenticatedUser,
    request: RequestWithAudit,
  ) {
    const object = await this.findExistingObject(id);
    const uploadedFile = await this.filesService.uploadFile(file, actor, 'image');

    try {
      const updatedObject = await this.prisma.$transaction(async (tx) => {
        await tx.objectImage.updateMany({
          where: {
            objectId: object.id,
          },
          data: {
            isCover: false,
            sortOrder: {
              increment: 1,
            },
          },
        });

        await tx.objectImage.create({
          data: {
            objectId: object.id,
            fileId: uploadedFile.file.id,
            sortOrder: 0,
            isCover: true,
          },
        });

        return this.findExistingObject(object.id, tx);
      });

      await this.logObjectAction({
        action: 'object.cover.upload',
        actor,
        request,
        objectId: updatedObject.id,
        metadata: {
          fileId: uploadedFile.file.id,
        },
      });

      return {
        object: this.serializeObjectDetail(updatedObject),
      };
    } catch (error) {
      await this.filesService.deleteUnlinkedFile(uploadedFile.file.id);
      throw error;
    }
  }

  async uploadGalleryImage(
    id: string,
    file: UploadedFile | undefined,
    actor: AuthenticatedUser,
    request: RequestWithAudit,
  ) {
    const object = await this.findExistingObject(id);
    const uploadedFile = await this.filesService.uploadFile(file, actor, 'image');

    try {
      const updatedObject = await this.prisma.$transaction(async (tx) => {
        const maxSortOrder = await tx.objectImage.aggregate({
          where: {
            objectId: object.id,
          },
          _max: {
            sortOrder: true,
          },
        });

        await tx.objectImage.create({
          data: {
            objectId: object.id,
            fileId: uploadedFile.file.id,
            sortOrder: (maxSortOrder._max.sortOrder ?? -1) + 1,
            isCover: false,
          },
        });

        return this.findExistingObject(object.id, tx);
      });

      await this.logObjectAction({
        action: 'object.gallery.upload',
        actor,
        request,
        objectId: updatedObject.id,
        metadata: {
          fileId: uploadedFile.file.id,
        },
      });

      return {
        object: this.serializeObjectDetail(updatedObject),
      };
    } catch (error) {
      await this.filesService.deleteUnlinkedFile(uploadedFile.file.id);
      throw error;
    }
  }

  async uploadGalleryImageStream(
    id: string,
    fileStream: GalleryStreamUploadRequest,
    actor: AuthenticatedUser,
    request: RequestWithAudit,
  ) {
    const object = await this.findExistingObject(id);
    const uploadedFile = await this.filesService.uploadFileStream(
      this.createUploadedFileStream(fileStream),
      actor,
      'image',
    );

    try {
      await this.logObjectAction({
        action: 'object.gallery.upload',
        actor,
        request,
        objectId: object.id,
        metadata: {
          fileId: uploadedFile.file.id,
        },
      });

      return {
        object: this.serializeObjectDetail(object),
        file: uploadedFile.file,
      };
    } catch (error) {
      await this.filesService.deleteUnlinkedFile(uploadedFile.file.id);
      throw error;
    }
  }

  async sortGallery(
    id: string,
    body: SortGalleryBody,
    actor: AuthenticatedUser,
    request: RequestWithAudit,
  ) {
    const object = await this.findExistingObject(id);
    const imageIds = this.parseUuidArray(body.imageIds, 'Gallery image is invalid') ?? [];
    const currentImageIds = object.images.map((image) => image.id);

    if (!this.sameStringSet(currentImageIds, imageIds)) {
      throw new BadRequestException('Gallery image ids must match current object gallery');
    }

    if (this.sameStringArray(currentImageIds, imageIds)) {
      return {
        object: this.serializeObjectDetail(object),
      };
    }

    const updatedObject = await this.prisma.$transaction(async (tx) => {
      await Promise.all(
        imageIds.map((imageId, index) =>
          tx.objectImage.update({
            where: {
              id: imageId,
            },
            data: {
              sortOrder: index,
            },
          }),
        ),
      );

      return this.findExistingObject(object.id, tx);
    });

    await this.logObjectAction({
      action: 'object.gallery.sort',
      actor,
      request,
      objectId: updatedObject.id,
      metadata: {
        before: {
          imageIds: currentImageIds,
        },
        after: {
          imageIds,
        },
      },
    });

    return {
      object: this.serializeObjectDetail(updatedObject),
    };
  }

  async updateGalleryLayout(
    id: string,
    body: GalleryLayoutBody,
    actor: AuthenticatedUser,
    request: RequestWithAudit,
  ) {
    const object = await this.findExistingObject(id);
    const imageIds = this.parseUuidList(body.imageIds, 'Gallery image is invalid') ?? [];
    const coverImageId = this.parseNullableUuidField(body.coverImageId, 'Cover image is invalid') ?? null;
    const imageSections = this.parseImageSections(body.imageSections, imageIds);
    const currentImageIds = object.images.map((image) => image.id);
    const currentCoverImageId = object.images.find((image) => image.isCover)?.id ?? null;
    const currentImageSections = this.createImageSectionMap(object.images);
    const hasDuplicateImageIds = new Set(imageIds).size !== imageIds.length;

    if (hasDuplicateImageIds || !this.sameStringSet(currentImageIds, imageIds)) {
      throw new BadRequestException('Gallery image ids must match current object gallery');
    }

    if (coverImageId && !imageIds.includes(coverImageId)) {
      throw new BadRequestException('Cover image must be included in gallery image ids');
    }

    const hasOrderChanges = !this.sameStringArray(currentImageIds, imageIds);
    const hasCoverChanges = object.images.some((image) => image.isCover !== (image.id === coverImageId));
    const hasSectionChanges = imageSections
      ? imageIds.some((imageId) => currentImageSections[imageId] !== imageSections[imageId])
      : false;

    if (!hasOrderChanges && !hasCoverChanges && !hasSectionChanges) {
      return {
        object: this.serializeObjectDetail(object),
      };
    }

    const updatedObject = await this.prisma.$transaction(async (tx) => {
      await Promise.all(
        imageIds.map((imageId, index) =>
          tx.objectImage.update({
            where: {
              id: imageId,
            },
            data: {
              sortOrder: index,
              isCover: imageId === coverImageId,
              ...(imageSections ? { section: imageSections[imageId] } : {}),
            },
          }),
        ),
      );

      return this.findExistingObject(object.id, tx);
    });

    const beforeMetadata = {
      imageIds: currentImageIds,
      coverImageId: currentCoverImageId,
      ...(hasSectionChanges ? { imageSections: currentImageSections } : {}),
    };
    const afterMetadata = {
      imageIds,
      coverImageId,
      ...(hasSectionChanges && imageSections ? { imageSections } : {}),
    };

    await this.logObjectAction({
      action: 'object.gallery.layout',
      actor,
      request,
      objectId: updatedObject.id,
      metadata: {
        before: beforeMetadata,
        after: afterMetadata,
      },
    });

    return {
      object: this.serializeObjectDetail(updatedObject),
    };
  }

  async replaceGallery(
    id: string,
    body: GalleryBatchBody,
    files: UploadedFile[] | undefined,
    actor: AuthenticatedUser,
    request: RequestWithAudit,
  ) {
    const object = await this.findExistingObject(id);
    const normalizedFiles = files ?? [];
    const layout = this.parseGalleryBatchLayout(body.layout, normalizedFiles.length);
    const currentImagesById = new Map(object.images.map((image) => [image.id, image]));
    const existingImageIds = layout.items
      .filter((item): item is Extract<GalleryBatchItem, { kind: 'existing' }> => item.kind === 'existing')
      .map((item) => item.imageId);
    const stagedFileIds = layout.items
      .filter((item): item is Extract<GalleryBatchItem, { kind: 'staged' }> => item.kind === 'staged')
      .map((item) => item.fileId);
    const existingImageIdSet = new Set(existingImageIds);
    const deletedImages = object.images.filter((image) => !existingImageIdSet.has(image.id));
    const deletedImageIds = deletedImages.map((image) => image.id);
    const currentImageIds = object.images.map((image) => image.id);
    const currentCoverImageId = object.images.find((image) => image.isCover)?.id ?? null;
    const currentImageSections = this.createImageSectionMap(object.images);

    for (const imageId of existingImageIds) {
      if (!currentImagesById.has(imageId)) {
        throw new BadRequestException('Gallery image ids must match current object gallery');
      }
    }

    if (layout.items.some((item) => item.kind === 'new' || item.kind === 'staged') && !actor.permissions.includes('files:upload')) {
      throw new ForbiddenException('Insufficient permissions');
    }

    if (deletedImageIds.length > 0 && !actor.permissions.includes('files:delete')) {
      throw new ForbiddenException('Insufficient permissions');
    }

    const stagedFilesById = await this.findStagedGalleryFiles(stagedFileIds, actor);
    const uploadedFiles: Awaited<ReturnType<FilesService['uploadFile']>>[] = [];

    try {
      for (const file of normalizedFiles) {
        uploadedFiles.push(await this.filesService.uploadFile(file, actor, 'image'));
      }

      const updatedObject = await this.prisma.$transaction(async (tx) => {
        if (deletedImageIds.length > 0) {
          await tx.objectImage.deleteMany({
            where: {
              objectId: object.id,
              id: {
                in: deletedImageIds,
              },
            },
          });
        }

        await Promise.all(
          layout.items.map((item, index) => {
            if (item.kind === 'new') {
              const uploadedFile = uploadedFiles[item.fileIndex];

              if (!uploadedFile) {
                throw new BadRequestException('Gallery batch file is invalid');
              }

              return tx.objectImage.create({
                data: {
                  objectId: object.id,
                  fileId: uploadedFile.file.id,
                  sortOrder: index,
                  isCover: index === layout.coverIndex,
                  section: item.section,
                },
              });
            }

            if (item.kind === 'staged') {
              const stagedFile = stagedFilesById.get(item.fileId);

              if (!stagedFile) {
                throw new BadRequestException('Gallery staged file is invalid');
              }

              return tx.objectImage.create({
                data: {
                  objectId: object.id,
                  fileId: stagedFile.id,
                  sortOrder: index,
                  isCover: index === layout.coverIndex,
                  section: item.section,
                },
              });
            }

            return tx.objectImage.update({
              where: {
                id: item.imageId,
              },
              data: {
                sortOrder: index,
                isCover: index === layout.coverIndex,
                section: item.section,
              },
            });
          }),
        );

        return this.findExistingObject(object.id, tx);
      });

      for (const image of deletedImages) {
        await this.filesService.deleteUnlinkedFile(image.file.id);
      }

      const nextImageIds = updatedObject.images.map((image) => image.id);
      const nextCoverImageId = updatedObject.images.find((image) => image.isCover)?.id ?? null;
      const nextImageSections = this.createImageSectionMap(updatedObject.images);

      await this.logObjectAction({
        action: 'object.gallery.batch',
        actor,
        request,
        objectId: updatedObject.id,
        metadata: {
          before: {
            imageIds: currentImageIds,
            coverImageId: currentCoverImageId,
            imageSections: currentImageSections,
          },
          after: {
            imageIds: nextImageIds,
            coverImageId: nextCoverImageId,
            imageSections: nextImageSections,
          },
          deletedImageIds,
          uploadedFileIds: [...uploadedFiles.map((uploadedFile) => uploadedFile.file.id), ...stagedFileIds],
        },
      });

      return {
        object: this.serializeObjectDetail(updatedObject),
      };
    } catch (error) {
      for (const uploadedFile of uploadedFiles) {
        await this.filesService.deleteUnlinkedFile(uploadedFile.file.id);
      }

      for (const stagedFileId of stagedFileIds) {
        await this.filesService.deleteUnlinkedFile(stagedFileId);
      }

      throw error;
    }
  }

  private async findStagedGalleryFiles(fileIds: string[], actor: AuthenticatedUser) {
    if (fileIds.length === 0) {
      return new Map<string, { id: string }>();
    }

    const files = await this.prisma.file.findMany({
      where: {
        id: {
          in: fileIds,
        },
      },
      include: {
        _count: {
          select: {
            profilePhotoUsers: true,
            objectImages: true,
            objectFiles: true,
            feedXmlSources: true,
            feedMediaAssets: true,
          },
        },
      },
    });

    if (files.length !== fileIds.length) {
      throw new BadRequestException('Gallery staged file is invalid');
    }

    for (const file of files) {
      const isImage = IMAGE_MIME_TYPES.includes(file.mimeType as (typeof IMAGE_MIME_TYPES)[number]);
      const isOwnedByActor = file.uploadedById === actor.id;
      const isUnlinked =
        file._count.profilePhotoUsers === 0 &&
        file._count.objectImages === 0 &&
        file._count.objectFiles === 0 &&
        file._count.feedXmlSources === 0 &&
        file._count.feedMediaAssets === 0;

      if (!isImage || !isOwnedByActor || !isUnlinked) {
        throw new BadRequestException('Gallery staged file is invalid');
      }
    }

    return new Map(files.map((file) => [file.id, file]));
  }

  async deleteGalleryImage(
    id: string,
    imageId: string,
    actor: AuthenticatedUser,
    request: RequestWithAudit,
  ) {
    const object = await this.findExistingObject(id);
    const normalizedImageId = this.parseUuid(imageId, 'Gallery image is invalid');
    const image = object.images.find((currentImage) => currentImage.id === normalizedImageId);

    if (!image) {
      throw new NotFoundException('Gallery image not found');
    }

    const updatedObject = await this.prisma.$transaction(async (tx) => {
      await tx.objectImage.delete({
        where: {
          id: image.id,
        },
      });

      const remainingImages = await tx.objectImage.findMany({
        where: {
          objectId: object.id,
        },
        orderBy: [
          {
            sortOrder: 'asc',
          },
          {
            createdAt: 'asc',
          },
        ],
      });

      await Promise.all(
        remainingImages.map((remainingImage, index) =>
          tx.objectImage.update({
            where: {
              id: remainingImage.id,
            },
            data: {
              sortOrder: index,
              isCover: image.isCover ? index === 0 : remainingImage.isCover,
            },
          }),
        ),
      );

      return this.findExistingObject(object.id, tx);
    });

    await this.filesService.deleteUnlinkedFile(image.file.id);

    await this.logObjectAction({
      action: 'object.gallery.delete',
      actor,
      request,
      objectId: updatedObject.id,
      metadata: {
        imageId: image.id,
        fileId: image.file.id,
        wasCover: image.isCover,
      },
    });

    return {
      object: this.serializeObjectDetail(updatedObject),
    };
  }

  async uploadObjectFile(
    id: string,
    body: UploadObjectFileBody,
    file: UploadedFile | undefined,
    actor: AuthenticatedUser,
    request: RequestWithAudit,
  ) {
    const object = await this.findExistingObject(id);
    const type = this.parseObjectFileType(body.type);
    const title = this.parseNullableText(body.title, 'File title', 500) ?? null;

    if (object.files.length >= objectPdfUploadLimit) {
      throw new BadRequestException(`Object cannot have more than ${objectPdfUploadLimit} PDF files`);
    }

    const uploadedFile = await this.filesService.uploadFile(file, actor, 'pdf');

    try {
      const updatedObject = await this.prisma.$transaction(async (tx) => {
        const existingFileCount = await tx.objectFile.count({
          where: {
            objectId: object.id,
          },
        });

        if (existingFileCount >= objectPdfUploadLimit) {
          throw new BadRequestException(`Object cannot have more than ${objectPdfUploadLimit} PDF files`);
        }

        const maxSortOrder = await tx.objectFile.aggregate({
          where: {
            objectId: object.id,
            type,
          },
          _max: {
            sortOrder: true,
          },
        });

        await tx.objectFile.create({
          data: {
            objectId: object.id,
            fileId: uploadedFile.file.id,
            type,
            title,
            sortOrder: (maxSortOrder._max.sortOrder ?? -1) + 1,
          },
        });

        return this.findExistingObject(object.id, tx);
      });

      await this.logObjectAction({
        action: 'object.file.upload',
        actor,
        request,
        objectId: updatedObject.id,
        metadata: {
          fileId: uploadedFile.file.id,
          type,
          title,
        },
      });

      return {
        object: this.serializeObjectDetail(updatedObject),
      };
    } catch (error) {
      await this.filesService.deleteUnlinkedFile(uploadedFile.file.id);
      throw error;
    }
  }

  async deleteObjectFile(
    id: string,
    objectFileId: string,
    actor: AuthenticatedUser,
    request: RequestWithAudit,
  ) {
    const object = await this.findExistingObject(id);
    const normalizedObjectFileId = this.parseUuid(objectFileId, 'Object file is invalid');
    const objectFile = object.files.find((currentFile) => currentFile.id === normalizedObjectFileId);

    if (!objectFile) {
      throw new NotFoundException('Object file not found');
    }

    const updatedObject = await this.prisma.$transaction(async (tx) => {
      await tx.objectFile.delete({
        where: {
          id: objectFile.id,
        },
      });

      const remainingFiles = await tx.objectFile.findMany({
        where: {
          objectId: object.id,
          type: objectFile.type,
        },
        orderBy: [
          {
            sortOrder: 'asc',
          },
          {
            createdAt: 'asc',
          },
        ],
      });

      await Promise.all(
        remainingFiles.map((remainingFile, index) =>
          tx.objectFile.update({
            where: {
              id: remainingFile.id,
            },
            data: {
              sortOrder: index,
            },
          }),
        ),
      );

      return this.findExistingObject(object.id, tx);
    });

    await this.filesService.deleteUnlinkedFile(objectFile.file.id);

    await this.logObjectAction({
      action: 'object.file.delete',
      actor,
      request,
      objectId: updatedObject.id,
      metadata: {
        objectFileId: objectFile.id,
        fileId: objectFile.file.id,
        type: objectFile.type,
        title: objectFile.title,
      },
    });

    return {
      object: this.serializeObjectDetail(updatedObject),
    };
  }

  private async findExistingObject(id: string, client: ObjectClient = this.prisma) {
    const objectId = this.parseUuid(id, 'Object is invalid');
    const object = await client.realEstateObject.findFirst({
      where: {
        id: objectId,
        deletedAt: null,
      },
      include: objectDetailInclude,
    });

    if (!object) {
      throw new NotFoundException('Object not found');
    }

    return object;
  }

  private async generateUniqueSlug(title: string) {
    const baseSlug = this.slugify(title);
    let slug = baseSlug;
    let index = 2;

    while (await this.prisma.realEstateObject.findUnique({ where: { slug }, select: { id: true } })) {
      slug = `${baseSlug}-${index}`;
      index += 1;
    }

    return slug;
  }

  private slugify(value: string) {
    const transliterationMap: Record<string, string> = {
      а: 'a',
      б: 'b',
      в: 'v',
      г: 'g',
      д: 'd',
      е: 'e',
      ё: 'e',
      ж: 'zh',
      з: 'z',
      и: 'i',
      й: 'y',
      к: 'k',
      л: 'l',
      м: 'm',
      н: 'n',
      о: 'o',
      п: 'p',
      р: 'r',
      с: 's',
      т: 't',
      у: 'u',
      ф: 'f',
      х: 'h',
      ц: 'ts',
      ч: 'ch',
      ш: 'sh',
      щ: 'sch',
      ъ: '',
      ы: 'y',
      ь: '',
      э: 'e',
      ю: 'yu',
      я: 'ya',
    };
    const transliterated = value
      .trim()
      .toLowerCase()
      .split('')
      .map((character) => transliterationMap[character] ?? character)
      .join('');
    const slug = transliterated
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-')
      .slice(0, 120)
      .replace(/-+$/g, '');

    return slug || 'object';
  }

  private async ensureDeveloperExists(developerId: string) {
    const developer = await this.prisma.developer.findUnique({
      where: {
        id: developerId,
      },
      select: {
        id: true,
      },
    });

    if (!developer) {
      throw new BadRequestException('Developer does not exist');
    }
  }

  private async ensureObjectExists(objectId: string) {
    const count = await this.prisma.realEstateObject.count({
      where: {
        id: objectId,
        deletedAt: null,
      },
    });

    if (count === 0) {
      throw new NotFoundException('Object not found');
    }
  }

  private async ensureLocationIdsExist(locationIds: string[]) {
    if (locationIds.length === 0) {
      return;
    }

    const locations = await this.prisma.location.findMany({
      where: {
        id: {
          in: locationIds,
        },
      },
      select: {
        id: true,
      },
    });

    if (locations.length !== locationIds.length) {
      throw new BadRequestException('Location does not exist');
    }
  }

  private async ensureMetroStationIdsExist(metroStationIds: string[]) {
    if (metroStationIds.length === 0) {
      return;
    }

    const metroStations = await this.prisma.metroStation.findMany({
      where: {
        id: {
          in: metroStationIds,
        },
      },
      select: {
        id: true,
      },
    });

    if (metroStations.length !== metroStationIds.length) {
      throw new BadRequestException('Metro station does not exist');
    }
  }

  private async replaceLocationLinks(
    client: Prisma.TransactionClient,
    objectId: string,
    locationIds: string[],
    primaryLocationId: string | null,
  ) {
    await client.objectLocation.deleteMany({
      where: {
        objectId,
      },
    });

    if (locationIds.length === 0) {
      return;
    }

    await client.objectLocation.createMany({
      data: locationIds.map((locationId, index) => ({
        objectId,
        locationId,
        isPrimary: locationId === primaryLocationId,
        sortOrder: index,
      })),
    });
  }

  private async replaceMetroStationLinks(
    client: Prisma.TransactionClient,
    objectId: string,
    metroStationIds: string[],
  ) {
    await client.objectMetroStation.deleteMany({
      where: {
        objectId,
      },
    });

    if (metroStationIds.length === 0) {
      return;
    }

    await client.objectMetroStation.createMany({
      data: metroStationIds.map((metroStationId, index) => ({
        objectId,
        metroStationId,
        sortOrder: index,
      })),
    });
  }

  private validatePublishRequirements(state: ObjectLifecycleState) {
    this.validateCompletion(state.completionYear, state.completionQuarter);
    this.validateCoordinatePair(state.latitude, state.longitude);

    const missingFields = this.getPublishMissingFields(state);

    if (missingFields.length > 0) {
      throw new BadRequestException(`Object cannot be published. Missing fields: ${missingFields.join(', ')}`);
    }
  }

  private validatePublishedObjectUpdate(currentState: ObjectLifecycleState, nextState: ObjectLifecycleState) {
    this.validateCompletion(nextState.completionYear, nextState.completionQuarter);
    this.validateCoordinatePair(nextState.latitude, nextState.longitude);

    const currentMissingFields = this.getPublishMissingFields(currentState);
    const nextMissingFields = this.getPublishMissingFields(nextState);

    if (nextMissingFields.length === 0) {
      return;
    }

    const currentMissingFieldSet = new Set(currentMissingFields);
    const newlyMissingFields = nextMissingFields.filter((field) => !currentMissingFieldSet.has(field));

    if (currentMissingFields.length === 0 || newlyMissingFields.length > 0) {
      throw new BadRequestException(`Object cannot be published. Missing fields: ${nextMissingFields.join(', ')}`);
    }
  }

  private getPublishMissingFields(state: ObjectLifecycleState) {
    const missingFields = [];

    if (!state.title.trim()) {
      missingFields.push('title');
    }

    if (!state.slug.trim()) {
      missingFields.push('slug');
    }

    if (!state.developerId) {
      missingFields.push('developerId');
    }

    if (!state.primaryLocationId) {
      missingFields.push('primaryLocationId');
    }

    if (!state.address?.trim()) {
      missingFields.push('address');
    }

    if (!state.latitude || !state.longitude) {
      missingFields.push('coordinates');
    }

    return missingFields;
  }

  private validateCompletion(completionYear: number | null, completionQuarter: number | null) {
    if (completionQuarter !== null && completionYear === null) {
      throw new BadRequestException('Completion year is required when completion quarter is set');
    }
  }

  private validateCoordinatePair(latitude: string | null, longitude: string | null) {
    if ((latitude === null && longitude !== null) || (latitude !== null && longitude === null)) {
      throw new BadRequestException('Latitude and longitude must be set together');
    }
  }

  private parseRequiredString(value: unknown, message: string, maxLength: number) {
    if (typeof value !== 'string') {
      throw new BadRequestException(message);
    }

    const result = value.trim();

    if (!result) {
      throw new BadRequestException(message);
    }

    if (result.length > maxLength) {
      throw new BadRequestException(`${message.replace(' is required', '')} is too long`);
    }

    return result;
  }

  private parseNullableText(value: unknown, fieldName: string, maxLength: number) {
    if (value === undefined) {
      return undefined;
    }

    if (value === null) {
      return null;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException(`${fieldName} must be a string`);
    }

    const result = value.trim();

    if (!result) {
      return null;
    }

    if (result.length > maxLength) {
      throw new BadRequestException(`${fieldName} is too long`);
    }

    return result;
  }

  private parseNullableUrl(value: unknown, fieldName: string, maxLength: number) {
    const result = this.parseNullableText(value, fieldName, maxLength);

    if (!result) {
      return result;
    }

    let parsedUrl: URL;

    try {
      parsedUrl = new URL(result);
    } catch {
      throw new BadRequestException(`${fieldName} is invalid`);
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new BadRequestException(`${fieldName} must start with http:// or https://`);
    }

    return parsedUrl.toString();
  }

  private parseNullableInteger(value: unknown, fieldName: string, min: number, max: number) {
    if (value === undefined) {
      return undefined;
    }

    if (value === null || value === '') {
      return null;
    }

    if (typeof value !== 'number' && typeof value !== 'string') {
      throw new BadRequestException(`${fieldName} is invalid`);
    }

    return this.parseInteger(String(value), `${fieldName} is invalid`, min, max);
  }

  private parseInteger(value: string, message: string, min: number, max: number) {
    const normalizedValue = value.trim();
    const parsed = Number(normalizedValue);

    if (!/^\d+$/.test(normalizedValue) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new BadRequestException(message);
    }

    return parsed;
  }

  private parseNullableDecimal(value: unknown, fieldName: string, precision: number, scale: number) {
    if (value === undefined) {
      return undefined;
    }

    if (value === null || value === '') {
      return null;
    }

    if (typeof value !== 'number' && typeof value !== 'string') {
      throw new BadRequestException(`${fieldName} is invalid`);
    }

    const normalizedValue = String(value).trim().replace(/\s+/g, '').replace(',', '.');

    if (!/^\d+(\.\d+)?$/.test(normalizedValue)) {
      throw new BadRequestException(`${fieldName} is invalid`);
    }

    this.validateDecimalShape(normalizedValue, fieldName, precision, scale);

    return this.trimDecimal(normalizedValue);
  }

  private parseNullableCoordinate(value: unknown, fieldName: string, min: number, max: number) {
    if (value === undefined) {
      return undefined;
    }

    if (value === null || value === '') {
      return null;
    }

    if (typeof value !== 'number' && typeof value !== 'string') {
      throw new BadRequestException(`${fieldName} is invalid`);
    }

    const normalizedValue = String(value).trim().replace(/\s+/g, '').replace(',', '.');

    if (!/^-?\d+(\.\d+)?$/.test(normalizedValue)) {
      throw new BadRequestException(`${fieldName} is invalid`);
    }

    const parsed = Number(normalizedValue);
    const fraction = normalizedValue.split('.')[1] ?? '';

    if (!Number.isFinite(parsed) || parsed < min || parsed > max || fraction.length > 6) {
      throw new BadRequestException(`${fieldName} is invalid`);
    }

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

  private createFeedFallbackPriceFilter(
    manualField: 'priceFrom',
    feedField: 'feedPriceFrom',
    min: string | null | undefined,
    max: string | null | undefined,
  ): Prisma.RealEstateObjectWhereInput {
    const rangeFilter = {
      ...(min ? { gte: min } : {}),
      ...(max ? { lte: max } : {}),
    };

    return {
      OR: [
        {
          [feedField]: {
            not: null,
            ...rangeFilter,
          },
        },
        {
          [feedField]: null,
          [manualField]: rangeFilter,
        },
      ],
    };
  }

  private createObjectLotWhere(query: {
    priceMin?: string;
    priceMax?: string;
    rooms?: string;
    floorMin?: string;
    floorMax?: string;
  }): Prisma.FeedUnitWhereInput | null {
    const priceMin = this.parseNullableDecimal(query.priceMin, 'Lot price min', 14, 2);
    const priceMax = this.parseNullableDecimal(query.priceMax, 'Lot price max', 14, 2);
    const rooms = this.parseOptionalIntegerList(query.rooms, 'Lot rooms is invalid', 0, 5);
    const floorMin = this.parseOptionalInteger(query.floorMin, 'Lot floor min is invalid', 1, 300);
    const floorMax = this.parseOptionalInteger(query.floorMax, 'Lot floor max is invalid', 1, 300);

    if (priceMin === null || priceMax === null) {
      throw new BadRequestException('Lot price filters are invalid');
    }

    if (priceMin !== undefined && priceMax !== undefined && Number(priceMin) > Number(priceMax)) {
      throw new BadRequestException('Lot price min cannot be greater than max');
    }

    if (floorMin !== undefined && floorMax !== undefined && floorMin > floorMax) {
      throw new BadRequestException('Lot floor min cannot be greater than max');
    }

    const lotWhere: Prisma.FeedUnitWhereInput = {
      ...(priceMin !== undefined || priceMax !== undefined
        ? {
            effectivePrice: {
              ...(priceMin !== undefined ? { gte: priceMin } : {}),
              ...(priceMax !== undefined ? { lte: priceMax } : {}),
            },
          }
        : {}),
      ...(rooms !== undefined ? this.createFeedUnitRoomsFilter(rooms) : {}),
      ...(floorMin !== undefined || floorMax !== undefined
        ? {
            floor: {
              ...(floorMin !== undefined ? { gte: floorMin } : {}),
              ...(floorMax !== undefined ? { lte: floorMax } : {}),
            },
          }
        : {}),
    };

    return Object.keys(lotWhere).length > 0 ? lotWhere : null;
  }

  private async countMatchedFeedUnitsByObjectId(
    objectIds: string[],
    lotWhere: Prisma.FeedUnitWhereInput | null,
  ): Promise<Map<string, number>> {
    if (!lotWhere || objectIds.length === 0) {
      return new Map();
    }

    const rows = await this.prisma.feedUnit.groupBy({
      by: ['objectId'],
      where: {
        objectId: {
          in: objectIds,
        },
        ...lotWhere,
      },
      _count: {
        _all: true,
      },
    });

    return new Map(rows.map((row) => [row.objectId, row._count._all]));
  }

  private createFeedUnitRoomsFilter(rooms: number | number[]): Prisma.FeedUnitWhereInput {
    const roomValues = Array.isArray(rooms) ? rooms : [rooms];
    const hasStudio = roomValues.includes(0);
    const directRoomValues = roomValues.filter((room) => room !== 0);
    const filters: Prisma.FeedUnitWhereInput[] = [];

    if (directRoomValues.length === 1) {
      filters.push({
        rooms: directRoomValues[0],
      });
    } else if (directRoomValues.length > 1) {
      filters.push({
        rooms: {
          in: directRoomValues,
        },
      });
    }

    if (hasStudio) {
      filters.push(
        {
          rooms: 0,
        },
        this.createAuraSeparateRoomsStudioFilter(),
      );
    }

    return filters.length === 1 ? filters[0]! : { OR: filters };
  }

  private createAuraSeparateRoomsStudioFilter(): Prisma.FeedUnitWhereInput {
    return {
      rooms: null,
      residentialDetails: {
        is: {
          layoutType: {
            equals: 'раздельные',
            mode: 'insensitive',
          },
        },
      },
      object: {
        OR: [
          {
            title: {
              contains: 'аура',
              mode: 'insensitive',
            },
          },
          {
            developer: {
              is: {
                name: {
                  contains: 'мангазея',
                  mode: 'insensitive',
                },
              },
            },
          },
        ],
      },
    };
  }

  private createFeedUnitDecimalRangeFilter(
    field: 'effectivePrice' | 'effectivePricePerMeter' | 'area',
    minValue: string | undefined,
    maxValue: string | undefined,
    fieldName: string,
    precision: number,
    scale: number,
  ): Prisma.FeedUnitWhereInput | null {
    const min = this.parseNullableDecimal(minValue, `${fieldName} min`, precision, scale);
    const max = this.parseNullableDecimal(maxValue, `${fieldName} max`, precision, scale);

    if (min === null || max === null) {
      throw new BadRequestException(`${fieldName} filters are invalid`);
    }

    if (min !== undefined && max !== undefined && Number(min) > Number(max)) {
      throw new BadRequestException(`${fieldName} min cannot be greater than max`);
    }

    return min !== undefined || max !== undefined
      ? ({
          [field]: {
            ...(min !== undefined ? { gte: min } : {}),
            ...(max !== undefined ? { lte: max } : {}),
          },
        } as Prisma.FeedUnitWhereInput)
      : null;
  }

  private parseOptionalInteger(value: string | undefined, message: string, min: number, max: number) {
    if (value === undefined || value.trim() === '') {
      return undefined;
    }

    return this.parseInteger(value, message, min, max);
  }

  private parseOptionalIntegerList(value: string | undefined, message: string, min: number, max: number) {
    if (value === undefined || value.trim() === '') {
      return undefined;
    }

    const parsedValues = value.split(',').map((item) => {
      const normalizedItem = item.trim();

      if (!normalizedItem) {
        throw new BadRequestException(message);
      }

      return this.parseInteger(normalizedItem, message, min, max);
    });

    return [...new Set(parsedValues)];
  }

  private parseNullableUuidField(value: unknown, message: string) {
    if (value === undefined) {
      return undefined;
    }

    if (value === null) {
      return null;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException(message);
    }

    const normalizedValue = value.trim();

    if (!normalizedValue) {
      return null;
    }

    return this.parseUuid(normalizedValue, message);
  }

  private parseUuidArray(value: unknown, message: string) {
    if (value === undefined) {
      return undefined;
    }

    if (!Array.isArray(value)) {
      throw new BadRequestException(message);
    }

    return this.unique(
      value.map((item) => {
        if (typeof item !== 'string') {
          throw new BadRequestException(message);
        }

        return this.parseUuid(item.trim(), message);
      }),
    );
  }

  private parseUuidList(value: unknown, message: string) {
    if (value === undefined) {
      return undefined;
    }

    if (!Array.isArray(value)) {
      throw new BadRequestException(message);
    }

    return value.map((item) => {
      if (typeof item !== 'string') {
        throw new BadRequestException(message);
      }

      return this.parseUuid(item.trim(), message);
    });
  }

  private parseUuid(value: string, message: string) {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (!uuidPattern.test(value)) {
      throw new BadRequestException(message);
    }

    return value;
  }

  private parseImageSections(value: unknown, imageIds: string[]) {
    if (value === undefined) {
      return undefined;
    }

    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('Gallery image sections are invalid');
    }

    const parsedSections: Record<string, ObjectImageSection | null> = {};

    for (const [rawImageId, rawSection] of Object.entries(value)) {
      const imageId = this.parseUuid(rawImageId, 'Gallery image section is invalid');

      if (rawSection === null) {
        parsedSections[imageId] = null;
        continue;
      }

      if (
        typeof rawSection !== 'string' ||
        !Object.values(ObjectImageSection).includes(rawSection as ObjectImageSection)
      ) {
        throw new BadRequestException('Gallery image section is invalid');
      }

      parsedSections[imageId] = rawSection as ObjectImageSection;
    }

    if (!this.sameStringSet(imageIds, Object.keys(parsedSections))) {
      throw new BadRequestException('Gallery image section ids must match gallery image ids');
    }

    return parsedSections;
  }

  private parseGalleryBatchLayout(value: unknown, fileCount: number): GalleryBatchLayout {
    if (value === undefined) {
      throw new BadRequestException('Gallery batch layout is required');
    }

    const rawLayout = this.parseJsonObject(value, 'Gallery batch layout is invalid');
    const rawItems = rawLayout.items;

    if (!Array.isArray(rawItems)) {
      throw new BadRequestException('Gallery batch items are invalid');
    }

    const coverIndex = this.parseGalleryBatchCoverIndex(rawLayout.coverIndex, rawItems.length);
    const usedImageIds = new Set<string>();
    const usedFileIndexes = new Set<number>();
    const usedStagedFileIds = new Set<string>();
    const items = rawItems.map((rawItem) => {
      if (rawItem === null || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
        throw new BadRequestException('Gallery batch item is invalid');
      }

      const item = rawItem as Record<string, unknown>;
      const section = this.parseGalleryBatchSection(item.section);

      if (item.kind === 'existing') {
        if (typeof item.imageId !== 'string') {
          throw new BadRequestException('Gallery image is invalid');
        }

        const imageId = this.parseUuid(item.imageId.trim(), 'Gallery image is invalid');

        if (usedImageIds.has(imageId)) {
          throw new BadRequestException('Gallery image ids must be unique');
        }

        usedImageIds.add(imageId);

        return {
          kind: 'existing',
          imageId,
          section,
        } as const;
      }

      if (item.kind === 'new') {
        const fileIndex = this.parseGalleryBatchFileIndex(item.fileIndex, fileCount);

        if (usedFileIndexes.has(fileIndex)) {
          throw new BadRequestException('Gallery batch file indexes must be unique');
        }

        usedFileIndexes.add(fileIndex);

        return {
          kind: 'new',
          fileIndex,
          section,
        } as const;
      }

      if (item.kind === 'staged') {
        if (typeof item.fileId !== 'string') {
          throw new BadRequestException('Gallery staged file is invalid');
        }

        const fileId = this.parseUuid(item.fileId.trim(), 'Gallery staged file is invalid');

        if (usedStagedFileIds.has(fileId)) {
          throw new BadRequestException('Gallery staged file ids must be unique');
        }

        usedStagedFileIds.add(fileId);

        return {
          kind: 'staged',
          fileId,
          section,
        } as const;
      }

      throw new BadRequestException('Gallery batch item kind is invalid');
    });

    if (items.length > 0 && coverIndex === null) {
      throw new BadRequestException('Cover image is required');
    }

    if (usedFileIndexes.size !== fileCount) {
      throw new BadRequestException('Gallery batch files must match new gallery items');
    }

    for (let fileIndex = 0; fileIndex < fileCount; fileIndex += 1) {
      if (!usedFileIndexes.has(fileIndex)) {
        throw new BadRequestException('Gallery batch files must match new gallery items');
      }
    }

    return {
      items,
      coverIndex,
    };
  }

  private parseJsonObject(value: unknown, message: string) {
    const parsedValue = typeof value === 'string' ? this.parseJson(value, message) : value;

    if (parsedValue === null || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) {
      throw new BadRequestException(message);
    }

    return parsedValue as Record<string, unknown>;
  }

  private parseJson(value: string, message: string) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new BadRequestException(message);
    }
  }

  private parseGalleryBatchCoverIndex(value: unknown, itemCount: number) {
    if (value === null && itemCount === 0) {
      return null;
    }

    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= itemCount) {
      throw new BadRequestException('Cover image is invalid');
    }

    return value;
  }

  private parseGalleryBatchFileIndex(value: unknown, fileCount: number) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= fileCount) {
      throw new BadRequestException('Gallery batch file is invalid');
    }

    return value;
  }

  private parseGalleryBatchSection(value: unknown) {
    if (value === undefined || value === null || value === '') {
      return null;
    }

    if (
      typeof value !== 'string' ||
      !Object.values(ObjectImageSection).includes(value as ObjectImageSection)
    ) {
      throw new BadRequestException('Gallery image section is invalid');
    }

    return value as ObjectImageSection;
  }

  private createUploadedFileStream(request: GalleryStreamUploadRequest): UploadedFileStream {
    return {
      stream: request,
      originalname: this.getHeaderValue(request.headers['x-file-name']) ?? 'image',
      mimetype: this.getHeaderValue(request.headers['content-type']) ?? 'application/octet-stream',
      size: this.parseOptionalContentLength(request.headers['content-length']),
    };
  }

  private getHeaderValue(value: string | string[] | undefined) {
    const headerValue = Array.isArray(value) ? value[0] : value;

    if (!headerValue) {
      return null;
    }

    try {
      return decodeURIComponent(headerValue);
    } catch {
      return headerValue;
    }
  }

  private parseOptionalContentLength(value: string | string[] | undefined) {
    const headerValue = this.getHeaderValue(value);

    if (!headerValue) {
      return undefined;
    }

    const contentLength = Number(headerValue);

    return Number.isInteger(contentLength) && contentLength >= 0 ? contentLength : undefined;
  }

  private createImageSectionMap(images: ObjectDetailRecord['images']) {
    return images.reduce<Record<string, ObjectImageSection | null>>((sectionMap, image) => {
      sectionMap[image.id] = image.section;

      return sectionMap;
    }, {});
  }

  private parseObjectStatus(value: unknown) {
    if (typeof value !== 'string') {
      throw new BadRequestException('Object status is required');
    }

    const normalizedStatus = value.trim().toUpperCase();

    if (!Object.values(ObjectStatus).includes(normalizedStatus as ObjectStatus)) {
      throw new BadRequestException('Object status is invalid');
    }

    return normalizedStatus as ObjectStatus;
  }

  private parseQuickEditStatus(value: unknown) {
    const status = this.parseObjectStatus(value);

    if (status !== ObjectStatus.PUBLISHED && status !== ObjectStatus.ARCHIVED) {
      throw new BadRequestException('Status must be PUBLISHED or ARCHIVED');
    }

    return status;
  }

  private parseFeedUnitStatus(value: string) {
    const normalizedStatus = value.trim().toUpperCase();

    if (!Object.values(FeedUnitStatus).includes(normalizedStatus as FeedUnitStatus)) {
      throw new BadRequestException('Feed unit status is invalid');
    }

    return normalizedStatus as FeedUnitStatus;
  }

  private parseFeedUnitStatuses(value: string): FeedUnitStatus[] {
    const statuses = value
      .split(',')
      .map((status) => status.trim())
      .filter(Boolean)
      .map((status) => this.parseFeedUnitStatus(status));

    if (statuses.length === 0) {
      throw new BadRequestException('Feed unit status is invalid');
    }

    return [...new Set(statuses)];
  }

  private parseFeedUnitType(value: string) {
    const normalizedType = value.trim().toUpperCase();

    if (!Object.values(FeedUnitType).includes(normalizedType as FeedUnitType)) {
      throw new BadRequestException('Feed unit type is invalid');
    }

    return normalizedType as FeedUnitType;
  }

  private parseObjectListOrderBy(sortBy: string | undefined, sortDirection: string | undefined) {
    const direction = this.parseSortDirection(sortDirection);
    const normalizedSortBy = sortBy?.trim() || 'createdAt';
    const sortableFields = new Set([
      'title',
      'status',
      'priceFrom',
      'pricePerMeterFrom',
      'completionDate',
      'completionYear',
      'createdAt',
      'updatedAt',
    ]);

    if (!sortableFields.has(normalizedSortBy)) {
      return [
        {
          createdAt: 'desc',
        },
      ] satisfies Prisma.RealEstateObjectOrderByWithRelationInput[];
    }

    if (normalizedSortBy === 'createdAt') {
      return [
        {
          createdAt: direction,
        },
      ] satisfies Prisma.RealEstateObjectOrderByWithRelationInput[];
    }

    if (normalizedSortBy === 'priceFrom' || normalizedSortBy === 'pricePerMeterFrom') {
      const feedSortBy = normalizedSortBy === 'priceFrom' ? 'feedPriceFrom' : 'feedPricePerMeterFrom';

      return [
        {
          [feedSortBy]: {
            sort: direction,
            nulls: 'last',
          },
        },
        {
          [normalizedSortBy]: {
            sort: direction,
            nulls: 'last',
          },
        },
        {
          createdAt: 'desc',
        },
      ] satisfies Prisma.RealEstateObjectOrderByWithRelationInput[];
    }

    if (normalizedSortBy === 'completionDate' || normalizedSortBy === 'completionYear') {
      return [
        {
          completionYear: {
            sort: direction,
            nulls: 'last',
          },
        },
        {
          completionQuarter: {
            sort: direction,
            nulls: 'last',
          },
        },
        {
          createdAt: 'desc',
        },
      ] satisfies Prisma.RealEstateObjectOrderByWithRelationInput[];
    }

    return [
      {
        [normalizedSortBy]: direction,
      },
      {
        createdAt: 'desc',
      },
    ] satisfies Prisma.RealEstateObjectOrderByWithRelationInput[];
  }

  private parseFeedUnitOrderBy(sortBy: string | undefined, sortDirection: string | undefined) {
    const direction = this.parseSortDirection(sortDirection);
    const normalizedSortBy = sortBy?.trim() || '';

    if (!normalizedSortBy) {
      return [
        {
          status: 'asc',
        },
        {
          effectivePrice: {
            sort: 'asc',
            nulls: 'last',
          },
        },
        {
          createdAt: 'desc',
        },
      ] satisfies Prisma.FeedUnitOrderByWithRelationInput[];
    }

    if (normalizedSortBy === 'status') {
      return [
        {
          status: direction,
        },
        {
          createdAt: 'desc',
        },
      ] satisfies Prisma.FeedUnitOrderByWithRelationInput[];
    }

    if (normalizedSortBy === 'title') {
      return [
        {
          title: {
            sort: direction,
            nulls: 'last',
          },
        },
        {
          externalId: direction,
        },
        {
          createdAt: 'desc',
        },
      ] satisfies Prisma.FeedUnitOrderByWithRelationInput[];
    }

    if (normalizedSortBy === 'building') {
      return [
        {
          building: {
            sort: direction,
            nulls: 'last',
          },
        },
        {
          section: {
            sort: direction,
            nulls: 'last',
          },
        },
        {
          createdAt: 'desc',
        },
      ] satisfies Prisma.FeedUnitOrderByWithRelationInput[];
    }

    if (normalizedSortBy === 'rooms') {
      return [
        {
          rooms: {
            sort: direction,
            nulls: 'last',
          },
        },
        {
          type: direction,
        },
        {
          createdAt: 'desc',
        },
      ] satisfies Prisma.FeedUnitOrderByWithRelationInput[];
    }

    if (
      normalizedSortBy === 'price' ||
      normalizedSortBy === 'pricePerMeter' ||
      normalizedSortBy === 'area' ||
      normalizedSortBy === 'floor'
    ) {
      const sortField =
        normalizedSortBy === 'price'
          ? 'effectivePrice'
          : normalizedSortBy === 'pricePerMeter'
            ? 'effectivePricePerMeter'
            : normalizedSortBy;

      return [
        {
          [sortField]: {
            sort: direction,
            nulls: 'last',
          },
        },
        {
          createdAt: 'desc',
        },
      ] satisfies Prisma.FeedUnitOrderByWithRelationInput[];
    }

    return [
      {
        status: 'asc',
      },
      {
        effectivePrice: {
          sort: 'asc',
          nulls: 'last',
        },
      },
      {
        createdAt: 'desc',
      },
    ] satisfies Prisma.FeedUnitOrderByWithRelationInput[];
  }

  private parseSortDirection(value: string | undefined): Prisma.SortOrder {
    if (!value) {
      return 'desc';
    }

    const normalizedDirection = value.trim().toLowerCase();

    if (normalizedDirection === 'asc' || normalizedDirection === 'desc') {
      return normalizedDirection;
    }

    return 'desc';
  }

  private parseObjectFileType(value: unknown) {
    if (typeof value !== 'string') {
      throw new BadRequestException('Object file type is required');
    }

    const normalizedType = value.trim().toUpperCase();

    if (!Object.values(ObjectFileType).includes(normalizedType as ObjectFileType)) {
      throw new BadRequestException('Object file type is invalid');
    }

    return normalizedType as ObjectFileType;
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

  private parseFeaturesJson(value: unknown) {
    if (value === undefined) {
      return undefined;
    }

    if (value === null) {
      return {};
    }

    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('Features JSON must be an object');
    }

    return value as Prisma.InputJsonObject;
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

  private normalizeObjectLocationIds(locationIds: string[], primaryLocationId: string | null | undefined) {
    const uniqueLocationIds = this.unique(locationIds);

    if (!primaryLocationId) {
      return uniqueLocationIds;
    }

    return [primaryLocationId, ...uniqueLocationIds.filter((locationId) => locationId !== primaryLocationId)];
  }

  private unique(values: string[]) {
    return values.filter((value, index) => values.indexOf(value) === index);
  }

  private sameStringArray(first: string[], second: string[]) {
    if (first.length !== second.length) {
      return false;
    }

    return first.every((value, index) => value === second[index]);
  }

  private sameStringSet(first: string[], second: string[]) {
    if (first.length !== second.length) {
      return false;
    }

    const secondSet = new Set(second);

    return first.every((value) => secondSet.has(value));
  }

  private serializeFeedUnit(unit: ObjectFeedUnitRecord) {
    return {
      id: unit.id,
      sourceId: unit.sourceId,
      objectId: unit.objectId,
      externalId: unit.externalId,
      type: unit.type,
      status: unit.status,
      title: unit.title,
      address: unit.address,
      building: unit.building,
      section: unit.section,
      floor: unit.floor,
      rooms: unit.rooms,
      price: this.decimalToString(unit.price),
      discountPrice: this.decimalToString(unit.discountPrice),
      effectivePrice: this.decimalToString(unit.effectivePrice),
      currency: unit.currency,
      area: this.decimalToString(unit.area),
      pricePerMeter: this.decimalToString(unit.pricePerMeter),
      discountPricePerMeter: this.decimalToString(unit.discountPricePerMeter),
      effectivePricePerMeter: this.decimalToString(unit.effectivePricePerMeter),
      completionYear: unit.completionYear,
      completionQuarter: unit.completionQuarter,
      rawPayload: unit.rawPayload ?? null,
      archivedAt: unit.archivedAt?.toISOString() ?? null,
      residentialDetails: unit.residentialDetails
        ? {
            unitId: unit.residentialDetails.unitId,
            apartmentNumber: unit.residentialDetails.apartmentNumber,
            layoutType: unit.residentialDetails.layoutType,
            livingArea: this.decimalToString(unit.residentialDetails.livingArea),
            kitchenArea: this.decimalToString(unit.residentialDetails.kitchenArea),
            balconyCount: unit.residentialDetails.balconyCount,
            detailsJson: unit.residentialDetails.detailsJson,
          }
        : null,
      commercialDetails: unit.commercialDetails
        ? {
            unitId: unit.commercialDetails.unitId,
            commercialType: unit.commercialDetails.commercialType,
            entrance: unit.commercialDetails.entrance,
            ceilingHeight: this.decimalToString(unit.commercialDetails.ceilingHeight),
            powerKw: this.decimalToString(unit.commercialDetails.powerKw),
            separateEntrance: unit.commercialDetails.separateEntrance,
            detailsJson: unit.commercialDetails.detailsJson,
          }
        : null,
      media: unit.media.map((link) => ({
        id: link.mediaAsset.id,
        sourceUrl: link.mediaAsset.sourceUrl,
        file: link.mediaAsset.file ? this.serializeFeedFile(link.mediaAsset.file) : null,
        contentType: link.mediaAsset.contentType,
        checksum: link.mediaAsset.checksum,
        sortOrder: link.sortOrder,
        label: link.label,
        createdAt: link.mediaAsset.createdAt.toISOString(),
        updatedAt: link.mediaAsset.updatedAt.toISOString(),
      })),
      createdAt: unit.createdAt.toISOString(),
      updatedAt: unit.updatedAt.toISOString(),
    };
  }

  private serializeFeedFile(file: ObjectFeedMediaFileRecord) {
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

  private serializeObjectSummary(object: ObjectListRecord, matchedFeedUnitsCount: number | null = null) {
    const coverImage = object.images[0] ?? null;
    const presentationFile = object.files[0] ?? null;

    return {
      ...this.serializeObjectBase(object, matchedFeedUnitsCount),
      coverImage: coverImage ? this.serializeObjectImage(coverImage) : null,
      presentationFile: presentationFile ? this.serializeObjectFile(presentationFile) : null,
    };
  }

  private serializeObjectDetail(object: ObjectDetailRecord) {
    return {
      ...this.serializeObjectBase(object),
      images: object.images.map((image) => this.serializeObjectImage(image)),
      files: object.files.map((file) => this.serializeObjectFile(file)),
    };
  }

  private serializeObjectBase(object: ObjectListRecord | ObjectDetailRecord, matchedFeedUnitsCount: number | null = null) {
    return {
      id: object.id,
      wpPostId: object.wpPostId,
      title: object.title,
      slug: object.slug,
      status: object.status,
      description: object.description,
      architectureDescription: object.architectureDescription,
      infrastructureDescription: object.infrastructureDescription,
      fillingDescription: object.fillingDescription,
      shortDescription: object.shortDescription,
      mapName: object.mapName,
      layoutsUrl: object.layoutsUrl,
      krtName: object.krtName,
      apartmentAreaRange: object.apartmentAreaRange,
      ceilingHeight: object.ceilingHeight,
      propertyClass: object.propertyClass,
      floorRange: object.floorRange,
      apartmentsCountText: object.apartmentsCountText,
      priceFrom: this.decimalToString(object.priceFrom),
      pricePerMeterFrom: this.decimalToString(object.pricePerMeterFrom),
      feedPriceFrom: this.decimalToString(object.feedPriceFrom),
      feedPricePerMeterFrom: this.decimalToString(object.feedPricePerMeterFrom),
      feedAreaRange: object.feedAreaRange,
      feedFloorRange: object.feedFloorRange,
      feedUnitsCount: object.feedUnitsCount,
      feedUnitsCountText: object.feedUnitsCountText,
      matchedFeedUnitsCount,
      feedCompletionYear: object.feedCompletionYear,
      feedCompletionQuarter: object.feedCompletionQuarter,
      feedUpdatedAt: object.feedUpdatedAt?.toISOString() ?? null,
      completionYear: object.completionYear,
      completionQuarter: object.completionQuarter,
      address: object.address,
      latitude: this.decimalToNumber(object.latitude),
      longitude: this.decimalToNumber(object.longitude),
      featuresJson: object.featuresJson,
      developer: object.developer
        ? {
            id: object.developer.id,
            wpTermId: object.developer.wpTermId,
            name: object.developer.name,
            slug: object.developer.slug,
          }
        : null,
      primaryLocation: object.primaryLocation ? this.serializeLocation(object.primaryLocation) : null,
      locations: object.locations.map((link) => ({
        ...this.serializeLocation(link.location),
        isPrimary: link.isPrimary,
        sortOrder: link.sortOrder,
      })),
      metroStations: object.metroStations.map((link) => ({
        ...this.serializeMetroStation(link.metroStation),
        sortOrder: link.sortOrder,
      })),
      publishedAt: object.publishedAt?.toISOString() ?? null,
      createdAt: object.createdAt.toISOString(),
      updatedAt: object.updatedAt.toISOString(),
      deletedAt: object.deletedAt?.toISOString() ?? null,
    };
  }

  private serializeLocation(location: ObjectDetailRecord['primaryLocation']) {
    if (!location) {
      return null;
    }

    return {
      id: location.id,
      wpTermId: location.wpTermId,
      name: location.name,
      slug: location.slug,
      type: location.type,
      parentId: location.parentId,
    };
  }

  private serializeMetroStation(station: ObjectDetailRecord['metroStations'][number]['metroStation']) {
    return {
      id: station.id,
      wpTermId: station.wpTermId,
      name: station.name,
      slug: station.slug,
      lineName: station.lineName,
      lineColor: station.lineColor,
    };
  }

  private serializeObjectImage(image: ObjectDetailRecord['images'][number]) {
    return {
      id: image.id,
      file: this.serializeFile(image.file),
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

  private serializeObjectFile(file: ObjectDetailRecord['files'][number]) {
    return {
      id: file.id,
      file: this.serializeFile(file.file),
      type: file.type,
      title: file.title,
      sortOrder: file.sortOrder,
      sourceMetaKey: file.sourceMetaKey,
      createdAt: file.createdAt.toISOString(),
      updatedAt: file.updatedAt.toISOString(),
    };
  }

  private serializeFile(file: ObjectDetailRecord['files'][number]['file']) {
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

  private decimalToString(value: Prisma.Decimal | null) {
    return value?.toString() ?? null;
  }

  private decimalToNumber(value: Prisma.Decimal | null) {
    return value?.toNumber() ?? null;
  }

  private toAuditSnapshot(object: ObjectDetailRecord): Prisma.InputJsonObject {
    return {
      id: object.id,
      wpPostId: object.wpPostId,
      title: object.title,
      slug: object.slug,
      status: object.status,
      description: object.description,
      architectureDescription: object.architectureDescription,
      infrastructureDescription: object.infrastructureDescription,
      fillingDescription: object.fillingDescription,
      shortDescription: object.shortDescription,
      mapName: object.mapName,
      layoutsUrl: object.layoutsUrl,
      krtName: object.krtName,
      apartmentAreaRange: object.apartmentAreaRange,
      ceilingHeight: object.ceilingHeight,
      propertyClass: object.propertyClass,
      floorRange: object.floorRange,
      apartmentsCountText: object.apartmentsCountText,
      priceFrom: this.decimalToString(object.priceFrom),
      pricePerMeterFrom: this.decimalToString(object.pricePerMeterFrom),
      completionYear: object.completionYear,
      completionQuarter: object.completionQuarter,
      address: object.address,
      latitude: this.decimalToString(object.latitude),
      longitude: this.decimalToString(object.longitude),
      featuresJson: object.featuresJson as Prisma.InputJsonValue,
      developerId: object.developerId,
      primaryLocationId: object.primaryLocationId,
      locationIds: object.locations.map((link) => link.locationId),
      metroStationIds: object.metroStations.map((link) => link.metroStationId),
      publishedAt: object.publishedAt?.toISOString() ?? null,
      deletedAt: object.deletedAt?.toISOString() ?? null,
    };
  }

  private change(from: string | null, to: string | null): Prisma.InputJsonObject {
    return { from, to };
  }

  private changeNumber(from: number | null, to: number | null): Prisma.InputJsonObject {
    return { from, to };
  }

  private changeArray(from: string[], to: string[]): Prisma.InputJsonObject {
    return { from, to };
  }

  private async logObjectAction(params: {
    action: string;
    actor: AuthenticatedUser;
    request: RequestWithAudit;
    objectId: string;
    metadata: Prisma.InputJsonObject;
  }) {
    await this.prisma.auditLog.create({
      data: {
        actorUserId: params.actor.id,
        action: params.action,
        entityType: 'object',
        entityId: params.objectId,
        objectId: params.objectId,
        metadata: params.metadata,
        ipAddress: this.getRequestIp(params.request),
        userAgent: this.getHeader(params.request, 'user-agent'),
      },
    });
  }

  private getRequestIp(request: RequestWithAudit) {
    const forwardedFor = this.getHeader(request, 'x-forwarded-for');

    return forwardedFor?.split(',')[0]?.trim() || request.ip || request.socket?.remoteAddress || null;
  }

  private getHeader(request: RequestWithAudit, name: string) {
    const value = request.headers[name];

    return Array.isArray(value) ? value[0] : value;
  }
}
