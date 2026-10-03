// Contracts of the lot-finding assistant: the browser starts a job with the whole
// conversation and polls it until the answer is ready.

export type AssistantConfigResponse = {
  enabled: boolean;
  webSearchEnabled: boolean;
};

export type AssistantChatRole = 'user' | 'assistant';

export type AssistantChatTurn = {
  role: AssistantChatRole;
  content: string;
};

export type AssistantAskInput = {
  messages: AssistantChatTurn[];
  /** Slug of the project page the user is looking at, if any. */
  pageObjectSlug?: string | null;
  /** UUID of the conversation; answered turns are saved under it in the asker's history. */
  conversationId?: string | null;
};

/** Lot finishing as the assistant reports it; lots without the data have none. */
export type AssistantFinishing = 'без отделки' | 'white box' | 'с отделкой' | 'с мебелью';

export type AssistantPlatformLot = {
  source: 'PLATFORMA';
  unitId: string;
  projectTitle: string;
  href: string;
  projectHref: string;
  developer: string | null;
  /** One of the four project classes, null when the project has none. */
  propertyClass: string | null;
  /** 0 means a studio. */
  rooms: number | null;
  areaM2: number | null;
  floor: number | null;
  priceRub: number;
  pricePerM2Rub: number | null;
  finishing: AssistantFinishing | null;
  building: string | null;
  completion: string | null;
  updatedAt: string;
  /** Project location for the results map; null when the project has no coordinates. */
  coordinates: [latitude: number, longitude: number] | null;
  /** Short project label for the map marker, as in the catalog map. */
  projectMapName: string | null;
};

export type AssistantWebLot = {
  source: 'WEB';
  projectTitle: string;
  description: string | null;
  rooms: number | null;
  areaM2: number | null;
  floor: number | null;
  /** Null when the price could not be confirmed on the opened page. */
  priceRub: number | null;
  url: string;
  siteName: string;
};

export type AssistantLot = AssistantPlatformLot | AssistantWebLot;

/** The page of a developer's site a project was checked on during the turn. */
export type AssistantProjectSiteCheck = {
  url: string;
  siteName: string;
  /** True when the page is on a domain known to be the developer's own; false when the site was found by search. */
  official: boolean;
  /** ISO time the page was opened. */
  checkedAt: string;
  /** Price from as seen on the page; null when the page does not confirm one. */
  priceFromRub: number | null;
};

/** A catalog project that fits the request but has no lots in the answer. */
export type AssistantProject = {
  projectId: string;
  title: string;
  /** App path of the project card. */
  href: string;
  developer: string | null;
  propertyClass: string | null;
  /** District and okrug by the coordinates, or the card's location tag. */
  location: string | null;
  /** Nearest metro with walking minutes, or the card's first station. */
  metro: string | null;
  /** All available lots of the project in Platforma, not only the matching ones. */
  availableLots: number;
  /** What the assistant says about it: from the developer's site when checked, otherwise from the card. */
  note: string;
  /** Null when the project was not checked on a site in this turn. */
  siteCheck: AssistantProjectSiteCheck | null;
};

/** Where an answer's data came from: a project in Platforma or a site opened in this turn. */
export type AssistantSource = {
  kind: 'PLATFORMA_PROJECT' | 'WEB';
  title: string;
  /** App path for a Platforma project, absolute URL for a site. */
  url: string;
  /** ISO time: last card or feed update for a project, the moment a site was opened. */
  date: string;
};

export type AssistantAnswer = {
  text: string;
  lots: AssistantLot[];
  /** Projects that fit the request without lots in the answer; answers saved before this existed have none. */
  projects?: AssistantProject[];
  sources: AssistantSource[];
  /** Compact summary the browser sends back as this turn's content in later requests. */
  historyNote: string;
  /** Logged turn to rate; null when the log could not be written. */
  turnId: string | null;
};

export type AssistantJobStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';

export type AssistantJob = {
  id: string;
  status: AssistantJobStatus;
  steps: string[];
  answer: AssistantAnswer | null;
  error: string | null;
  createdAt: string;
  turnId: string | null;
};

export type AssistantJobResponse = {
  job: AssistantJob;
};

/** A saved chat message; an assistant one carries the answer as it was shown and its rating. */
export type AssistantConversationMessage =
  | { id: string; role: 'user'; content: string }
  | {
      id: string;
      role: 'assistant';
      content: string;
      answer: AssistantAnswer;
      rating: AssistantTurnRating | null;
      ratingCommented: boolean;
    };

export type AssistantConversationSummary = {
  id: string;
  /** The first question, shortened. */
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type AssistantConversationsResponse = {
  items: AssistantConversationSummary[];
};

export type AssistantConversation = AssistantConversationSummary & {
  messages: AssistantConversationMessage[];
};

export type AssistantConversationResponse = {
  conversation: AssistantConversation;
};

/** One tool call inside a turn, as the turn log keeps it (arguments masked). */
export type AssistantTraceStep = {
  tool: string;
  args: Record<string, unknown>;
  result: { found?: number; ids?: string[]; error?: string };
  durationMs: number;
};

export type AssistantTurnRating = 'UP' | 'DOWN';

export type AssistantTurnFeedbackInput = {
  rating: AssistantTurnRating;
  /** What was wrong; mostly given with a thumbs down. */
  comment?: string | null;
};

export type AssistantAdminTurnSummary = {
  id: string;
  createdAt: string;
  user: { id: string; name: string | null; email: string };
  question: string;
  status: 'COMPLETED' | 'FAILED';
  errorCode: string | null;
  rating: AssistantTurnRating | null;
  ratingComment: string | null;
  lotsCount: number;
  model: string;
  durationMs: number;
  estimatedCostUsd: string | null;
};

export type AssistantAdminTurnsResponse = {
  items: AssistantAdminTurnSummary[];
  nextCursor: string | null;
};

export type AssistantAdminTurn = AssistantAdminTurnSummary & {
  conversationId: string | null;
  answerText: string | null;
  lots: AssistantLot[];
  sources: AssistantSource[];
  trace: AssistantTraceStep[];
  modelCalls: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  pricingVersion: string | null;
  ratedAt: string | null;
};

export type AssistantAdminTurnResponse = {
  turn: AssistantAdminTurn;
};

export type AssistantUsageTotals = {
  turns: number;
  failed: number;
  ratedUp: number;
  ratedDown: number;
  users: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
};

export type AssistantUsageDay = AssistantUsageTotals & {
  /** Moscow calendar day, YYYY-MM-DD. */
  date: string;
};

export type AssistantUsageResponse = {
  days: AssistantUsageDay[];
  totals: AssistantUsageTotals;
};
