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
export type FeedFormat = 'YANDEX_REALTY' | 'CIAN_XML' | 'AVITO_XML' | 'FSK_XML' | 'TEKTA_XML';
export type FeedSourceKind = 'URL' | 'FILE' | 'INDEX_URL';
export type FeedUnitType = 'RESIDENTIAL' | 'COMMERCIAL';
export type FeedUnitStatus = 'AVAILABLE' | 'BOOKED' | 'RESERVED' | 'SOLD' | 'ARCHIVED' | 'UNKNOWN';

export type JsonValue = { [key: string]: JsonValue } | JsonValue[] | string | number | boolean | null;

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

export type EmailRegistrationRequestInput = {
  email: string;
  password: string;
  passwordConfirmation: string;
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
  mapName: string | null;
  aerotourUrl: string | null;
  layoutsUrl: string | null;
  krtName: string | null;
  apartmentAreaRange: string | null;
  ceilingHeight: string | null;
  propertyClass: string | null;
  floorRange: string | null;
  apartmentsCountText: string | null;
  priceFrom: string | null;
  pricePerMeterFrom: string | null;
  feedPriceFrom: string | null;
  feedPricePerMeterFrom: string | null;
  feedAreaRange: string | null;
  feedFloorRange: string | null;
  feedUnitsCount: number | null;
  feedUnitsCountText: string | null;
  matchedFeedUnitsCount: number | null;
  feedCompletionYear: number | null;
  feedCompletionQuarter: number | null;
  feedUpdatedAt: string | null;
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

export type FeedSourceObject = {
  id: string;
  title: string;
  slug: string;
  status: ObjectStatus;
};

export type FeedSourceMapping = {
  id: string;
  sourceId: string;
  objectId: string;
  sourceKey: string;
  sourceTitle: string;
  filterJson: JsonValue;
  isActive: boolean;
  object: FeedSourceObject;
  createdAt: string;
  updatedAt: string;
};

export type FeedSource = {
  id: string;
  sourceKind: FeedSourceKind;
  url: string | null;
  xmlFileId: string | null;
  xmlFile: ObjectStoredFile | null;
  format: FeedFormat;
  filterJson: JsonValue | null;
  developerId: string;
  objectId: string | null;
  isActive: boolean;
  deletedAt: string | null;
  lastPreviewAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  developer: ObjectDeveloper;
  object: FeedSourceObject | null;
  mappings: FeedSourceMapping[];
  createdAt: string;
  updatedAt: string;
};

export type FeedImportRun = {
  id: string;
  sourceId: string;
  mode: ImportMode;
  status: ImportStatus;
  startedAt: string;
  finishedAt: string | null;
  summaryJson: JsonValue;
  warningsJson: JsonValue;
  errorsJson: JsonValue;
  createdAt: string;
};

export type FeedResidentialUnitDetails = {
  unitId: string;
  apartmentNumber: string | null;
  layoutType: string | null;
  livingArea: string | null;
  kitchenArea: string | null;
  balconyCount: number | null;
  detailsJson: JsonValue;
};

export type FeedCommercialUnitDetails = {
  unitId: string;
  commercialType: string | null;
  entrance: string | null;
  ceilingHeight: string | null;
  powerKw: string | null;
  separateEntrance: boolean | null;
  detailsJson: JsonValue;
};

export type FeedMedia = {
  id: string;
  sourceUrl: string;
  file: ObjectStoredFile | null;
  contentType: string | null;
  checksum: string | null;
  sortOrder: number;
  label: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FeedUnit = {
  id: string;
  sourceId: string;
  objectId: string;
  externalId: string;
  type: FeedUnitType;
  status: FeedUnitStatus;
  title: string | null;
  address: string | null;
  building: string | null;
  section: string | null;
  floor: number | null;
  rooms: number | null;
  price: string | null;
  discountPrice: string | null;
  effectivePrice: string | null;
  currency: string | null;
  area: string | null;
  pricePerMeter: string | null;
  discountPricePerMeter: string | null;
  effectivePricePerMeter: string | null;
  completionYear: number | null;
  completionQuarter: number | null;
  rawPayload: JsonValue;
  archivedAt: string | null;
  residentialDetails: FeedResidentialUnitDetails | null;
  commercialDetails: FeedCommercialUnitDetails | null;
  media: FeedMedia[];
  createdAt: string;
  updatedAt: string;
};

export type FeedParserWarning = {
  code: string;
  message: string;
  externalId?: string;
  field?: string;
  value?: JsonValue;
};

export type FeedSourceAnalysisObject = {
  title: string;
  unitsCount: number;
  feedIndexSourceUrls: string[];
  projectNames: string[];
  externalIds: string[];
  buildingNames: string[];
  yandexBuildingIds: string[];
  yandexHouseIds: string[];
  avitoDevelopmentIds: string[];
  addresses: string[];
  filterJson: Record<string, string[]> | null;
};

export type FeedSourceAnalysis = {
  format: FeedFormat;
  developerName: string | null;
  unitsCount: number;
  objects: FeedSourceAnalysisObject[];
  warningsCount: number;
  warnings: FeedParserWarning[];
};

export type FeedIndexFileCandidate = {
  url: string;
  format: FeedFormat | null;
  unitsCount: number;
  warningsCount: number;
  error: string | null;
};

export type FeedIndexPlatformCandidate = {
  format: FeedFormat;
  label: string;
  filesCount: number;
  unitsCount: number;
  warningsCount: number;
  errorsCount: number;
  files: FeedIndexFileCandidate[];
};

export type FeedIndexDiscovery = {
  sourceUrl: string;
  files: FeedIndexFileCandidate[];
  platforms: FeedIndexPlatformCandidate[];
};

export type FeedSourcesResponse = {
  items: FeedSource[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export type FeedSourceResponse = {
  source: FeedSource;
};

export type FeedSourceAnalysisResponse = {
  discovery: FeedIndexDiscovery | null;
  analysis: FeedSourceAnalysis | null;
};

export type FeedImportRunsResponse = {
  items: FeedImportRun[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export type FeedImportRunResponse = {
  run: FeedImportRun;
};

export type FeedUnitsResponse = {
  items: FeedUnit[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasDiscountPrices: boolean;
};

export type FeedUnitRoomGroupSummary = {
  key: string;
  label: string;
  total: number;
  areaMin: string | null;
  areaMax: string | null;
  priceMin: string | null;
  priceMax: string | null;
  items: FeedUnit[];
};

export type FeedUnitGroupSummary = {
  key: string;
  label: string;
  buildings: string[];
  total: number;
  roomGroups: FeedUnitRoomGroupSummary[];
};

export type FeedUnitGroupsResponse = {
  groups: FeedUnitGroupSummary[];
  total: number;
  hasDiscountPrices: boolean;
};

export type FeedUnitResponse = {
  unit: FeedUnit;
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
  mapName: string | null;
  latitude: number;
  longitude: number;
  priceFrom: string | null;
  pricePerMeterFrom: string | null;
  apartmentAreaRange: string | null;
  feedPriceFrom: string | null;
  feedPricePerMeterFrom: string | null;
  feedAreaRange: string | null;
  feedFloorRange: string | null;
  feedUnitsCount: number | null;
  feedUnitsCountText: string | null;
  feedCompletionYear: number | null;
  feedCompletionQuarter: number | null;
  feedUpdatedAt: string | null;
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
