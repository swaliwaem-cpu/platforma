const { createHash } = require('node:crypto');

const {
  PrismaClient,
  TrainingMaterialRevisionStatus,
  TrainingMaterialStatus,
} = require('@prisma/client');

const FIELD_LABELS = {
  title: 'Название',
  type: 'Тип объекта',
  description: 'Описание',
  architectureDescription: 'Архитектура',
  infrastructureDescription: 'Инфраструктура',
  fillingDescription: 'Отделка и наполнение',
  krtName: 'КРТ',
  apartmentAreaRange: 'Площади',
  ceilingHeight: 'Высота потолков',
  propertyClass: 'Класс',
  floorRange: 'Этажность',
  completion: 'Срок сдачи',
  address: 'Адрес',
  developer: 'Девелопер',
  locations: 'Районы',
  metroStations: 'Метро',
};

const prisma = new PrismaClient();

void exportFixture()
  .then((fixture) => process.stdout.write(JSON.stringify(fixture)))
  .catch(() => {
    process.stderr.write('OPENAI_LUNA_TERRA_FIXTURE_EXPORT_FAILED\n');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

async function exportFixture() {
  const trainingProjects = await prisma.trainingProject.findMany({
    where: { realEstateObjectId: { not: null } },
    select: {
      id: true,
      realEstateObjectId: true,
      realEstateObject: { select: { title: true } },
      materials: {
        where: { status: TrainingMaterialStatus.ACTIVE },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          type: true,
          revisions: {
            orderBy: { revisionNumber: 'desc' },
            take: 1,
            select: {
              id: true,
              status: true,
              contentHash: true,
              segmentsJson: true,
            },
          },
        },
      },
    },
  });
  const trainingCasesByObject = new Map();
  for (const item of trainingProjects.map(createTrainingCase).filter(Boolean)) {
    const current = trainingCasesByObject.get(item.objectId);
    if (!current || item.sourceChars > current.sourceChars) {
      trainingCasesByObject.set(item.objectId, item);
    }
  }
  const trainingCases = pickEvenly(
    [...trainingCasesByObject.values()].sort(compareCaseSize),
    3,
  );
  if (trainingCases.length !== 3) {
    throw new Error('OPENAI_LUNA_TERRA_FIXTURE_TRAINING_CASES_MISSING');
  }

  const excludedObjectIds = new Set(trainingCases.map((item) => item.objectId));
  const snapshotObjects = await prisma.realEstateObject.findMany({
    where: {
      status: 'PUBLISHED',
      deletedAt: null,
      id: { notIn: [...excludedObjectIds] },
    },
    select: {
      id: true,
      title: true,
      type: true,
      description: true,
      architectureDescription: true,
      infrastructureDescription: true,
      fillingDescription: true,
      krtName: true,
      apartmentAreaRange: true,
      ceilingHeight: true,
      propertyClass: true,
      floorRange: true,
      completionYear: true,
      completionQuarter: true,
      address: true,
      developer: { select: { name: true } },
      locations: {
        orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
        select: { location: { select: { name: true } } },
      },
      metroStations: {
        orderBy: { sortOrder: 'asc' },
        select: { metroStation: { select: { name: true, lineName: true } } },
      },
    },
  });
  const snapshotPopulation = snapshotObjects
    .map(createSnapshotCase)
    .filter((item) => item.segments.length >= 6)
    .sort(compareCaseSize);
  if (snapshotPopulation.length < 7) {
    throw new Error('OPENAI_LUNA_TERRA_FIXTURE_SNAPSHOT_CASES_MISSING');
  }

  const population = [...trainingCases, ...snapshotPopulation].sort(compareCaseSize);
  const firstTertileEnd = Math.ceil(population.length / 3);
  const secondTertileEnd = Math.ceil(population.length * 2 / 3);
  for (const [index, item] of population.entries()) {
    item.populationSize = index < firstTertileEnd
      ? 'small'
      : index < secondTertileEnd
        ? 'medium'
        : 'large';
  }
  const targets = { small: 3, medium: 3, large: 4 };
  const snapshotCases = [];
  for (const size of ['small', 'medium', 'large']) {
    const existing = trainingCases.filter((item) => item.populationSize === size).length;
    const needed = targets[size] - existing;
    if (needed < 0) throw new Error('OPENAI_LUNA_TERRA_FIXTURE_STRATA_INVALID');
    const candidates = snapshotPopulation.filter((item) => item.populationSize === size);
    snapshotCases.push(...pickEvenly(candidates, needed));
  }
  if (snapshotCases.length !== 7 || new Set(
    [...trainingCases, ...snapshotCases].map((item) => item.objectId),
  ).size !== 10) {
    throw new Error('OPENAI_LUNA_TERRA_FIXTURE_NOT_UNIQUE');
  }

  const selected = [...trainingCases, ...snapshotCases].sort(compareCaseSize);
  const objects = selected.map((item, caseIndex) => {
    return {
      objectTitle: item.objectTitle,
      profile: {
        size: item.populationSize,
        multipleDocuments: item.sources.length > 1,
        numericTechnicalFacts: item.sources.some((source) => source.segments.some((segment) =>
          /\d/u.test(segment.text),
        )),
        similarSections: hasSimilarSectionsAcrossSources(item.sources),
      },
      sources: item.sources.map((source, sourceIndex) => ({
        ...source,
        materialId: `case-${caseIndex + 1}-material-${sourceIndex + 1}`,
        revisionId: `case-${caseIndex + 1}-revision-${sourceIndex + 1}`,
        materialTitle: `Источник ${sourceIndex + 1}`,
      })),
    };
  });
  if (
    !objects.some((item) => item.profile.multipleDocuments) ||
    !objects.some((item) => item.profile.numericTechnicalFacts) ||
    !objects.some((item) => item.profile.similarSections)
  ) {
    throw new Error('OPENAI_LUNA_TERRA_FIXTURE_NOT_REPRESENTATIVE');
  }
  return { schemaVersion: 1, objects };
}

function createTrainingCase(project) {
  const sources = project.materials.flatMap((material) => {
    const revision = material.revisions[0];
    if (!revision || revision.status !== TrainingMaterialRevisionStatus.READY) return [];
    const segments = parseSegments(revision.segmentsJson);
    if (segments.length === 0) return [];
    return [{
      materialId: material.id,
      revisionId: revision.id,
      materialTitle: 'Источник',
      materialType: material.type,
      contentHash: revision.contentHash,
      segments,
    }];
  });
  if (!project.realEstateObjectId || !project.realEstateObject || sources.length === 0) {
    return null;
  }
  return {
    objectId: project.realEstateObjectId,
    objectTitle: project.realEstateObject.title,
    sources,
    sourceChars: countSourceChars(sources),
  };
}

function createSnapshotCase(object) {
  const values = {
    title: object.title,
    type: object.type,
    description: object.description,
    architectureDescription: object.architectureDescription,
    infrastructureDescription: object.infrastructureDescription,
    fillingDescription: object.fillingDescription,
    krtName: object.krtName,
    apartmentAreaRange: object.apartmentAreaRange,
    ceilingHeight: object.ceilingHeight,
    propertyClass: object.propertyClass,
    floorRange: object.floorRange,
    completion: object.completionYear
      ? `${object.completionQuarter ? `${object.completionQuarter} кв. ` : ''}${object.completionYear}`
      : null,
    address: object.address,
    developer: object.developer?.name ?? null,
    locations: object.locations.map((item) => item.location.name).join(', ') || null,
    metroStations: object.metroStations.map((item) => item.metroStation.lineName
      ? `${item.metroStation.name} (${item.metroStation.lineName})`
      : item.metroStation.name,
    ).join(', ') || null,
  };
  const segments = Object.entries(FIELD_LABELS).flatMap(([code, label]) => {
    const text = normalizeText(values[code] ?? '');
    return text ? [{ locator: `object-field:${code}`, label, text }] : [];
  });
  const contentHash = createHash('sha256')
    .update(segments.map((segment) => segment.text).join('\n\n'))
    .digest('hex');
  const sources = [{
    materialId: `snapshot-${object.id}`,
    revisionId: `snapshot-revision-${object.id}`,
    materialTitle: 'Карточка объекта',
    materialType: 'OBJECT_SNAPSHOT',
    contentHash,
    segments,
  }];
  return {
    objectId: object.id,
    objectTitle: object.title,
    sources,
    segments,
    sourceChars: countSourceChars(sources),
  };
}

function parseSegments(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((segment) =>
    segment &&
    typeof segment.locator === 'string' &&
    typeof segment.label === 'string' &&
    typeof segment.text === 'string' &&
    segment.text.trim()
      ? [{ locator: segment.locator, label: segment.label, text: segment.text }]
      : [],
  );
}

function hasSimilarSectionsAcrossSources(sources) {
  const sourcesByLabel = new Map();
  for (const [sourceIndex, source] of sources.entries()) {
    for (const segment of source.segments) {
      const label = normalizeText(segment.label).toLocaleLowerCase('ru-RU');
      if (!sourcesByLabel.has(label)) sourcesByLabel.set(label, new Set());
      sourcesByLabel.get(label).add(sourceIndex);
    }
  }
  return [...sourcesByLabel.values()].some((sourceIndexes) => sourceIndexes.size > 1);
}

function countSourceChars(sources) {
  return sources.reduce((total, source) => total + source.segments.reduce(
    (subtotal, segment) => subtotal + segment.text.length,
    0,
  ), 0);
}

function compareCaseSize(left, right) {
  return left.sourceChars - right.sourceChars || left.objectId.localeCompare(right.objectId);
}

function pickEvenly(items, count) {
  if (count === 0) return [];
  if (items.length < count) throw new Error('OPENAI_LUNA_TERRA_FIXTURE_STRATA_MISSING');
  if (count === 1) return [items[Math.floor((items.length - 1) / 2)]];
  return Array.from({ length: count }, (_, index) =>
    items[Math.round(index * (items.length - 1) / (count - 1))],
  );
}

function normalizeText(value) {
  return String(value).normalize('NFC').replace(/\s+/gu, ' ').trim();
}
