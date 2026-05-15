import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { LocationType, ObjectFileType, ObjectImageSection, ObjectStatus, Prisma } from '@prisma/client';

import { AuthenticatedUser, RequestWithAuth } from '../auth/auth.types';
import { FilesService } from '../files/files.service';
import { UploadedFile } from '../files/uploaded-file.type';
import { PrismaService } from '../prisma/prisma.service';

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

type ObjectListRecord = Prisma.RealEstateObjectGetPayload<{ include: typeof objectListInclude }>;
type ObjectDetailRecord = Prisma.RealEstateObjectGetPayload<{ include: typeof objectDetailInclude }>;
type ObjectClient = PrismaService | Prisma.TransactionClient;

type RequestWithAudit = RequestWithAuth & {
  ip?: string;
  socket?: {
    remoteAddress?: string;
  };
};

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
  completionYear?: string;
  completionQuarter?: string;
  priceFromMin?: string;
  priceFromMax?: string;
  hasCoordinates?: string;
  hasPresentation?: string;
};

type CreateObjectBody = {
  title?: unknown;
  status?: unknown;
  description?: unknown;
  architectureDescription?: unknown;
  infrastructureDescription?: unknown;
  fillingDescription?: unknown;
  shortDescription?: unknown;
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

type SortGalleryBody = {
  imageIds?: unknown;
};

type GalleryLayoutBody = {
  imageIds?: unknown;
  coverImageId?: unknown;
  imageSections?: unknown;
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
      filters.push({
        OR: [
          {
            title: {
              contains: search,
              mode: 'insensitive',
            },
          },
          {
            slug: {
              contains: search,
              mode: 'insensitive',
            },
          },
          {
            address: {
              contains: search,
              mode: 'insensitive',
            },
          },
          {
            description: {
              contains: search,
              mode: 'insensitive',
            },
          },
          {
            shortDescription: {
              contains: search,
              mode: 'insensitive',
            },
          },
          {
            developer: {
              is: {
                name: {
                  contains: search,
                  mode: 'insensitive',
                },
              },
            },
          },
          {
            primaryLocation: {
              is: {
                name: {
                  contains: search,
                  mode: 'insensitive',
                },
              },
            },
          },
        ],
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

    return {
      items: items.map((object) => this.serializeObjectSummary(object)),
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
    const object = await this.findExistingObject(id);

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

    if (object.status === ObjectStatus.PUBLISHED) {
      return {
        object: this.serializeObjectDetail(object),
      };
    }

    const publishedObject = await this.prisma.realEstateObject.update({
      where: {
        id: object.id,
      },
      data: {
        status: ObjectStatus.PUBLISHED,
        publishedAt: object.publishedAt ?? new Date(),
      },
      include: objectDetailInclude,
    });

    await this.logObjectAction({
      action: 'object.publish',
      actor,
      request,
      objectId: publishedObject.id,
      metadata: {
        before: this.toAuditSnapshot(object),
        after: this.toAuditSnapshot(publishedObject),
      },
    });

    return {
      object: this.serializeObjectDetail(publishedObject),
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
    const uploadedFile = await this.filesService.uploadFile(file, actor, 'pdf');

    try {
      const updatedObject = await this.prisma.$transaction(async (tx) => {
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
      return [
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

  private serializeObjectSummary(object: ObjectListRecord) {
    const coverImage = object.images[0] ?? null;
    const presentationFile = object.files[0] ?? null;

    return {
      ...this.serializeObjectBase(object),
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

  private serializeObjectBase(object: ObjectListRecord | ObjectDetailRecord) {
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
