import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import {
  File,
  FileVariantKind,
  FileStorage,
  ImportMode,
  ImportStatus,
  Location,
  MetroStation,
  ObjectStatus,
  Prisma,
  PrismaClient,
  type RealEstateObject,
} from '@prisma/client';

import { loadDeveloperAliases, normalizeDeveloperName } from './developer-aliases';
import { ImportConfig, loadImportConfig } from './env';
import {
  GeneratedImageVariant,
  IMAGE_VARIANT_ORDER,
  generateImageVariants,
  isImageVariantSourceMimeType,
} from './image-variants';
import { mapWordPressSource, slugify } from './mapper';
import { ImportStorage } from './storage';
import {
  ImportIssue,
  ImportModeName,
  MappedFile,
  MappedImage,
  MappedImport,
  MappedLocation,
  MappedMetroStation,
  MappedObject,
  WpAttachment,
} from './types';
import { WordPressReadonlyClient } from './wordpress-client';

type ImportCounters = {
  objectsImported: number;
  objectsCreated: number;
  objectsUpdated: number;
  objectsArchived: number;
  objectsFailed: number;
};

type ImportContext = {
  prisma: PrismaClient;
  storage: ImportStorage;
  warnings: ImportIssue[];
  errors: ImportIssue[];
  counters: ImportCounters;
};

type FileRecord = Pick<File, 'id' | 'wpAttachmentId' | 'key' | 'mimeType'> & {
  variants: Array<{
    variant: FileVariantKind;
  }>;
};
type ManualObjectOverrideField =
  | 'title'
  | 'description'
  | 'architectureDescription'
  | 'infrastructureDescription'
  | 'fillingDescription'
  | 'shortDescription'
  | 'priceFrom'
  | 'pricePerMeterFrom'
  | 'completionYear'
  | 'completionQuarter'
  | 'address'
  | 'latitude'
  | 'longitude'
  | 'featuresJson'
  | 'developerId'
  | 'primaryLocationId'
  | 'locationIds'
  | 'metroStationIds';

type ManualObjectOverrides = {
  fields: Set<ManualObjectOverrideField>;
  values: Partial<Record<ManualObjectOverrideField, unknown>>;
};

type ExistingObjectForImport = Pick<
  RealEstateObject,
  | 'wpPostId'
  | 'title'
  | 'slug'
  | 'status'
  | 'description'
  | 'architectureDescription'
  | 'infrastructureDescription'
  | 'fillingDescription'
  | 'shortDescription'
  | 'priceFrom'
  | 'pricePerMeterFrom'
  | 'completionYear'
  | 'completionQuarter'
  | 'address'
  | 'latitude'
  | 'longitude'
  | 'featuresJson'
  | 'developerId'
  | 'primaryLocationId'
  | 'publishedAt'
>;

const manualObjectOverrideFields = new Set<ManualObjectOverrideField>([
  'title',
  'description',
  'architectureDescription',
  'infrastructureDescription',
  'fillingDescription',
  'shortDescription',
  'priceFrom',
  'pricePerMeterFrom',
  'completionYear',
  'completionQuarter',
  'address',
  'latitude',
  'longitude',
  'featuresJson',
  'developerId',
  'primaryLocationId',
  'locationIds',
  'metroStationIds',
]);

