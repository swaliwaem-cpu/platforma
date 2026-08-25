import {
  AssistantKnowledgeSourceType,
  AssistantSourceFactKind,
} from '@prisma/client';

type KnowledgeAuthorityInput = {
  kind: AssistantSourceFactKind;
  sourceType: AssistantKnowledgeSourceType;
  sourcePriority: number;
};

export function assistantKnowledgeAuthorityScore(input: KnowledgeAuthorityInput) {
  if (input.kind === AssistantSourceFactKind.PROMOTION) {
    return (input.sourceType === AssistantKnowledgeSourceType.BANK_PROMOTION
      || input.sourceType === AssistantKnowledgeSourceType.DEVELOPER_PROMOTION ? 4_000 : 3_000)
      + input.sourcePriority;
  }
  if (input.kind === AssistantSourceFactKind.STATIC_DESCRIPTION
    || input.kind === AssistantSourceFactKind.ARCHITECTURE
    || input.kind === AssistantSourceFactKind.INFRASTRUCTURE) {
    return (input.sourceType === AssistantKnowledgeSourceType.DEVELOPMENT_PAGE ? 4_000 : 2_000)
      + input.sourcePriority;
  }
  return (input.sourceType === AssistantKnowledgeSourceType.DEVELOPMENT_PAGE ? 3_000 : 1_000)
    + input.sourcePriority;
}

export function isSafeOfficialHttpsUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}
