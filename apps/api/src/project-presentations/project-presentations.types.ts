export const PROJECT_PRESENTATION_TEMPLATE_VERSION = 'project-catalog-fw-html-3x4-v4';
export const PROJECT_PRESENTATION_SNAPSHOT_VERSION = 3;
export const PROJECT_PRESENTATION_PAGE_WIDTH = 540;
export const PROJECT_PRESENTATION_PAGE_HEIGHT = 720;
export const PROJECT_PRESENTATION_MAX_OBJECTS = 12;
export const PROJECT_PRESENTATION_MAX_IMAGES = 3;
export const PROJECT_PRESENTATION_MAX_ADVANTAGES = 4;
export const PROJECT_PRESENTATION_COVER_FEATURES = 4;

export type ProjectPresentationSnapshotCoverFeature = {
  title: string;
  caption: string;
};

export type ProjectPresentationSnapshotImage = {
  fileId: string;
  checksum: string | null;
  role: 'COVER' | 'PROJECT';
  sortOrder: number;
};

export type ProjectPresentationSnapshotObject = {
  sourceObjectId: string;
  sortOrder: number;
  title: string;
  description: string;
  advantages: string[];
  propertyClass: string;
  completion: string;
  price: string;
  district: string;
  developer: string;
  metro: string;
  latitude: number | null;
  longitude: number | null;
  images: ProjectPresentationSnapshotImage[];
};

export type ProjectPresentationSnapshotV1 = {
  schemaVersion: 1;
  templateVersion: string;
  page: { width: number; height: number };
  requestedAt: string;
  title: string;
  cover: {
    title: string;
    subtitle: string;
    clientName: string;
    issueLabel: string;
    image: ProjectPresentationSnapshotImage | null;
  };
  cta: {
    label: '@FluffyWhite';
    url: 'https://t.me/FluffyWhite';
  };
  broker: {
    name: string;
    phone: string;
    email: string;
    profilePhoto: ProjectPresentationSnapshotImage | null;
  };
  objects: ProjectPresentationSnapshotObject[];
};

// v2 adds the map page title; the broker is the user who started the generation.
export type ProjectPresentationSnapshotV2 = Omit<ProjectPresentationSnapshotV1, 'schemaVersion'> & {
  schemaVersion: 2;
  map: { title: string };
};

// v3 carries the wording of the four cover tiles; the client name is no longer printed.
export type ProjectPresentationSnapshotV3 = Omit<ProjectPresentationSnapshotV2, 'schemaVersion' | 'cover'> & {
  schemaVersion: 3;
  cover: ProjectPresentationSnapshotV2['cover'] & { features: ProjectPresentationSnapshotCoverFeature[] };
};

export type ProjectPresentationSnapshot =
  | ProjectPresentationSnapshotV1
  | ProjectPresentationSnapshotV2
  | ProjectPresentationSnapshotV3;

export function isProjectPresentationSnapshot(value: unknown): value is ProjectPresentationSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as Partial<ProjectPresentationSnapshot>;
  return (snapshot.schemaVersion === 1 || snapshot.schemaVersion === 2 || snapshot.schemaVersion === 3)
    && Array.isArray(snapshot.objects)
    && typeof snapshot.title === 'string';
}
