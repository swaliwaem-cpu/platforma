import type {
  AssistantGeoBrowserInput,
  AssistantGeoResolution,
  AssistantSendMessageInput,
} from './assistant';

export type AssistantProductSubmissionDecision =
  | { status: 'READY'; body: AssistantSendMessageInput }
  | { status: 'CONFIRMATION_REQUIRED' };

export function mapAssistantProductSubmission(
  content: string,
  resolution: AssistantGeoResolution,
  retainedGeo?: AssistantGeoBrowserInput | null,
): AssistantProductSubmissionDecision;
