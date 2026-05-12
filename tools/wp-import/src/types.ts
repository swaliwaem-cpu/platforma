import { ObjectFileType, ObjectStatus, LocationType, Prisma } from '@prisma/client';

export type ImportModeName = 'preview' | 'run';

export type WpPost = {
  ID: number;
  post_title: string | null;
  post_name: string | null;
  post_content: string | null;
  post_status: string;
  post_date: string | null;
  post_modified: string | null;
};

export type WpMetaRow = {
  post_id: number;
  meta_key: string;
  meta_value: string | null;
};

export type WpTerm = {
  term_id: number;
  name: string;
  slug: string;
  taxonomy: string;
  parent: number;
};

export type WpObjectTerm = WpTerm & {
  object_id: number;
};

export type WpTermMetaRow = {
  term_id: number;
  meta_key: string;
  meta_value: string | null;
};

export type WpAttachment = WpPost & {
  attachedFile: string | null;
  localPath: string | null;
  localExists: boolean;
  sizeBytes: number | null;
  mimeType: string | null;
  guid: string | null;
};

export type WpSourceData = {
  siteUrl: string | null;
  uploadsPath: string;
  objects: WpPost[];
  metaByPostId: Map<number, Map<string, string[]>>;
  termsByObjectId: Map<number, WpObjectTerm[]>;
  termsById: Map<number, WpTerm>;
  termMetaById: Map<number, Map<string, string[]>>;
  attachmentsById: Map<number, WpAttachment>;
  referencedAttachmentIds: Set<number>;
};

export type ImportIssueSeverity = 'info' | 'warning' | 'error';

export type ImportIssue = {
  severity: ImportIssueSeverity;
  code: string;
  message: string;
  wpPostId?: number;
  wpAttachmentId?: number;
  metaKey?: string;
};

export type MappedDeveloper = {
  name: string;
  slug: string;
};

export type DeveloperAliasGroup = {
  canonicalName: string;
  aliases: string[];
};

export type DeveloperAliasConfig = {
  groups: DeveloperAliasGroup[];
};

export type MappedLocation = {
  wpTermId: number;
  name: string;
  slug: string;
  type: LocationType;
  parentWpTermId: number | null;
};

export type MappedMetroStation = {
  wpTermId: number;
  name: string;
  slug: string;
  lineName: string | null;
  lineColor: string | null;
};

export type MappedImage = {
  attachment: WpAttachment;
  sortOrder: number;
  isCover: boolean;
  alt: string | null;
  title: string | null;
  sourceMetaKey: string;
};

export type MappedFile = {
  attachment: WpAttachment;
  type: ObjectFileType;
  title: string | null;
  sortOrder: number;
  sourceMetaKey: string;
};

export type MappedObject = {
  wpPostId: number;
  title: string;
  slug: string;
  status: ObjectStatus;
  description: string | null;
  architectureDescription: string | null;
  infrastructureDescription: string | null;
  fillingDescription: string | null;
  shortDescription: null;
  priceFrom: string | null;
  pricePerMeterFrom: string | null;
  completionYear: number | null;
  completionQuarter: number | null;
  address: string | null;
  latitude: string | null;
  longitude: string | null;
  publishedAt: Date | null;
  developer: MappedDeveloper | null;
  locations: MappedLocation[];
  primaryLocation: MappedLocation | null;
  metroStations: MappedMetroStation[];
  images: MappedImage[];
  files: MappedFile[];
  featuresJson: Prisma.InputJsonObject;
};

export type ImportSummary = {
  source: 'wordpress';
  postType: string;
  dryRun: boolean;
  objectsFound: number;
  objectsMapped: number;
  objectsImported: number;
  objectsCreated: number;
  objectsUpdated: number;
  objectsFailed: number;
  developersMapped: number;
  locationsMapped: number;
  metroStationsMapped: number;
  referencedAttachments: number;
  validImagesMapped: number;
  validFilesMapped: number;
  warningsCount: number;
  errorsCount: number;
};

export type MappedImport = {
  objects: MappedObject[];
  warnings: ImportIssue[];
  errors: ImportIssue[];
  summary: ImportSummary;
};
