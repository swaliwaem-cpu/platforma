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
  sources: AssistantSource[];
  /** Compact summary the browser sends back as this turn's content in later requests. */
  historyNote: string;
};

export type AssistantJobStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';

export type AssistantJob = {
  id: string;
  status: AssistantJobStatus;
  steps: string[];
  answer: AssistantAnswer | null;
  error: string | null;
  createdAt: string;
};

export type AssistantJobResponse = {
  job: AssistantJob;
};
