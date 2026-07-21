import type {
  ProjectPresentationDraft,
  ProjectPresentationDraftForm,
  ProjectPresentationDraftObject,
  ProjectPresentationDraftObjectInput,
  ProjectPresentationObject,
  ProjectPresentationValidationIssue,
} from './projectPresentationTypes';
import {
  projectPresentationMaxAdvantages,
  projectPresentationMaxImages,
  projectPresentationMaxObjects,
} from './projectPresentationTypes';

export function createProjectPresentationForm(draft: ProjectPresentationDraft): ProjectPresentationDraftForm {
  return {
    title: draft.title,
    coverTitle: draft.coverTitle ?? '',
    coverSubtitle: draft.coverSubtitle ?? '',
    clientName: draft.clientName ?? '',
    issueLabel: draft.issueLabel ?? '',
    coverImageId: draft.coverImageId,
    coverFile: draft.coverFile,
    objects: [...draft.objects].sort((left, right) => left.sortOrder - right.sortOrder),
  };
}

export function createDraftObject(object: ProjectPresentationObject, sortOrder: number): ProjectPresentationDraftObject {
  const completionYear = object.completionYear;
  const completionQuarter = object.completionQuarter;

  return {
    id: `local-${object.id}`,
    objectId: object.id,
    sortOrder,
    manualTitle: object.title,
    manualDescription: null,
    advantages: [],
    imageIds: getDefaultImageIds(object),
    propertyClass: object.propertyClass,
    completion: completionYear
      ? `${completionQuarter ? `${completionQuarter} кв. ` : ''}${completionYear}`
      : null,
    price: formatProjectPrice(object.priceFrom),
    district: object.primaryLocation?.name ?? null,
    developer: object.developer?.name ?? null,
    metro: object.metroStations[0]?.name ?? null,
    object,
  };
}

export function toDraftObjectInputs(objects: ProjectPresentationDraftObject[]): ProjectPresentationDraftObjectInput[] {
  return objects.map((item) => ({
    objectId: item.objectId,
    manualTitle: normalizeOptionalText(item.manualTitle),
    manualDescription: normalizeOptionalText(item.manualDescription),
    advantages: item.advantages.map((value) => value.trim()).filter(Boolean).slice(0, projectPresentationMaxAdvantages),
    imageIds: item.imageIds.slice(0, projectPresentationMaxImages),
    propertyClass: normalizeOptionalText(item.propertyClass),
    completion: normalizeOptionalText(item.completion),
    price: normalizeOptionalText(item.price),
    district: normalizeOptionalText(item.district),
    developer: normalizeOptionalText(item.developer),
    metro: normalizeOptionalText(item.metro),
  }));
}

export function reorderDraftObjects(
  objects: ProjectPresentationDraftObject[],
  objectId: string,
  direction: -1 | 1,
) {
  const currentIndex = objects.findIndex((item) => item.objectId === objectId);
  const nextIndex = currentIndex + direction;

  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= objects.length) {
    return objects;
  }

  const nextObjects = [...objects];
  const [movedItem] = nextObjects.splice(currentIndex, 1);

  if (!movedItem) {
    return objects;
  }

  nextObjects.splice(nextIndex, 0, movedItem);

  return nextObjects.map((item, index) => ({ ...item, sortOrder: index }));
}

export function validateProjectPresentationForm(form: ProjectPresentationDraftForm) {
  const issues: ProjectPresentationValidationIssue[] = [];

  if (!form.title.trim()) {
    issues.push({ path: 'title', message: 'Введите название черновика' });
  }

  if (!form.coverTitle.trim()) {
    issues.push({ path: 'coverTitle', message: 'Заполните заголовок обложки' });
  }

  if (form.objects.length === 0) {
    issues.push({ path: 'objects', message: 'Добавьте хотя бы один жилой комплекс' });
  }

  if (form.objects.length > projectPresentationMaxObjects) {
    issues.push({ path: 'objects', message: `В презентации может быть не больше ${projectPresentationMaxObjects} ЖК` });
  }

  if (!form.coverImageId && !form.coverFile) {
    issues.push({ path: 'coverImageId', message: 'Выберите фотографию для обложки' });
  }

  for (const item of form.objects) {
    if (!(item.manualTitle ?? item.object.title).trim()) {
      issues.push({ path: `objects.${item.objectId}.manualTitle`, message: 'Укажите название ЖК' });
    }

    if (!(item.manualDescription ?? item.object.description ?? '').trim()) {
      issues.push({ path: `objects.${item.objectId}.manualDescription`, message: `Добавьте описание для ${item.object.title}` });
    }

    if (item.imageIds.length > projectPresentationMaxImages) {
      issues.push({ path: `objects.${item.objectId}.imageIds`, message: `Для ${item.object.title} можно выбрать не больше 3 фото` });
    }

    if (item.advantages.filter((value) => value.trim()).length > projectPresentationMaxAdvantages) {
      issues.push({ path: `objects.${item.objectId}.advantages`, message: `Для ${item.object.title} можно указать не больше 3 преимуществ` });
    }
  }

  return issues;
}

export function findProjectImage(
  objects: ProjectPresentationDraftObject[],
  imageId: string | null,
) {
  if (!imageId) {
    return null;
  }

  for (const item of objects) {
    const image = item.object.images.find((candidate) => candidate.id === imageId);

    if (image) {
      return image;
    }
  }

  return null;
}

function getDefaultImageIds(object: ProjectPresentationObject) {
  return object.images.slice(0, projectPresentationMaxImages).map((image) => image.id);
}

function formatProjectPrice(value: string | null) {
  if (!value) {
    return null;
  }

  const numericValue = Number(value);

  return Number.isFinite(numericValue)
    ? `от ${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(numericValue)} ₽`
    : value;
}

function normalizeOptionalText(value: string | null | undefined) {
  return value?.trim() || null;
}