export async function executeWordPressImport(mode: ImportModeName) {
  const config = loadImportConfig();
  const prisma = new PrismaClient();
  const report = await createPendingReport(prisma, mode);
  const startedAt = new Date();
  let wpClient: WordPressReadonlyClient | null = null;

  try {
    const developerAliases = await loadDeveloperAliases();
    wpClient = new WordPressReadonlyClient(config.wp);
    const source = await wpClient.fetchSourceData();
    const mapped = mapWordPressSource(
      source,
      config.wp.postType,
      mode === 'preview',
      developerAliases,
      config.wp.profile,
    );
    const counters: ImportCounters = {
      objectsImported: 0,
      objectsCreated: 0,
      objectsUpdated: 0,
      objectsArchived: 0,
      objectsFailed: 0,
    };

    if (mode === 'run') {
      const context: ImportContext = {
        prisma,
        storage: new ImportStorage(config.s3),
        warnings: mapped.warnings,
        errors: mapped.errors,
        counters,
      };

      await persistMappedImport(mapped, config, context);

      if (config.wp.importLimit === null) {
        await archiveImportedObjectsMissingFromSource(mapped, context);
      }
    }

    const summary = {
      ...mapped.summary,
      ...counters,
      warningsCount: mapped.warnings.length,
      errorsCount: mapped.errors.length,
      durationMs: Date.now() - startedAt.getTime(),
    };
    const status = resolveReportStatus(mapped.errors, counters);

    await finishReport(prisma, report?.id ?? null, status, summary, mapped.warnings, mapped.errors);

    return {
      mode,
      status,
      summary,
      warnings: mapped.warnings,
      errors: mapped.errors,
      reportId: report?.id ?? null,
    };
  } catch (error) {
    const importError = toImportIssue(error);

    await finishReport(
      prisma,
      report?.id ?? null,
      ImportStatus.FAILED,
      {
        source: 'wordpress',
        profile: config.wp.profileName,
        objectType: config.wp.objectType,
        postType: config.wp.postType,
        dryRun: mode === 'preview',
        durationMs: Date.now() - startedAt.getTime(),
      },
      [],
      [importError],
    );

    throw error;
  } finally {
    await wpClient?.close().catch(() => undefined);
    await prisma.$disconnect();
  }
}

async function persistMappedImport(mapped: MappedImport, config: ImportConfig, context: ImportContext) {
  for (const object of mapped.objects) {
    try {
      const persistedObject = await context.prisma.$transaction(async (tx) => {
        const developerId = object.developer
          ? (await ensureDeveloper(tx, object.developer.name, object.developer.slug)).id
          : null;
        const locationByWpTermId = await ensureLocations(tx, object.locations);
        const metroByWpTermId = await ensureMetroStations(tx, object.metroStations);
        const primaryLocationId = object.primaryLocation
          ? locationByWpTermId.get(object.primaryLocation.wpTermId)?.id ?? null
          : null;
        const { objectRecord, manualOverrideFields } = await upsertObject(
          tx,
          object,
          developerId,
          primaryLocationId,
          context,
        );

        if (!shouldPreserveManualLocationLinks(manualOverrideFields)) {
          await replaceLocationLinks(tx, objectRecord.id, object.locations, locationByWpTermId, primaryLocationId);
        }

        if (!manualOverrideFields.has('metroStationIds')) {
          await replaceMetroStationLinks(tx, objectRecord.id, object.metroStations, metroByWpTermId);
        }

        return objectRecord;
      });

      await persistObjectMedia(context, config, persistedObject.id, object);
      context.counters.objectsImported += 1;
    } catch (error) {
      context.counters.objectsFailed += 1;
      context.errors.push({
        severity: 'error',
        code: 'object_import_failed',
        message: error instanceof Error ? error.message : 'Object import failed',
        wpPostId: object.wpPostId,
      });
    }
  }
}

async function archiveImportedObjectsMissingFromSource(mapped: MappedImport, context: ImportContext) {
  const sourceWpPostIds = mapped.objects.map((object) => object.wpPostId);

  if (sourceWpPostIds.length === 0) {
    return;
  }

  const archived = await context.prisma.realEstateObject.updateMany({
    where: {
      deletedAt: null,
      type: mapped.objectType,
      status: {
        not: ObjectStatus.ARCHIVED,
      },
      AND: [
        {
          wpPostId: {
            not: null,
          },
        },
        {
          wpPostId: {
            notIn: sourceWpPostIds,
          },
        },
      ],
    },
    data: {
      status: ObjectStatus.ARCHIVED,
      publishedAt: null,
    },
  });

  context.counters.objectsArchived += archived.count;
}

async function ensureDeveloper(tx: Prisma.TransactionClient, name: string, slug: string) {
  const normalizedName = normalizeDeveloperName(name);
  const existingDeveloper =
    (await findDeveloperByNormalizedName(tx, normalizedName)) ??
    (await tx.developer.findUnique({
      where: {
        name,
      },
    }));

  if (existingDeveloper) {
    const hasUnresolvedNameConflict = await hasDeveloperNormalizedNameConflict(
      tx,
      normalizedName,
      existingDeveloper.id,
    );

    return tx.developer.update({
      where: {
        id: existingDeveloper.id,
      },
      data: {
        slug: existingDeveloper.slug ?? (await getUniqueDeveloperSlug(tx, slug, existingDeveloper.id)),
        normalizedName: hasUnresolvedNameConflict ? existingDeveloper.normalizedName : normalizedName,
      },
    });
  }

  return tx.developer.create({
    data: {
      name,
      normalizedName,
      slug: await getUniqueDeveloperSlug(tx, slug, null),
    },
  });
}

