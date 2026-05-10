import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import {
  File,
  FileStorage,
  ImportMode,
  ImportStatus,
  Location,
  MetroStation,
  Prisma,
  PrismaClient,
} from '@prisma/client';

import { loadDeveloperAliases, normalizeDeveloperName } from './developer-aliases';
import { ImportConfig, loadImportConfig } from './env';
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
  objectsFailed: number;
};

type ImportContext = {
  prisma: PrismaClient;
  storage: ImportStorage;
  warnings: ImportIssue[];
  errors: ImportIssue[];
  counters: ImportCounters;
};

type FileRecord = Pick<File, 'id' | 'wpAttachmentId' | 'key'>;

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
    const mapped = mapWordPressSource(source, config.wp.postType, mode === 'preview', developerAliases);
    const counters: ImportCounters = {
      objectsImported: 0,
      objectsCreated: 0,
      objectsUpdated: 0,
      objectsFailed: 0,
    };

    if (mode === 'run') {
      await persistMappedImport(mapped, config, {
        prisma,
        storage: new ImportStorage(config.s3),
        warnings: mapped.warnings,
        errors: mapped.errors,
        counters,
      });
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
        const objectRecord = await upsertObject(tx, object, developerId, primaryLocationId, context);

        await replaceLocationLinks(tx, objectRecord.id, object.locations, locationByWpTermId, primaryLocationId);
        await replaceMetroStationLinks(tx, objectRecord.id, object.metroStations, metroByWpTermId);

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
    if (!existingBySlug.wpPostId || existingBySlug.wpPostId === object.wpPostId) {
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

  const data = {
    wpPostId: object.wpPostId,
    title: object.title,
    slug,
    status: object.status,
    description: object.description,
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
  } satisfies Prisma.RealEstateObjectUncheckedCreateInput;

  if (existingObject) {
    context.counters.objectsUpdated += 1;

    return tx.realEstateObject.update({
      where: {
        id: existingObject.id,
      },
      data,
    });
  }

  context.counters.objectsCreated += 1;

  return tx.realEstateObject.create({
    data,
  });
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
    },
  });

  if (existingFile) {
    return existingFile;
  }

  if (!attachment.localPath || !attachment.mimeType) {
    throw new Error(`Attachment ${attachment.ID} cannot be imported without local path or MIME type`);
  }

  const body = await readFile(attachment.localPath);
  const key = getAttachmentStorageKey(attachment);
  const checksum = createHash('sha256').update(body).digest('hex');

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
    },
  });

  return file;
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
