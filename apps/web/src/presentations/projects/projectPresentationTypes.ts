import type {
  ObjectDeveloper,
  ObjectImage,
  ObjectLocation,
  ObjectMetroStationLink,
  ObjectStoredFile,
} from '@platforma/shared';

export const projectPresentationMaxObjects = 12;
export const projectPresentationMaxImages = 3;
export const projectPresentationMaxAdvantages = 3;
export const projectPresentationMaxCoverFileSizeBytes = 10 * 1024 * 1024;

export type ProjectPresentationOwner = {
  id: string;
  email: string;
  name: string | null;
};

export type ProjectPresentationObject = {
  id: string;
  title: string;
  slug: string;
  address: string | null;
  description: string | null;
  propertyClass: string | null;
  completionYear: number | null;
  completionQuarter: number | null;
  priceFrom: string | null;
  pricePerMeterFrom: string | null;
  areaRange: string | null;
  primaryLocation: ObjectLocation | null;
  developer: ObjectDeveloper | null;
  metroStations: ObjectMetroStationLink[];
  images: ObjectImage[];
};

export type ProjectPresentationDraftObject = {
  id: string;
  objectId: string;
  sortOrder: number;
  manualTitle: string | null;
  manualDescription: string | null;
  advantages: string[];
  imageIds: string[];
  propertyClass: string | null;
  completion: string | null;
  price: string | null;
  district: string | null;
  developer: string | null;
  metro: string | null;
  object: ProjectPresentationObject;
};

export type ProjectPresentationDraft = {
  id: string;
  ownerUserId: string;
  title: string;
  coverTitle: string | null;
  coverSubtitle: string | null;
  clientName: string | null;
  issueLabel: string | null;
  coverImageId: string | null;
  coverFileId: string | null;
  coverFile: ObjectStoredFile | null;
  templateVersion: string;
  version: number;
  objectsCount: number;
  objects: ProjectPresentationDraftObject[];
  owner: ProjectPresentationOwner | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectPresentationDraftsResponse = {
  items: ProjectPresentationDraft[];
};

export type ProjectPresentationDraftResponse = {
  draft: ProjectPresentationDraft;
};

export type ProjectPresentationObjectsResponse = {
  items: ProjectPresentationObject[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export type ProjectPresentationDocumentStatus = 'PENDING' | 'RUNNING' | 'READY' | 'FAILED';

export type ProjectPresentationDocument = {
  id: string;
  ownerUserId: string;
  draftId: string | null;
  title: string;
  status: ProjectPresentationDocumentStatus;
  templateVersion: string;
  objectsCount: number;
  progress: number;
  attempts: number;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  canDownload: boolean;
  createdBy: ProjectPresentationOwner | null;
};

export type ProjectPresentationDocumentsResponse = {
  items: ProjectPresentationDocument[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export type ProjectPresentationDocumentResponse = {
  document: ProjectPresentationDocument;
};

export type ProjectPresentationDraftObjectInput = {
  objectId: string;
  manualTitle: string | null;
  manualDescription: string | null;
  advantages: string[];
  imageIds: string[];
  propertyClass: string | null;
  completion: string | null;
  price: string | null;
  district: string | null;
  developer: string | null;
  metro: string | null;
};

export type ProjectPresentationDraftForm = {
  title: string;
  coverTitle: string;
  coverSubtitle: string;
  clientName: string;
  issueLabel: string;
  coverImageId: string | null;
  coverFile: ObjectStoredFile | null;
  objects: ProjectPresentationDraftObject[];
};

export type ProjectPresentationValidationIssue = {
  path: string;
  message: string;
};