async function findDeveloperByNormalizedName(tx: Prisma.TransactionClient, normalizedName: string) {
  if (!normalizedName) {
    return null;
  }

  return tx.developer.findUnique({
    where: {
      normalizedName,
    },
  });
}

async function hasDeveloperNormalizedNameConflict(
  tx: Prisma.TransactionClient,
  normalizedName: string,
  currentDeveloperId: string,
) {
  if (!normalizedName) {
    return false;
  }

  const matches = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "developers"
    WHERE lower(regexp_replace(btrim("name"), '\\s+', ' ', 'g')) = ${normalizedName}
      AND "id" <> ${currentDeveloperId}::uuid
    LIMIT 1
  `;

  return matches.length > 0;
}

async function getUniqueDeveloperSlug(tx: Prisma.TransactionClient, slug: string, currentId: string | null) {
  let candidate = slug;
  let index = 2;

  while (true) {
    const existingDeveloper = await tx.developer.findUnique({
      where: {
        slug: candidate,
      },
      select: {
        id: true,
      },
    });

    if (!existingDeveloper || existingDeveloper.id === currentId) {
      return candidate;
    }

    candidate = `${slug}-${index}`;
    index += 1;
  }
}

async function ensureLocations(tx: Prisma.TransactionClient, locations: MappedLocation[]) {
  const locationByWpTermId = new Map<number, Location>();

  for (const location of locations) {
    const existingLocation = await tx.location.findFirst({
      where: {
        OR: [
          {
            wpTermId: location.wpTermId,
          },
          {
            type: location.type,
            slug: location.slug,
          },
        ],
      },
    });

    const parentId = location.parentWpTermId
      ? locationByWpTermId.get(location.parentWpTermId)?.id ?? null
      : null;

    if (existingLocation) {
      const updatedLocation = await tx.location.update({
        where: {
          id: existingLocation.id,
        },
        data: {
          wpTermId: existingLocation.wpTermId ?? location.wpTermId,
          name: location.name,
          slug: location.slug,
          type: location.type,
          parentId,
        },
      });
      locationByWpTermId.set(location.wpTermId, updatedLocation);
      continue;
    }

    const createdLocation = await tx.location.create({
      data: {
        wpTermId: location.wpTermId,
        name: location.name,
        slug: location.slug,
        type: location.type,
        parentId,
      },
    });
    locationByWpTermId.set(location.wpTermId, createdLocation);
  }

  return locationByWpTermId;
}

async function ensureMetroStations(tx: Prisma.TransactionClient, metroStations: MappedMetroStation[]) {
  const stationByWpTermId = new Map<number, MetroStation>();

  for (const station of metroStations) {
    const existingStation = await tx.metroStation.findFirst({
      where: {
        OR: [
          {
            wpTermId: station.wpTermId,
          },
          {
            lineName: station.lineName,
            slug: station.slug,
          },
        ],
      },
    });

    if (existingStation) {
      const updatedStation = await tx.metroStation.update({
        where: {
          id: existingStation.id,
        },
        data: {
          wpTermId: existingStation.wpTermId ?? station.wpTermId,
          name: station.name,
          slug: station.slug,
          lineName: station.lineName,
          lineColor: station.lineColor,
        },
      });
      stationByWpTermId.set(station.wpTermId, updatedStation);
      continue;
    }

    const createdStation = await tx.metroStation.create({
      data: {
        wpTermId: station.wpTermId,
        name: station.name,
        slug: station.slug,
        lineName: station.lineName,
        lineColor: station.lineColor,
      },
    });
    stationByWpTermId.set(station.wpTermId, createdStation);
  }

  return stationByWpTermId;
}

async function upsertObject(
  tx: Prisma.TransactionClient,
  object: MappedObject,
  developerId: string | null,
  primaryLocationId: string | null,
  context: ImportContext,
) {
  const existingByWpPostId = await tx.realEstateObject.findUnique({
    where: {
      wpPostId: object.wpPostId,
    },
  });
  const existingBySlug = await tx.realEstateObject.findUnique({
    where: {
      slug: object.slug,
    },
  });
  let existingObject = existingByWpPostId ?? null;
  let slug = object.slug;

  if (!existingObject && existingBySlug) {
    if (existingBySlug.type === object.type && (!existingBySlug.wpPostId || existingBySlug.wpPostId === object.wpPostId)) {
      existingObject = existingBySlug;
    } else {
      slug = await getUniqueObjectSlug(tx, object.slug, object.wpPostId);
      context.warnings.push({
        severity: 'warning',
        code: 'object_slug_conflict',
        message: `Object slug was changed to ${slug} because the original slug is already linked to another WP post`,
        wpPostId: object.wpPostId,
      });
    }
  }

  if (existingObject && existingBySlug && existingBySlug.id !== existingObject.id) {
    slug = existingObject.slug;
    context.warnings.push({
      severity: 'warning',
      code: 'object_slug_conflict',
      message: `Existing imported object kept slug ${slug} because the new slug is already used`,
      wpPostId: object.wpPostId,
    });
  }

  const manualOverrides = existingObject
    ? await loadManualObjectOverrides(tx, existingObject.id)
    : createEmptyManualObjectOverrides();
  const data = resolveImportedObjectData({
    object,
    slug,
    existingObject,
    developerId,
    primaryLocationId,
    manualOverrideFields: manualOverrides.fields,
    manualOverrideValues: manualOverrides.values,
  });

  if (existingObject) {
    context.counters.objectsUpdated += 1;

    const objectRecord = await tx.realEstateObject.update({
      where: {
        id: existingObject.id,
      },
      data,
    });

    return {
      objectRecord,
      manualOverrideFields: manualOverrides.fields,
    };
  }

  context.counters.objectsCreated += 1;

  const objectRecord = await tx.realEstateObject.create({
    data,
  });

  return {
    objectRecord,
    manualOverrideFields: manualOverrides.fields,
  };
}

async function loadManualObjectOverrides(tx: Prisma.TransactionClient, objectId: string) {
  const logs = await tx.auditLog.findMany({
    where: {
      action: 'object.update',
      entityType: 'object',
      OR: [
        {
          entityId: objectId,
        },
        {
          objectId,
        },
      ],
    },
    select: {
      metadata: true,
    },
    orderBy: {
      createdAt: 'asc',
    },
  });

  return collectManualObjectOverrides(logs.map((log) => log.metadata));
}

export function collectManualObjectOverrideFields(metadataItems: Array<unknown>) {
  return collectManualObjectOverrides(metadataItems).fields;
}

export function collectManualObjectOverrides(metadataItems: Array<unknown>) {
  const overrides: ManualObjectOverrides = createEmptyManualObjectOverrides();

  for (const metadata of metadataItems) {
    if (!isRecord(metadata) || !isRecord(metadata.changes)) {
      continue;
    }

    for (const field of Object.keys(metadata.changes)) {
      if (manualObjectOverrideFields.has(field as ManualObjectOverrideField)) {
        const overrideField = field as ManualObjectOverrideField;
        const change = metadata.changes[field];

        overrides.fields.add(overrideField);

        if (isRecord(change) && Object.prototype.hasOwnProperty.call(change, 'to')) {
          overrides.values[overrideField] = change.to;
        }
      }
    }
  }

  return overrides;
}

export function resolveImportedObjectData(params: {
  object: MappedObject;
  slug: string;
  existingObject: ExistingObjectForImport | null;
  developerId: string | null;
  primaryLocationId: string | null;
  manualOverrideFields: Set<ManualObjectOverrideField>;
  manualOverrideValues?: Partial<Record<ManualObjectOverrideField, unknown>>;
}) {
  const {
    object,
    slug,
    existingObject,
    developerId,
    primaryLocationId,
    manualOverrideFields,
    manualOverrideValues = {},
  } = params;
  const data: Prisma.RealEstateObjectUncheckedCreateInput = {
    wpPostId: object.wpPostId,
    type: object.type,
    title: object.title,
    slug,
    status: object.status,
    description: object.description,
    architectureDescription: object.architectureDescription,
    infrastructureDescription: object.infrastructureDescription,
    fillingDescription: object.fillingDescription,
    shortDescription: object.shortDescription,
    priceFrom: object.priceFrom,
    pricePerMeterFrom: object.pricePerMeterFrom,
    completionYear: object.completionYear,
    completionQuarter: object.completionQuarter,
    address: object.address,
    latitude: object.latitude,
    longitude: object.longitude,
    featuresJson: object.featuresJson,
    developerId,
    primaryLocationId,
    publishedAt: object.status === 'PUBLISHED' ? object.publishedAt ?? existingObject?.publishedAt ?? new Date() : null,
  };

  if (!existingObject || manualOverrideFields.size === 0) {
    return data;
  }

  applyManualObjectOverrides(data, existingObject, manualOverrideFields, manualOverrideValues);

  return data;
}

function applyManualObjectOverrides(
  data: Prisma.RealEstateObjectUncheckedCreateInput,
  existingObject: ExistingObjectForImport,
  manualOverrideFields: Set<ManualObjectOverrideField>,
  manualOverrideValues: Partial<Record<ManualObjectOverrideField, unknown>>,
) {
  if (manualOverrideFields.has('title')) {
    data.title = getManualOverrideValue(manualOverrideValues, 'title', existingObject.title);
  }

  if (manualOverrideFields.has('description')) {
    data.description = getManualOverrideValue(manualOverrideValues, 'description', existingObject.description);
  }

  if (manualOverrideFields.has('architectureDescription')) {
    data.architectureDescription = getManualOverrideValue(
      manualOverrideValues,
      'architectureDescription',
      existingObject.architectureDescription,
    );
  }

  if (manualOverrideFields.has('infrastructureDescription')) {
    data.infrastructureDescription = getManualOverrideValue(
      manualOverrideValues,
      'infrastructureDescription',
      existingObject.infrastructureDescription,
    );
  }

  if (manualOverrideFields.has('fillingDescription')) {
    data.fillingDescription = getManualOverrideValue(
      manualOverrideValues,
      'fillingDescription',
      existingObject.fillingDescription,
    );
  }

  if (manualOverrideFields.has('shortDescription')) {
    data.shortDescription = getManualOverrideValue(manualOverrideValues, 'shortDescription', existingObject.shortDescription);
  }

  if (manualOverrideFields.has('priceFrom')) {
    data.priceFrom = getManualOverrideValue(manualOverrideValues, 'priceFrom', existingObject.priceFrom);
  }

  if (manualOverrideFields.has('pricePerMeterFrom')) {
    data.pricePerMeterFrom = getManualOverrideValue(
      manualOverrideValues,
      'pricePerMeterFrom',
      existingObject.pricePerMeterFrom,
    );
  }

  if (manualOverrideFields.has('completionYear')) {
    data.completionYear = getManualOverrideValue(manualOverrideValues, 'completionYear', existingObject.completionYear);
  }

  if (manualOverrideFields.has('completionQuarter')) {
    data.completionQuarter = getManualOverrideValue(
      manualOverrideValues,
      'completionQuarter',
      existingObject.completionQuarter,
    );
  }

  if (manualOverrideFields.has('address')) {
    data.address = getManualOverrideValue(manualOverrideValues, 'address', existingObject.address);
  }

  if (manualOverrideFields.has('latitude')) {
    data.latitude = getManualOverrideValue(manualOverrideValues, 'latitude', existingObject.latitude);
  }

  if (manualOverrideFields.has('longitude')) {
    data.longitude = getManualOverrideValue(manualOverrideValues, 'longitude', existingObject.longitude);
  }

  if (manualOverrideFields.has('featuresJson')) {
    data.featuresJson = getManualOverrideValue(
      manualOverrideValues,
      'featuresJson',
      existingObject.featuresJson,
    ) as Prisma.InputJsonValue;
  }

  if (manualOverrideFields.has('developerId')) {
    data.developerId = getManualOverrideValue(manualOverrideValues, 'developerId', existingObject.developerId);
  }

  if (manualOverrideFields.has('primaryLocationId')) {
    data.primaryLocationId = getManualOverrideValue(
      manualOverrideValues,
      'primaryLocationId',
      existingObject.primaryLocationId,
    );
  }
}

function getManualOverrideValue<T>(
  manualOverrideValues: Partial<Record<ManualObjectOverrideField, unknown>>,
  field: ManualObjectOverrideField,
  fallback: T,
) {
  if (!Object.prototype.hasOwnProperty.call(manualOverrideValues, field)) {
    return fallback;
  }

  return manualOverrideValues[field] as T;
}

function shouldPreserveManualLocationLinks(manualOverrideFields: Set<ManualObjectOverrideField>) {
  return manualOverrideFields.has('primaryLocationId') || manualOverrideFields.has('locationIds');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createEmptyManualObjectOverrides(): ManualObjectOverrides {
  return {
    fields: new Set<ManualObjectOverrideField>(),
    values: {},
  };
}

async function getUniqueObjectSlug(tx: Prisma.TransactionClient, slug: string, wpPostId: number) {
  let candidate = `${slug}-${wpPostId}`;
  let index = 2;

  while (await tx.realEstateObject.findUnique({ where: { slug: candidate }, select: { id: true } })) {
    candidate = `${slug}-${wpPostId}-${index}`;
    index += 1;
  }

  return candidate;
}

async function replaceLocationLinks(
  tx: Prisma.TransactionClient,
  objectId: string,
  locations: MappedLocation[],
  locationByWpTermId: Map<number, Location>,
  primaryLocationId: string | null,
) {
  await tx.objectLocation.deleteMany({
    where: {
      objectId,
    },
  });

  const locationIds = locations
    .map((location) => locationByWpTermId.get(location.wpTermId)?.id)
    .filter(Boolean) as string[];

  if (locationIds.length === 0) {
    return;
  }

  await tx.objectLocation.createMany({
    data: locationIds.map((locationId, index) => ({
      objectId,
      locationId,
      isPrimary: locationId === primaryLocationId,
      sortOrder: index,
    })),
  });
}

async function replaceMetroStationLinks(
  tx: Prisma.TransactionClient,
  objectId: string,
  metroStations: MappedMetroStation[],
  stationByWpTermId: Map<number, MetroStation>,
) {
  await tx.objectMetroStation.deleteMany({
    where: {
      objectId,
    },
  });

  const stationIds = metroStations
    .map((station) => stationByWpTermId.get(station.wpTermId)?.id)
    .filter(Boolean) as string[];

  if (stationIds.length === 0) {
    return;
  }

  await tx.objectMetroStation.createMany({
    data: stationIds.map((metroStationId, index) => ({
      objectId,
      metroStationId,
      sortOrder: index,
    })),
  });
}

async function persistObjectMedia(
  context: ImportContext,
  config: ImportConfig,
  objectId: string,
  object: MappedObject,
) {
  const importedImageFileIds: string[] = [];
  const importedObjectFileIds: string[] = [];

  if (object.images.some((image) => image.isCover)) {
    await context.prisma.objectImage.updateMany({
      where: {
        objectId,
      },
      data: {
        isCover: false,
      },
    });
  }

  for (const image of object.images) {
    const file = await ensureImportedFile(context, config, image.attachment);
    importedImageFileIds.push(file.id);

    await upsertObjectImage(context.prisma, objectId, image, file.id);
  }

  for (const fileRef of object.files) {
    const file = await ensureImportedFile(context, config, fileRef.attachment);

    await upsertObjectFile(context.prisma, objectId, fileRef, file.id);

    const objectFile = await context.prisma.objectFile.findUnique({
      where: {
        objectId_fileId_type: {
          objectId,
          fileId: file.id,
          type: fileRef.type,
        },
      },
      select: {
        id: true,
      },
    });

    if (objectFile) {
      importedObjectFileIds.push(objectFile.id);
    }
  }

  await context.prisma.objectImage.deleteMany({
    where: {
      objectId,
      sourceMetaKey: {
        not: null,
      },
      ...(importedImageFileIds.length > 0
        ? {
            fileId: {
              notIn: importedImageFileIds,
            },
          }
        : {}),
    },
  });

  await context.prisma.objectFile.deleteMany({
    where: {
      objectId,
      sourceMetaKey: {
        not: null,
      },
      ...(importedObjectFileIds.length > 0
        ? {
            id: {
              notIn: importedObjectFileIds,
            },
          }
        : {}),
    },
  });
}

async function ensureImportedFile(
  context: ImportContext,
  config: ImportConfig,
  attachment: WpAttachment,
) {
  const existingFile = await context.prisma.file.findUnique({
    where: {
      wpAttachmentId: attachment.ID,
    },
    select: {
      id: true,
      wpAttachmentId: true,
      key: true,
      mimeType: true,
      variants: {
        select: {
          variant: true,
        },
      },
    },
  });

  if (existingFile) {
    await ensureImportedFileVariants(context, existingFile, attachment);

    return existingFile;
  }

  if (!attachment.localPath || !attachment.mimeType) {
    throw new Error(`Attachment ${attachment.ID} cannot be imported without local path or MIME type`);
  }

  const body = await readFile(attachment.localPath);
  const key = getAttachmentStorageKey(attachment);
  const checksum = createHash('sha256').update(body).digest('hex');
  const variants = isImageVariantSourceMimeType(attachment.mimeType)
    ? await generateImageVariants(body, key)
    : [];

  await context.storage.putObject({
    key,
    body,
    contentType: attachment.mimeType,
  });

  const file = await context.prisma.file.upsert({
    where: {
      wpAttachmentId: attachment.ID,
    },
    update: {
      storage: FileStorage.MINIO,
      bucket: config.s3.bucket,
      key,
      url: context.storage.getPublicUrl(key),
      originalName: getAttachmentOriginalName(attachment),
      mimeType: attachment.mimeType,
      sizeBytes: BigInt(body.length),
      checksum,
    },
    create: {
      wpAttachmentId: attachment.ID,
      storage: FileStorage.MINIO,
      bucket: config.s3.bucket,
      key,
      url: context.storage.getPublicUrl(key),
      originalName: getAttachmentOriginalName(attachment),
      mimeType: attachment.mimeType,
      sizeBytes: BigInt(body.length),
      checksum,
    },
    select: {
      id: true,
      wpAttachmentId: true,
      key: true,
      mimeType: true,
      variants: {
        select: {
          variant: true,
        },
      },
    },
  });

  await upsertFileVariants(context, file.id, variants);

  return file;
}

async function ensureImportedFileVariants(
  context: ImportContext,
  existingFile: FileRecord,
  attachment: WpAttachment,
) {
  if (!isImageVariantSourceMimeType(existingFile.mimeType ?? attachment.mimeType)) {
    return;
  }

  const existingVariantKinds = new Set(existingFile.variants.map((variant) => variant.variant));
  const missingVariantKinds = new Set(
    IMAGE_VARIANT_ORDER.filter((variant) => !existingVariantKinds.has(variant)),
  );

  if (missingVariantKinds.size === 0) {
    return;
  }

  if (!attachment.localPath || !attachment.mimeType) {
    throw new Error(`Attachment ${attachment.ID} cannot backfill image variants without local path or MIME type`);
  }

  const body = await readFile(attachment.localPath);
  const variants = (await generateImageVariants(body, existingFile.key)).filter((variant) =>
    missingVariantKinds.has(variant.variant),
  );

  await upsertFileVariants(context, existingFile.id, variants);
}

async function upsertFileVariants(
  context: ImportContext,
  fileId: string,
  variants: GeneratedImageVariant[],
) {
  for (const variant of variants) {
    await context.storage.putObject({
      key: variant.key,
      body: variant.body,
      contentType: variant.mimeType,
    });

    await context.prisma.fileVariant.upsert({
      where: {
        fileId_variant: {
          fileId,
          variant: variant.variant,
        },
      },
      update: {
        storage: FileStorage.MINIO,
        bucket: context.storage.getBucket(),
        key: variant.key,
        url: context.storage.getPublicUrl(variant.key),
        mimeType: variant.mimeType,
        width: variant.width,
        height: variant.height,
        sizeBytes: variant.sizeBytes,
        checksum: variant.checksum,
      },
      create: {
        fileId,
        variant: variant.variant,
        storage: FileStorage.MINIO,
        bucket: context.storage.getBucket(),
        key: variant.key,
        url: context.storage.getPublicUrl(variant.key),
        mimeType: variant.mimeType,
        width: variant.width,
        height: variant.height,
        sizeBytes: variant.sizeBytes,
        checksum: variant.checksum,
      },
    });
  }
}

async function upsertObjectImage(
  prisma: PrismaClient,
  objectId: string,
  image: MappedImage,
  fileId: string,
) {
  await prisma.objectImage.upsert({
    where: {
      objectId_fileId: {
        objectId,
        fileId,
      },
    },
    update: {
      sortOrder: image.sortOrder,
      isCover: image.isCover,
      alt: image.alt,
      title: image.title,
      sourceMetaKey: image.sourceMetaKey,
    },
    create: {
      objectId,
      fileId,
      sortOrder: image.sortOrder,
      isCover: image.isCover,
      alt: image.alt,
      title: image.title,
      sourceMetaKey: image.sourceMetaKey,
    },
  });
}

async function upsertObjectFile(
  prisma: PrismaClient,
  objectId: string,
  file: MappedFile,
  fileId: string,
) {
  await prisma.objectFile.upsert({
    where: {
      objectId_fileId_type: {
        objectId,
        fileId,
        type: file.type,
      },
    },
    update: {
      title: file.title,
      sortOrder: file.sortOrder,
      sourceMetaKey: file.sourceMetaKey,
    },
    create: {
      objectId,
      fileId,
      type: file.type,
      title: file.title,
      sortOrder: file.sortOrder,
      sourceMetaKey: file.sourceMetaKey,
    },
  });
}

async function createPendingReport(prisma: PrismaClient, mode: ImportModeName) {
  return prisma.importReport.create({
    data: {
      mode: mode === 'preview' ? ImportMode.PREVIEW : ImportMode.RUN,
      status: ImportStatus.PENDING,
      source: 'wordpress',
    },
    select: {
      id: true,
    },
  });
}

async function finishReport(
  prisma: PrismaClient,
  reportId: string | null,
  status: ImportStatus,
  summary: Record<string, unknown>,
  warnings: ImportIssue[],
  errors: ImportIssue[],
) {
  if (!reportId) {
    return;
  }

  await prisma.importReport.update({
    where: {
      id: reportId,
    },
    data: {
      status,
      finishedAt: new Date(),
      summaryJson: summary as Prisma.InputJsonObject,
      warningsJson: warnings as unknown as Prisma.InputJsonArray,
      errorsJson: errors as unknown as Prisma.InputJsonArray,
    },
  });
}

function resolveReportStatus(errors: ImportIssue[], counters: ImportCounters) {
  if (counters.objectsFailed > 0 || errors.length > 0) {
    return counters.objectsImported > 0 ? ImportStatus.PARTIAL : ImportStatus.FAILED;
  }

  return ImportStatus.SUCCESS;
}

function getAttachmentStorageKey(attachment: WpAttachment) {
  return `wordpress/${attachment.ID}/${getAttachmentOriginalName(attachment)}`;
}

function getAttachmentOriginalName(attachment: WpAttachment) {
  if (attachment.attachedFile) {
    return sanitizeFilename(basename(attachment.attachedFile));
  }

  const extension = getExtensionByMimeType(attachment.mimeType);

  return `${slugify(attachment.post_title ?? `attachment-${attachment.ID}`)}${extension}`;
}

function sanitizeFilename(value: string) {
  const sanitized = value
    .trim()
    .replace(/\s+/gu, '-')
    .replace(/[^a-zA-Z0-9._-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-+|-+$/gu, '');

  return sanitized || 'file';
}

function getExtensionByMimeType(mimeType: string | null) {
  if (mimeType === 'application/pdf') {
    return '.pdf';
  }

  if (mimeType === 'image/jpeg') {
    return '.jpg';
  }

  if (mimeType === 'image/png') {
    return '.png';
  }

  if (mimeType === 'image/webp') {
    return '.webp';
  }

  return '';
}

function toImportIssue(error: unknown): ImportIssue {
  return {
    severity: 'error',
    code: 'import_failed',
    message: error instanceof Error ? error.message : 'WordPress import failed',
  };
}
