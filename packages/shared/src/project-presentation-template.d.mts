export type ProjectPresentationFontFile =
  | 'Involve-Regular.woff2'
  | 'Involve-Medium.woff2'
  | 'Inter-Regular.woff2'
  | 'Inter-Medium.woff2'
  | 'Lora-Italic.woff2';

export type ProjectPresentationMapMarker = { x: number; y: number };

export type ProjectPresentationTemplateProject = {
  key: string;
  title: string;
  description: string;
  price: string;
  propertyClass: string;
  metro: string;
  advantages: string[];
  imageSrcs: Array<string | null>;
};

export type ProjectPresentationTemplateModel = {
  cover: {
    title: string;
    subtitle: string;
    clientName: string;
    issueLabel: string;
    imageSrc: string | null;
  };
  map: {
    title: string;
    imageSrc: string | null;
    markers: ProjectPresentationMapMarker[];
  };
  projects: ProjectPresentationTemplateProject[];
  contacts: {
    phone: string;
    ctaUrl: string;
  };
};

export type ProjectPresentationTemplateOptions = {
  fontUrls: Record<ProjectPresentationFontFile, string>;
  pageKeys?: string[];
};

export declare const PROJECT_PRESENTATION_PAGE_SIZE: Readonly<{ width: 720; height: 960 }>;
export declare const PROJECT_PRESENTATION_MAP_SIZE: Readonly<{ width: 648; height: 735 }>;
export declare const PROJECT_PRESENTATION_MAP_VIEW: Readonly<{
  padding: number;
  maxZoom: number;
  singlePointZoom: number;
  defaultCenter: readonly [number, number];
  defaultZoom: number;
}>;
export declare const PROJECT_PRESENTATION_LIMITS: Readonly<{
  coverTitle: number;
  coverSubtitle: number;
  clientName: number;
  mapTitle: number;
  description: number;
  advantage: number;
  advantages: number;
  images: number;
}>;
export declare const PROJECT_PRESENTATION_FONT_FILES: readonly ProjectPresentationFontFile[];
export declare const PROJECT_PRESENTATION_LINKS: Readonly<{
  telegram: string;
  instagram: string | null;
  youtube: string | null;
}>;
export declare const PROJECT_PRESENTATION_DEFAULT_PHONE: string;
export declare const PROJECT_PRESENTATION_DEFAULT_MAP_TITLE: string;

export declare function truncateProjectPresentationDescription(value: string | null | undefined, limit?: number): string;
export declare function getProjectPresentationPageKeys(projectKeys: string[]): string[];
export declare function getProjectPresentationFallbackMarkers(
  points: Array<{ latitude: number | null; longitude: number | null }>,
): ProjectPresentationMapMarker[];
export declare function renderProjectPresentationHtml(
  model: ProjectPresentationTemplateModel,
  options: ProjectPresentationTemplateOptions,
): string;
