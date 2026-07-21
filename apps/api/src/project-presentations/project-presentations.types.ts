export const PROJECT_PRESENTATION_TEMPLATE_VERSION = 'project-catalog-4x5-v1';
export const PROJECT_PRESENTATION_SNAPSHOT_VERSION = 1;
export const PROJECT_PRESENTATION_PAGE_WIDTH = 540;
export const PROJECT_PRESENTATION_PAGE_HEIGHT = 675;
export const PROJECT_PRESENTATION_MAX_OBJECTS = 12;
export const PROJECT_PRESENTATION_MAX_IMAGES = 3;
export const PROJECT_PRESENTATION_MAX_ADVANTAGES = 3;

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

export function isProjectPresentationSnapshot(value: unknown): value is ProjectPresentationSnapshotV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as Partial<ProjectPresentationSnapshotV1>;
  return snapshot.schemaVersion === 1 && Array.isArray(snapshot.objects) && typeof snapshot.title === 'string';
}
