export type AssistantContextKind = 'OBJECT' | 'LOT' | 'DEVELOPER' | 'CATALOG_FILTERS';

export type AssistantPageContext = {
  kind: AssistantContextKind;
  key: string;
  label: string;
};

export type AssistantMessageRole = 'USER' | 'ASSISTANT';
export type AssistantRunStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
export type AssistantProgressStep = 'UNDERSTANDING' | 'SEARCHING' | 'COMPARING' | 'ANSWERING';
export type AssistantFeedbackRating = 'LIKE' | 'DISLIKE';
export type AssistantFeedbackReason =
  | 'WRONG_FACT'
  | 'MISSING_RESULT'
  | 'IRRELEVANT'
  | 'STALE_DATA'
  | 'BROKEN_LINK'
  | 'SLOW_RESPONSE'
  | 'OTHER';

export type AssistantFeedback = {
  id: string;
  rating: AssistantFeedbackRating;
  reason: AssistantFeedbackReason | null;
  comment: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AssistantAlternativeDeviation = {
  type: 'BUDGET' | 'DISTRICT' | 'DEVELOPER' | 'ROOMS';
  label: string;
};

export type AssistantGeoAnchor = {
  latitude: number;
  longitude: number;
  label: string;
  source: 'MANUAL' | 'PLACE' | 'ALIAS' | 'KNOWLEDGE';
};

export type AssistantGeoKind = 'POINT' | 'LINE' | 'AREA';
export type AssistantGeoMode = 'NEAR' | 'INSIDE';
export type AssistantGeoPoint = { latitude: number; longitude: number };

export type AssistantGeoPointGeometry = {
  type: 'Point';
  coordinates: [longitude: number, latitude: number];
};

export type AssistantGeoLineGeometry =
  | { type: 'LineString'; coordinates: [longitude: number, latitude: number][] }
  | { type: 'MultiLineString'; coordinates: [longitude: number, latitude: number][][] };

export type AssistantGeoPolygon = {
  type: 'Polygon';
  coordinates: [longitude: number, latitude: number][][];
};

export type AssistantGeoMultiPolygon = {
  type: 'MultiPolygon';
  coordinates: [longitude: number, latitude: number][][][];
};

export type AssistantGeoAreaGeometry = AssistantGeoPolygon | AssistantGeoMultiPolygon;
export type AssistantGeoReferenceGeometry =
  | AssistantGeoPointGeometry
  | AssistantGeoLineGeometry
  | AssistantGeoAreaGeometry;

export type AssistantGeoPointSearchContext = {
  kind: 'POINT';
  mode: 'NEAR';
  label: string;
  point: AssistantGeoPoint;
  distanceMeters: number;
  source: 'MANUAL' | 'LANDMARK';
  landmarkId?: string;
  slotId?: string;
  sourceSpan?: AssistantGeoSourceSpan;
};

export type AssistantGeoLineSearchContext = {
  kind: 'LINE';
  mode: 'NEAR';
  label: string;
  landmarkId: string;
  distanceMeters: number;
  source: 'LANDMARK';
  slotId?: string;
  sourceSpan?: AssistantGeoSourceSpan;
};

export type AssistantGeoAreaSearchContext =
  | {
      kind: 'AREA';
      mode: 'NEAR';
      label: string;
      landmarkId: string;
      distanceMeters: number;
      source: 'LANDMARK';
      slotId?: string;
      sourceSpan?: AssistantGeoSourceSpan;
    }
  | {
      kind: 'AREA';
      mode: 'INSIDE';
      label: string;
      landmarkId: string;
      source: 'LANDMARK';
      slotId?: string;
      sourceSpan?: AssistantGeoSourceSpan;
    };

export type AssistantGeoConstraint =
  | AssistantGeoPointSearchContext
  | AssistantGeoLineSearchContext
  | AssistantGeoAreaSearchContext;

export type AssistantGeoConstraintSet = {
  operator: 'ALL';
  constraints: AssistantGeoConstraint[];
};

export type AssistantGeoSearchContext = AssistantGeoConstraint;
export type AssistantGeoSearchSelection = AssistantGeoSearchContext | AssistantGeoConstraintSet;

export type AssistantGeoSourceSpan = { start: number; end: number };

export type AssistantGeoSlotMetadata = {
  slotId?: string;
  sourceSpan?: AssistantGeoSourceSpan;
};

export type AssistantGeoResolutionMetadata = AssistantGeoSlotMetadata & {
  mode: AssistantGeoMode;
  distanceMeters?: number;
};

export type AssistantGeoBrowserConstraint =
  | (AssistantGeoSlotMetadata & {
      referenceType: 'LANDMARK';
      landmarkId: string;
      mode: AssistantGeoMode;
      distanceMeters?: number | null;
    })
  | (AssistantGeoSlotMetadata & {
      referenceType: 'MANUAL_POINT';
      point: AssistantGeoPoint & { label?: string };
      mode: 'NEAR';
      distanceMeters?: number | null;
    });

export type AssistantGeoBrowserInput = AssistantGeoBrowserConstraint | {
  operator: 'ALL';
  constraints: AssistantGeoBrowserConstraint[];
};

export type AssistantGeoCandidate = {
  id: string;
  label: string;
  kind: AssistantGeoKind;
  mode: AssistantGeoMode;
  distanceMeters?: number;
  point?: AssistantGeoPoint;
  latitude?: number;
  longitude?: number;
  city: string | null;
  countryCode: string | null;
  source: 'ALIAS' | 'PLACE' | 'KNOWLEDGE';
};

export type AssistantGeoSingleResolution =
  | { status: 'NOT_APPLICABLE' }
  | (AssistantGeoResolutionMetadata & {
      status: 'RESOLVED' | 'AMBIGUOUS';
      sourceText?: string;
      placeQuery: string;
      /** @deprecated Present only for point-only compatibility clients. */
      radiusMeters?: number;
      candidates: AssistantGeoCandidate[];
    })
  | (AssistantGeoResolutionMetadata & {
      status: 'NOT_FOUND' | 'UNAVAILABLE';
      sourceText?: string;
      placeQuery: string;
      /** @deprecated Present only for point-only compatibility clients. */
      radiusMeters?: number;
      actions: ['MANUAL', 'REFINE'];
    })
  | (AssistantGeoResolutionMetadata & {
      status: 'REFINE_REQUIRED';
      placeQuery: string;
      sourceText?: string;
      actions: ['REFINE', 'MANUAL'];
    });

export type AssistantGeoResolutionSlot = {
  slotId: string;
  sourceText: string;
  sourceSpan: AssistantGeoSourceSpan;
} & Exclude<AssistantGeoSingleResolution, { status: 'NOT_APPLICABLE' }>;

export type AssistantGeoResolution = AssistantGeoSingleResolution | {
  status: 'COMPOSITE';
  operator: 'ALL';
  constraints: AssistantGeoResolutionSlot[];
};

export type AssistantGeoResolveInput = {
  content: string;
  locale?: string;
  country?: string | null;
  viewbox?: [west: number, south: number, east: number, north: number] | null;
};

export type AssistantGeoAliasInput = {
  query: string;
  locale: string;
  country: string | null;
  candidate: {
    label: string;
    latitude: number;
    longitude: number;
    city: string | null;
    countryCode: string | null;
  };
};

export type AssistantGeoResultMarker = {
  unitId: string;
  latitude: number;
  longitude: number;
  distanceMeters?: number;
  kind: 'PRIMARY' | 'ALTERNATIVE';
};

export type AssistantGeoConstraintView = AssistantGeoConstraint & {
  referenceGeometry: AssistantGeoReferenceGeometry;
  searchArea: AssistantGeoAreaGeometry;
};

export type AssistantGeoSearchView = AssistantGeoConstraintView & {
  markers: AssistantGeoResultMarker[];
};

export type AssistantGeoCompositeSearchView = {
  operator: 'ALL';
  constraints: AssistantGeoConstraintView[];
  markers: AssistantGeoResultMarker[];
};

export type AssistantGeoView = AssistantGeoSearchView | AssistantGeoCompositeSearchView;

export type AssistantSearchResultCard = {
  unitId: string;
  title: string;
  subtitle: string;
  priceRub: number;
  availabilityLabel: string;
  freshnessLabel: string;
  isStale: boolean;
  href: string;
  facts: string[];
  pdfs: Array<{ title: string; href: string }>;
  deviations: AssistantAlternativeDeviation[];
  distanceMeters?: number;
};

type AssistantKnowledgeFactCardBase = {
  id: string;
  label: string;
  value: string;
  freshnessLabel: string;
  isStale: boolean;
};

type AssistantLegacyKnowledgeFactCard = AssistantKnowledgeFactCardBase & {
  sourceLabel?: never;
  sourceUrl?: never;
  verifiedAt?: never;
};

type AssistantSourcedKnowledgeFactCard = AssistantKnowledgeFactCardBase & {
  sourceLabel: string;
  sourceUrl: string;
  verifiedAt: string;
};

export type AssistantKnowledgeFactCard =
  | AssistantLegacyKnowledgeFactCard
  | AssistantSourcedKnowledgeFactCard;

export type AssistantExternalLotCard = {
  id: string;
  title: string;
  subtitle: string;
  priceRub: number;
  availabilityLabel: string;
  freshnessLabel: string;
  isStale: boolean;
  href: string;
};

type AssistantSearchResultsBase = {
  kind: 'SEARCH_RESULTS';
  exactResults: AssistantSearchResultCard[];
  alternatives: AssistantSearchResultCard[];
  geo?: AssistantGeoView;
};

type AssistantLegacySearchResultsAnswer = AssistantSearchResultsBase & {
  totalExactResults?: never;
  additionalExactResults?: never;
};

type AssistantExpandedSearchResultsAnswer = AssistantSearchResultsBase & {
  totalExactResults: number;
  additionalExactResults: AssistantSearchResultCard[];
};

export type AssistantComparisonSummary = {
  minimumPriceRub: number | null;
  completion: string[];
  metros: string[];
};

export type AssistantComparisonGroup = {
  target: string;
  status: 'MATCHED' | 'NO_MATCH';
  totalExactResults: number;
  exactResults: AssistantSearchResultCard[];
  additionalExactResults: AssistantSearchResultCard[];
  summary: AssistantComparisonSummary;
};

export type AssistantComparisonResultsAnswer = {
  kind: 'COMPARISON_RESULTS';
  groups: [AssistantComparisonGroup, AssistantComparisonGroup];
  geo?: AssistantGeoView;
};

export type AssistantAnswer =
  | AssistantLegacySearchResultsAnswer
  | AssistantExpandedSearchResultsAnswer
  | AssistantComparisonResultsAnswer
  | {
      kind: 'KNOWLEDGE_RESULTS';
      facts: AssistantKnowledgeFactCard[];
      externalLots: AssistantExternalLotCard[];
    }
  | { kind: 'CLARIFICATION' }
  | { kind: 'REFUSAL'; code?: 'SOURCE_NOT_CONNECTED' }
  | { kind: 'SAFE_BOUNDARY' };

export type AssistantMessage = {
  id: string;
  role: AssistantMessageRole;
  content: string;
  context: AssistantPageContext | null;
  geo: AssistantGeoSearchSelection | null;
  answer: AssistantAnswer | null;
  feedback: AssistantFeedback | null;
  createdAt: string;
};

export type AssistantConversationSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messagesCount: number;
};

export type AssistantConversation = AssistantConversationSummary & {
  messages: AssistantMessage[];
};

export type AssistantProgressEvent = {
  step: AssistantProgressStep;
  label: string;
  createdAt: string;
};

export type AssistantRun = {
  id: string;
  conversationId: string;
  status: AssistantRunStatus;
  progressEvents: AssistantProgressEvent[];
  assistantMessage: AssistantMessage | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type AssistantConfigResponse = {
  enabled: boolean;
};

export type AssistantConversationResponse = {
  conversation: AssistantConversation;
};

export type AssistantConversationsResponse = {
  items: AssistantConversationSummary[];
  nextCursor: string | null;
};

export type AssistantRunResponse = {
  run: AssistantRun;
};

export type AssistantSendMessageInput = {
  content: string;
  context?: AssistantPageContext | null;
  geo?: AssistantGeoBrowserInput | null;
};

export type AssistantFeedbackInput = {
  rating: AssistantFeedbackRating;
  reason?: AssistantFeedbackReason | null;
  comment?: string | null;
};

export type AssistantFeedbackResponse = {
  feedback: AssistantFeedback;
};
