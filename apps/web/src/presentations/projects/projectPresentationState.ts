import {
  PROJECT_PRESENTATION_LIMITS,
  truncateProjectPresentationDescription,
} from '@platforma/shared/project-presentation-template';

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

export const projectPresentationLimits = PROJECT_PRESENTATION_LIMITS;
export const projectPresentationCoverIssuePaths = new Set(['title', 'coverTitle', 'coverSubtitle', 'clientName', 'mapTitle', 'coverImageId']);

export function createProjectPresentationForm(draft: ProjectPresentationDraft): ProjectPresentationDraftForm {
  return {
    title: draft.title,
    coverTitle: draft.coverTitle ?? '',
    coverSubtitle: draft.coverSubtitle ?? '',
    clientName: draft.clientName ?? '',
    issueLabel: draft.issueLabel ?? '',
    mapTitle: draft.mapTitle ?? '',
    coverImageId: draft.coverImageId,
    coverFile: draft.coverFile,
    objects: [...draft.objects].sort((left, right) => left.sortOrder - right.sortOrder),
  };
}

// Photos are picked by hand from the project gallery, so a new card starts without them.
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
    imageIds: [],
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

// The PDF shows the catalog description cut to 430 characters unless the broker rewrote it.
export function resolveProjectDescription(item: ProjectPresentationDraftObject) {
  return item.manualDescription ?? truncateProjectPresentationDescription(item.object.description);
}

export function formatProjectPrice(value: string | null) {
  if (!value) {
    return null;
  }

  const numericValue = Number(value);

  return Number.isFinite(numericValue)
    ? `от ${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(numericValue)} ₽`
    : value;
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
  const limits = projectPresentationLimits;

  if (!form.title.trim()) {
    issues.push({ path: 'title', message: 'Введите название черновика' });
  }

  requireText(issues, 'coverTitle', form.coverTitle, 'Заполните заголовок обложки', limits.coverTitle, 'Заголовок обложки');

  if (form.coverSubtitle.trim().length > limits.coverSubtitle) {
    issues.push({ path: 'coverSubtitle', message: `Подзаголовок — не длиннее ${limits.coverSubtitle} символов` });
  }

  requireText(issues, 'clientName', form.clientName, 'Укажите имя клиента', limits.clientName, 'Имя клиента');
  requireText(issues, 'mapTitle', form.mapTitle, 'Заполните заголовок страницы с картой', limits.mapTitle, 'Заголовок страницы с картой');

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
    issues.push(...getProjectObjectValidationIssues(item));
  }

  return issues;
}

export function getProjectObjectValidationIssues(item: ProjectPresentationDraftObject) {
  const issues: ProjectPresentationValidationIssue[] = [];
  const limits = projectPresentationLimits;
  const name = item.manualTitle?.trim() || item.object.title;
  const path = (field: string) => `objects.${item.objectId}.${field}`;

  if (!(item.manualTitle ?? item.object.title).trim()) {
    issues.push({ path: path('manualTitle'), message: 'Укажите название ЖК' });
  }

  const description = resolveProjectDescription(item).trim();

  if (!description) {
    issues.push({ path: path('manualDescription'), message: `Добавьте описание для ${name}` });
  } else if (description.length > limits.description) {
    issues.push({ path: path('manualDescription'), message: `Описание ${name} — не длиннее ${limits.description} символов` });
  }

  const advantages = item.advantages.slice(0, limits.advantages).map((value) => value.trim());

  if (advantages.filter(Boolean).length < limits.advantages) {
    issues.push({ path: path('advantages'), message: `Заполните все ${limits.advantages} преимущества для ${name}` });
  } else if (advantages.some((value) => value.length > limits.advantage)) {
    issues.push({ path: path('advantages'), message: `Преимущества ${name} — не длиннее ${limits.advantage} символов` });
  }

  const galleryIds = new Set(item.object.images.map((image) => image.id));

  if (item.imageIds.length !== limits.images || item.imageIds.some((id) => !galleryIds.has(id))) {
    issues.push({ path: path('imageIds'), message: `Выберите ${limits.images} фото для ${name}` });
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

function requireText(
  issues: ProjectPresentationValidationIssue[],
  path: string,
  value: string,
  emptyMessage: string,
  maxLength: number,
  label: string,
) {
  const text = value.trim();

  if (!text) {
    issues.push({ path, message: emptyMessage });
  } else if (text.length > maxLength) {
    issues.push({ path, message: `${label} — не длиннее ${maxLength} символов` });
  }
}

function normalizeOptionalText(value: string | null | undefined) {
  return value?.trim() || null;
}
