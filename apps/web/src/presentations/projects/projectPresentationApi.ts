import { apiRequest, apiUrl } from '../../admin/api';
import type {
  ProjectPresentationDocument,
  ProjectPresentationDocumentResponse,
  ProjectPresentationDocumentsResponse,
  ProjectPresentationDraft,
  ProjectPresentationDraftObjectInput,
  ProjectPresentationDraftResponse,
  ProjectPresentationDraftsResponse,
  ProjectPresentationObjectsResponse,
} from './projectPresentationTypes';

const basePath = '/project-presentations';

export function listProjectPresentationDrafts(accessToken: string) {
  return apiRequest<ProjectPresentationDraftsResponse>(`${basePath}/drafts?limit=100`, accessToken);
}

export function createProjectPresentationDraft(accessToken: string, title: string) {
  return apiRequest<ProjectPresentationDraftResponse>(`${basePath}/drafts`, accessToken, {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
}

export function getProjectPresentationDraft(accessToken: string, draftId: string) {
  return apiRequest<ProjectPresentationDraftResponse>(`${basePath}/drafts/${encodeURIComponent(draftId)}`, accessToken);
}

export function updateProjectPresentationDraft(
  accessToken: string,
  draftId: string,
  input: {
    version: number;
    title: string;
    coverTitle: string | null;
    coverSubtitle: string | null;
    clientName: string | null;
    issueLabel: string | null;
    coverImageId: string | null;
  },
) {
  return apiRequest<ProjectPresentationDraftResponse>(`${basePath}/drafts/${encodeURIComponent(draftId)}`, accessToken, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function replaceProjectPresentationObjects(
  accessToken: string,
  draftId: string,
  version: number,
  objects: ProjectPresentationDraftObjectInput[],
) {
  return apiRequest<ProjectPresentationDraftResponse>(
    `${basePath}/drafts/${encodeURIComponent(draftId)}/objects`,
    accessToken,
    {
      method: 'PUT',
      body: JSON.stringify({ version, objects }),
    },
  );
}

export function uploadProjectPresentationCover(
  accessToken: string,
  draftId: string,
  version: number,
  file: File,
) {
  const formData = new FormData();
  formData.append('version', String(version));
  formData.append('file', file);

  return apiRequest<ProjectPresentationDraftResponse>(
    `${basePath}/drafts/${encodeURIComponent(draftId)}/cover`,
    accessToken,
    { method: 'POST', body: formData },
  );
}

export function deleteProjectPresentationDraft(accessToken: string, draftId: string) {
  return apiRequest(`${basePath}/drafts/${encodeURIComponent(draftId)}`, accessToken, { method: 'DELETE' });
}

export function searchProjectPresentationObjects(accessToken: string, search: string, page = 1) {
  const params = new URLSearchParams({
    page: String(page),
    limit: '30',
  });

  if (search.trim()) {
    params.set('search', search.trim());
  }

  return apiRequest<ProjectPresentationObjectsResponse>(`${basePath}/objects?${params.toString()}`, accessToken);
}

export function listProjectPresentationDocuments(accessToken: string) {
  return apiRequest<ProjectPresentationDocumentsResponse>(`${basePath}/documents?limit=100`, accessToken);
}

export function getProjectPresentationDocument(accessToken: string, documentId: string) {
  return apiRequest<ProjectPresentationDocumentResponse>(
    `${basePath}/documents/${encodeURIComponent(documentId)}`,
    accessToken,
  );
}

export function createProjectPresentationDocument(accessToken: string, draft: ProjectPresentationDraft) {
  return apiRequest<ProjectPresentationDocumentResponse>(
    `${basePath}/drafts/${encodeURIComponent(draft.id)}/documents`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({
        version: draft.version,
        title: draft.title,
        idempotencyKey: window.crypto?.randomUUID?.() ?? `${draft.id}-${draft.version}-${Date.now()}`,
      }),
    },
  );
}

export function retryProjectPresentationDocument(accessToken: string, documentId: string) {
  return apiRequest<ProjectPresentationDocumentResponse>(
    `${basePath}/documents/${encodeURIComponent(documentId)}/retry`,
    accessToken,
    { method: 'POST' },
  );
}

export function deleteProjectPresentationDocument(accessToken: string, documentId: string) {
  return apiRequest(`${basePath}/documents/${encodeURIComponent(documentId)}`, accessToken, { method: 'DELETE' });
}

export async function downloadProjectPresentationDocument(
  accessToken: string,
  document: ProjectPresentationDocument,
) {
  const response = await fetch(
    `${apiUrl}${basePath}/documents/${encodeURIComponent(document.id)}/content`,
    {
      credentials: 'include',
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (!response.ok) {
    throw new Error('Не удалось скачать PDF');
  }

  const blob = await response.blob();
  const url = window.URL.createObjectURL(blob);
  const link = window.document.createElement('a');

  link.href = url;
  link.download = `${document.title || 'project-presentation'}.pdf`;
  window.document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}
