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
};

export type AssistantAnswer =
  | {
      kind: 'SEARCH_RESULTS';
      exactResults: AssistantSearchResultCard[];
      alternatives: AssistantSearchResultCard[];
    }
  | { kind: 'CLARIFICATION' }
  | { kind: 'REFUSAL' }
  | { kind: 'SAFE_BOUNDARY' };

export type AssistantMessage = {
  id: string;
  role: AssistantMessageRole;
  content: string;
  context: AssistantPageContext | null;
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
};
