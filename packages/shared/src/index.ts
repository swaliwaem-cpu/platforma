export const platformName = 'Platforma';

export type UserStatus = 'ACTIVE' | 'BLOCKED' | 'INVITED' | 'DEACTIVATED';
export type ObjectStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export type LocationType = 'AREA' | 'DISTRICT' | 'CUSTOM';
export type FileStorage = 'LOCAL' | 'MINIO';
export type FileVariant = 'THUMBNAIL' | 'CARD' | 'DETAIL';
export type ObjectFileType = 'PRESENTATION' | 'FLOOR_PLAN' | 'DOCUMENT' | 'OTHER';
export type ObjectImageSection = 'ARCHITECTURE' | 'INTERIORS' | 'FILLING';
export type ImportMode = 'PREVIEW' | 'RUN';
export type ImportStatus = 'PENDING' | 'SUCCESS' | 'PARTIAL' | 'FAILED';
export type CatalogQuickLinkType = 'DEVELOPER' | 'KRT' | 'SALES_START';

export type ProfilePhotoFile = {
  id: string;
  url: string | null;
  originalName: string | null;
  mimeType: string | null;
  updatedAt: string;
};

export type HealthStatus = {
  status: 'ok' | 'error';
  database: 'ok' | 'unavailable';
  postgis?: boolean;
  timestamp?: string;
  message?: string;
};

export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  status: UserStatus;
  role: {
    id: string;
    name: string;
  };
  profilePhotoFile: ProfilePhotoFile | null;
  permissions: string[];
};

export type AuthResponse = {
  accessToken: string;
  user: AuthUser;
};

export type EmailRegistrationRequestResponse = {
  ok: true;
};

export type EmailRegistrationVerifyInput =
  | {
      token: string;
      email?: never;
      code?: never;
    }
  | {
      email: string;
      code: string;
      token?: never;
    };

export type AdminRole = {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
};

