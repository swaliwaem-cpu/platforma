export type AssistantContextKind = 'OBJECT' | 'LOT' | 'DEVELOPER' | 'CATALOG_FILTERS';

export type AssistantPageContext = {
  kind: AssistantContextKind;
  key: string;
  label: string;
};

export type AssistantMessageRole = 'USER' | 'ASSISTANT';
export type AssistantRunStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
export type AssistantProgressStep = 'UNDERSTANDING' | 'SEARCHING' | 'COMPARING' | 'ANSWERING';

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

export type AssistantGeoSearchContext = {
  anchor: AssistantGeoAnchor;
  radiusMeters: number;
};

export type AssistantGeoCandidate = {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  city: string | null;
  countryCode: string | null;
  source: 'ALIAS' | 'PLACE' | 'KNOWLEDGE';
};

export type AssistantGeoResolution =
  | { status: 'NOT_APPLICABLE' }
  | { status: 'RADIUS_REQUIRED'; placeQuery: string; actions: ['REFINE'] }
  | {
      status: 'RESOLVED' | 'AMBIGUOUS';
      placeQuery: string;
      radiusMeters: number;
      candidates: AssistantGeoCandidate[];
    }
  | {
      status: 'NOT_FOUND' | 'UNAVAILABLE';
      placeQuery: string;
      radiusMeters: number;
      actions: ['MANUAL', 'REFINE'];
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
  candidate: Omit<AssistantGeoCandidate, 'id' | 'source'>;
};

export type AssistantGeoPolygon = {
  type: 'Polygon';
  coordinates: [longitude: number, latitude: number][][];
};

export type AssistantGeoResultMarker = {
  unitId: string;
  latitude: number;
  longitude: number;
  distanceMeters: number;
  kind: 'PRIMARY' | 'ALTERNATIVE';
};

export type AssistantGeoSearchView = AssistantGeoSearchContext & {
  polygon: AssistantGeoPolygon;
  markers: AssistantGeoResultMarker[];
};

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

export type AssistantKnowledgeFactCard = {
  id: string;
  label: string;
  value: string;
  freshnessLabel: string;
  isStale: boolean;
};

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

export type AssistantAnswer =
  | {
      kind: 'SEARCH_RESULTS';
      exactResults: AssistantSearchResultCard[];
      alternatives: AssistantSearchResultCard[];
      geo?: AssistantGeoSearchView;
    }
  | {
      kind: 'KNOWLEDGE_RESULTS';
      facts: AssistantKnowledgeFactCard[];
      externalLots: AssistantExternalLotCard[];
    }
  | { kind: 'CLARIFICATION' }
  | { kind: 'REFUSAL' }
  | { kind: 'SAFE_BOUNDARY' };

export type AssistantMessage = {
  id: string;
  role: AssistantMessageRole;
  content: string;
  context: AssistantPageContext | null;
  geo: AssistantGeoSearchContext | null;
  answer: AssistantAnswer | null;
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
  geo?: AssistantGeoSearchContext | null;
};
