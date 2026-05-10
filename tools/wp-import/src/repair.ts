import { Prisma, PrismaClient } from '@prisma/client';

import { DeveloperAliases, loadDeveloperAliases, normalizeDeveloperName } from './developer-aliases';
import { loadEnvFiles } from './env';
import { slugify } from './mapper';

export type RepairModeName = 'preview' | 'run';

type LocationRepairCandidate = {
  objectId: string;
  wpPostId: number | null;
  title: string;
  currentLocationId: string;
  currentLocationName: string;
  currentLocationWpTermId: number | null;
  nextLocationId: string;
  nextLocationName: string;
  nextLocationWpTermId: number | null;
  nextSortOrder: number;
};

type DeveloperRecord = {
  id: string;
  name: string;
  normalizedName: string | null;
  slug: string | null;
  createdAt: Date;
  objectsCount: number;
};

type DeveloperRepairPlan = {
  canonicalName: string;
  normalizedName: string;
  target: DeveloperRecord | null;
  matchingDevelopers: DeveloperRecord[];
  duplicateDevelopers: DeveloperRecord[];
  objectsToMove: number;
  willRenameTarget: boolean;
  warnings: string[];
};

type RepairCounters = {
  objectsPrimaryLocationUpdated: number;
  objectLocationPrimaryFlagsUpdated: number;
  developerObjectsMoved: number;
  developersDeleted: number;
  developersRenamed: number;
  developersNormalized: number;
};

export async function executeRepair(mode: RepairModeName) {
  loadEnvFiles();

  const prisma = new PrismaClient();
  const startedAt = Date.now();

  try {
    const developerAliases = await loadDeveloperAliases();
    const [locationCandidates, developerPlans] = await Promise.all([
      findLocationRepairCandidates(prisma),
      buildDeveloperRepairPlans(prisma, developerAliases),
    ]);
    const counters: RepairCounters = {
      objectsPrimaryLocationUpdated: 0,
      objectLocationPrimaryFlagsUpdated: 0,
      developerObjectsMoved: 0,
      developersDeleted: 0,
      developersRenamed: 0,
      developersNormalized: 0,
    };

    if (mode === 'run') {
      await prisma.$transaction(async (tx) => {
        counters.objectsPrimaryLocationUpdated = await applyLocationRepairs(tx, locationCandidates);
        counters.objectLocationPrimaryFlagsUpdated = counters.objectsPrimaryLocationUpdated;

        const developerCounters = await applyDeveloperRepairs(tx, developerPlans);
        counters.developerObjectsMoved = developerCounters.developerObjectsMoved;
        counters.developersDeleted = developerCounters.developersDeleted;
        counters.developersRenamed = developerCounters.developersRenamed;
        counters.developersNormalized = developerCounters.developersNormalized;
      });
    }

    return {
      mode,
      dryRun: mode === 'preview',
      summary: {
        locationCandidates: locationCandidates.length,
        developerAliasGroups: developerAliases.groups.length,
        developerGroupsWithMatches: developerPlans.filter((plan) => plan.matchingDevelopers.length > 0).length,
        developerObjectsToMove: developerPlans.reduce((sum, plan) => sum + plan.objectsToMove, 0),
        developersToDelete: developerPlans.reduce((sum, plan) => sum + plan.duplicateDevelopers.length, 0),
        ...counters,
        durationMs: Date.now() - startedAt,
      },
      locationRepairs: locationCandidates.map(serializeLocationCandidate),
      developerRepairs: developerPlans.map(serializeDeveloperPlan),
    };
  } finally {
    await prisma.$disconnect();
  }
}

async function findLocationRepairCandidates(prisma: PrismaClient) {
  return prisma.$queryRaw<LocationRepairCandidate[]>`
    SELECT DISTINCT ON (o."id")
      o."id" AS "objectId",
      o."wp_post_id" AS "wpPostId",
      o."title" AS "title",
      current_location."id" AS "currentLocationId",
      current_location."name" AS "currentLocationName",
      current_location."wp_term_id" AS "currentLocationWpTermId",
      district_location."id" AS "nextLocationId",
      district_location."name" AS "nextLocationName",
      district_location."wp_term_id" AS "nextLocationWpTermId",
      ol."sort_order" AS "nextSortOrder"
    FROM "real_estate_objects" o
    INNER JOIN "locations" current_location
      ON current_location."id" = o."primary_location_id"
     AND current_location."type" = 'area'
    INNER JOIN "object_locations" ol
      ON ol."object_id" = o."id"
    INNER JOIN "locations" district_location
      ON district_location."id" = ol."location_id"
     AND district_location."type" = 'district'
    ORDER BY o."id", ol."sort_order" DESC, district_location."name" ASC
  `;
}

