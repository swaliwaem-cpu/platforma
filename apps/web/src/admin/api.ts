export const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export async function apiRequest<T = unknown>(
  path: string,
  accessToken: string,
  options: RequestInit = {},
) {
  const isFormData = options.body instanceof FormData;
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      ...(options.body && !isFormData ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${accessToken}`,
      ...options.headers,
    },
  });

  if (!response.ok) {
    throw new Error(await resolveErrorMessage(response));
  }

  if (response.status === 204) {
    return null as T;
  }

  return (await response.json()) as T;
}

async function resolveErrorMessage(response: Response) {
  try {
    const data = (await response.json()) as { message?: string | string[] };
    const message = Array.isArray(data.message) ? data.message.join(', ') : data.message;

    return message || 'Запрос не выполнен';
  } catch {
    return 'Запрос не выполнен';
  }
}