export type AdminUser = {
  id: string;
  email: string;
  name: string | null;
  status: UserStatus;
  role: {
    id: string;
    name: string;
  };
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type AdminUsersResponse = {
  items: AdminUser[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export type AdminRolesResponse = {
  items: AdminRole[];
};

export type ObjectDeveloper = {
  id: string;
  wpTermId: number | null;
  name: string;
  slug: string | null;
};

export type DevelopersResponse = {
  items: ObjectDeveloper[];
};

export type ObjectLocation = {
  id: string;
  wpTermId: number | null;
  name: string;
  slug: string;
  type: LocationType;
  parentId: string | null;
};

export type LocationsResponse = {
  items: ObjectLocation[];
};

export type ObjectLocationLink = ObjectLocation & {
  isPrimary: boolean;
  sortOrder: number;
};

export type ObjectMetroStation = {
  id: string;
  wpTermId: number | null;
  name: string;
  slug: string;
  lineName: string | null;
  lineColor: string | null;
};

export type MetroStationsResponse = {
  items: ObjectMetroStation[];
};

export type ObjectMetroStationLink = ObjectMetroStation & {
  sortOrder: number;
};

export type ObjectStoredFile = {
  id: string;
  wpAttachmentId: number | null;
  storage: FileStorage;
  bucket: string | null;
  key: string;
  url: string | null;
  originalName: string | null;
  mimeType: string | null;
  sizeBytes: string | null;
  checksum: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FileResponse = {
  file: ObjectStoredFile;
};

export type ObjectImage = {
  id: string;
  file: ObjectStoredFile;
  sortOrder: number;
  isCover: boolean;
  section: ObjectImageSection | null;
  alt: string | null;
  title: string | null;
  sourceMetaKey: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ObjectLinkedFile = {
  id: string;
  file: ObjectStoredFile;
  type: ObjectFileType;
  title: string | null;
  sortOrder: number;
  sourceMetaKey: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RealEstateObjectBase = {
  id: string;
  wpPostId: number | null;
  title: string;
  slug: string;
  status: ObjectStatus;
  description: string | null;
  architectureDescription: string | null;
  infrastructureDescription: string | null;
  fillingDescription: string | null;
  shortDescription: string | null;
  layoutsUrl: string | null;
  krtName: string | null;
  apartmentAreaRange: string | null;
  ceilingHeight: string | null;
  propertyClass: string | null;
  floorRange: string | null;
  apartmentsCountText: string | null;
  priceFrom: string | null;
  pricePerMeterFrom: string | null;
  completionYear: number | null;
  completionQuarter: number | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  featuresJson: Record<string, unknown>;
  developer: ObjectDeveloper | null;
  primaryLocation: ObjectLocation | null;
  locations: ObjectLocationLink[];
  metroStations: ObjectMetroStationLink[];
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type RealEstateObjectSummary = RealEstateObjectBase & {
  coverImage: ObjectImage | null;
  presentationFile: ObjectLinkedFile | null;
};

export type RealEstateObjectDetail = RealEstateObjectBase & {
  images: ObjectImage[];
  files: ObjectLinkedFile[];
};

export type ObjectsResponse = {
  items: RealEstateObjectSummary[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export type ObjectResponse = {
  object: RealEstateObjectDetail;
};

export type PublicCatalogQuickLink = {
  id: string;
  type: CatalogQuickLinkType;
  label: string;
  sortOrder: number;
  developerId: string | null;
  krtName: string | null;
  objectSlug: string | null;
};

export type CatalogLinksResponse = {
  items: PublicCatalogQuickLink[];
};

export type AdminCatalogQuickLinkObject = {
  id: string;
  title: string;
  slug: string;
  status: ObjectStatus;
};

export type AdminCatalogQuickLink = {
  id: string;
  type: CatalogQuickLinkType;
  label: string;
  sortOrder: number;
  isEnabled: boolean;
  developerId: string | null;
  objectId: string | null;
  krtName: string | null;
  developer: ObjectDeveloper | null;
  object: AdminCatalogQuickLinkObject | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminCatalogLinksResponse = {
  items: AdminCatalogQuickLink[];
};

export type UpdateCatalogQuickLinkInput = {
  id?: string;
  type: CatalogQuickLinkType;
  label: string;
  sortOrder: number;
  isEnabled: boolean;
  developerId?: string | null;
  objectId?: string | null;
  krtName?: string | null;
};

export type UpdateCatalogLinksRequest = {
  items: UpdateCatalogQuickLinkInput[];
};

export type MapObject = {
  id: string;
  title: string;
  slug: string;
  status: ObjectStatus;
  address: string | null;
  latitude: number;
  longitude: number;
  priceFrom: string | null;
  pricePerMeterFrom: string | null;
  completionYear: number | null;
  completionQuarter: number | null;
  developer: ObjectDeveloper | null;
  primaryLocation: ObjectLocation | null;
  locations: ObjectLocationLink[];
  metroStations: ObjectMetroStationLink[];
  images: ObjectImage[];
  coverImage: ObjectImage | null;
};

export type MapObjectsResponse = {
  items: MapObject[];
  total: number;
};

export type ImportReportUser = {
  id: string;
  email: string;
  name: string | null;
};

export type ImportReport = {
  id: string;
  mode: ImportMode;
  status: ImportStatus;
  source: string;
  startedAt: string;
  finishedAt: string | null;
  summaryJson: Record<string, unknown> | unknown[] | string | number | boolean | null;
  warningsJson: Record<string, unknown> | unknown[] | string | number | boolean | null;
  errorsJson: Record<string, unknown> | unknown[] | string | number | boolean | null;
  createdBy: ImportReportUser | null;
  createdAt: string;
};

export type ImportReportsResponse = {
  items: ImportReport[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export type ImportReportResponse = {
  report: ImportReport;
};