async function buildDeveloperRepairPlans(prisma: PrismaClient, developerAliases: DeveloperAliases) {
  const developers = await prisma.developer.findMany({
    select: {
      id: true,
      name: true,
      normalizedName: true,
      slug: true,
      createdAt: true,
      _count: {
        select: {
          objects: true,
        },
      },
    },
    orderBy: [
      {
        createdAt: 'asc',
      },
      {
        name: 'asc',
      },
    ],
  });
  const developerRecords = developers.map((developer) => ({
    id: developer.id,
    name: developer.name,
    normalizedName: developer.normalizedName,
    slug: developer.slug,
    createdAt: developer.createdAt,
    objectsCount: developer._count.objects,
  }));

  return developerAliases.groups.map((group) => {
    const canonicalName = group.canonicalName;
    const normalizedName = normalizeDeveloperName(canonicalName);
    const aliasNames = [canonicalName, ...group.aliases];
    const aliasKeys = new Set(aliasNames.map((name) => normalizeDeveloperName(name)).filter(Boolean));
    const matchingDevelopers = developerRecords.filter((developer) => {
      const developerNameKey = normalizeDeveloperName(developer.name);
      const developerNormalizedNameKey = developer.normalizedName ?? '';

      return aliasKeys.has(developerNameKey) || aliasKeys.has(developerNormalizedNameKey);
    });
    const target =
      matchingDevelopers.find((developer) => developer.name === canonicalName) ??
      matchingDevelopers.find((developer) => developer.normalizedName === normalizedName) ??
      matchingDevelopers[0] ??
      null;
    const duplicateDevelopers = target
      ? matchingDevelopers.filter((developer) => developer.id !== target.id)
      : [];
    const warnings: string[] = [];

    if (!target) {
      warnings.push(`No developers match alias group "${canonicalName}"`);
    }

    if (target && target.name !== canonicalName) {
      const nameConflict = developerRecords.find(
        (developer) => developer.id !== target.id && developer.name === canonicalName,
      );

      if (nameConflict) {
        warnings.push(`Cannot rename target to "${canonicalName}" because another developer already has this name`);
      }
    }

    return {
      canonicalName,
      normalizedName,
      target,
      matchingDevelopers,
      duplicateDevelopers,
      objectsToMove: duplicateDevelopers.reduce((sum, developer) => sum + developer.objectsCount, 0),
      willRenameTarget: Boolean(target && target.name !== canonicalName && warnings.length === 0),
      warnings,
    } satisfies DeveloperRepairPlan;
  });
}

async function applyLocationRepairs(
  tx: Prisma.TransactionClient,
  candidates: LocationRepairCandidate[],
) {
  let updated = 0;

  for (const candidate of candidates) {
    const objectUpdate = await tx.realEstateObject.updateMany({
      where: {
        id: candidate.objectId,
        primaryLocationId: candidate.currentLocationId,
      },
      data: {
        primaryLocationId: candidate.nextLocationId,
      },
    });

    if (objectUpdate.count === 0) {
      continue;
    }

    await tx.objectLocation.updateMany({
      where: {
        objectId: candidate.objectId,
      },
      data: {
        isPrimary: false,
      },
    });

    await tx.objectLocation.update({
      where: {
        objectId_locationId: {
          objectId: candidate.objectId,
          locationId: candidate.nextLocationId,
        },
      },
      data: {
        isPrimary: true,
      },
    });

    updated += 1;
  }

  return updated;
}

async function applyDeveloperRepairs(
  tx: Prisma.TransactionClient,
  plans: DeveloperRepairPlan[],
) {
  const counters = {
    developerObjectsMoved: 0,
    developersDeleted: 0,
    developersRenamed: 0,
    developersNormalized: 0,
  };

  for (const plan of plans) {
    if (!plan.target || plan.warnings.length > 0) {
      continue;
    }

    const target = plan.target;

    for (const duplicate of plan.duplicateDevelopers) {
      const movedObjects = await tx.realEstateObject.updateMany({
        where: {
          developerId: duplicate.id,
        },
        data: {
          developerId: target.id,
        },
      });
      counters.developerObjectsMoved += movedObjects.count;

      const remainingObjects = await tx.realEstateObject.count({
        where: {
          developerId: duplicate.id,
        },
      });

      if (remainingObjects === 0) {
        await tx.developer.delete({
          where: {
            id: duplicate.id,
          },
        });
        counters.developersDeleted += 1;
      }
    }

    const nextSlug = target.slug ?? (await getUniqueDeveloperSlug(tx, slugify(plan.canonicalName), target.id));
    const updatedTarget = await tx.developer.update({
      where: {
        id: target.id,
      },
      data: {
        name: plan.canonicalName,
        normalizedName: plan.normalizedName,
        slug: nextSlug,
      },
    });

    if (target.name !== updatedTarget.name) {
      counters.developersRenamed += 1;
    }

    if (target.normalizedName !== updatedTarget.normalizedName) {
      counters.developersNormalized += 1;
    }
  }

  return counters;
}

async function getUniqueDeveloperSlug(
  tx: Prisma.TransactionClient,
  slug: string,
  currentId: string,
) {
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

function serializeLocationCandidate(candidate: LocationRepairCandidate) {
  return {
    objectId: candidate.objectId,
    wpPostId: candidate.wpPostId,
    title: candidate.title,
    currentPrimaryLocation: {
      id: candidate.currentLocationId,
      name: candidate.currentLocationName,
      wpTermId: candidate.currentLocationWpTermId,
      type: 'AREA',
    },
    nextPrimaryLocation: {
      id: candidate.nextLocationId,
      name: candidate.nextLocationName,
      wpTermId: candidate.nextLocationWpTermId,
      type: 'DISTRICT',
      sortOrder: candidate.nextSortOrder,
    },
  };
}

function serializeDeveloperPlan(plan: DeveloperRepairPlan) {
  return {
    canonicalName: plan.canonicalName,
    normalizedName: plan.normalizedName,
    target: plan.target ? serializeDeveloper(plan.target) : null,
    matchingDevelopers: plan.matchingDevelopers.map(serializeDeveloper),
    duplicateDevelopers: plan.duplicateDevelopers.map(serializeDeveloper),
    objectsToMove: plan.objectsToMove,
    willRenameTarget: plan.willRenameTarget,
    warnings: plan.warnings,
  };
}

function serializeDeveloper(developer: DeveloperRecord) {
  return {
    id: developer.id,
    name: developer.name,
    normalizedName: developer.normalizedName,
    slug: developer.slug,
    objectsCount: developer.objectsCount,
  };
}
