import type { AuthResponse } from '@platforma/shared';

export const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';
export const apiAuthUpdatedEventName = 'platforma-auth-updated';
export const apiAuthClearedEventName = 'platforma-auth-cleared';

const apiConnectionErrorMessage = 'Не удалось связаться с сервером';

let currentAccessToken: string | null = null;
let refreshSessionPromise: Promise<AuthResponse> | null = null;

export function setApiAccessToken(accessToken: string | null) {
  currentAccessToken = accessToken;
}

export async function apiRequest<T = unknown>(
  path: string,
  accessToken: string,
  options: RequestInit = {},
) {
  const initialToken = currentAccessToken ?? accessToken;
  let response: Response;

  try {
    response = await sendApiRequest(path, initialToken, options);
  } catch {
    throw new Error(apiConnectionErrorMessage);
  }

  if (response.status === 401) {
    const refreshedSession = await refreshApiSession();

    try {
      response = await sendApiRequest(path, refreshedSession.accessToken, options);
    } catch {
      throw new Error(apiConnectionErrorMessage);
    }
  }

  if (!response.ok) {
    throw new Error(await resolveErrorMessage(response));
  }

  if (response.status === 204) {
    return null as T;
  }

  return (await response.json()) as T;
}

async function sendApiRequest(path: string, accessToken: string, options: RequestInit) {
  const isFormData = options.body instanceof FormData;

  return fetch(`${apiUrl}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      ...(options.body && !isFormData ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${accessToken}`,
      ...options.headers,
    },
  });
}

async function refreshApiSession() {
  if (refreshSessionPromise) {
    return refreshSessionPromise;
  }

  refreshSessionPromise = fetch(`${apiUrl}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(await resolveErrorMessage(response));
      }

      return (await response.json()) as AuthResponse;
    })
    .then((session) => {
      currentAccessToken = session.accessToken;
      window.dispatchEvent(new CustomEvent<AuthResponse>(apiAuthUpdatedEventName, { detail: session }));

      return session;
    })
    .catch((error) => {
      currentAccessToken = null;
      window.dispatchEvent(new Event(apiAuthClearedEventName));

      throw error;
    })
    .finally(() => {
      refreshSessionPromise = null;
    });

  return refreshSessionPromise;
}

async function resolveErrorMessage(response: Response) {
  if (response.status === 413) {
    return 'Слишком большой запрос: уменьшите размер файлов или загрузите меньше изображений';
  }

  try {
    const data = (await response.json()) as { message?: string | string[] };
    const message = Array.isArray(data.message) ? data.message.join(', ') : data.message;

    return message || 'Запрос не выполнен';
  } catch {
    return 'Запрос не выполнен';
  }
}
