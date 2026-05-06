import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AuthResponse, AuthUser } from '@platforma/shared';

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

type AuthContextValue = {
  accessToken: string | null;
  user: AuthUser | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  hasPermission: (permission: string) => boolean;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const applyAuthResponse = useCallback((response: AuthResponse) => {
    setAccessToken(response.accessToken);
    setUser(response.user);
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function refreshSession() {
      try {
        const response = await fetch(`${apiUrl}/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
        });

        if (!response.ok) {
          return;
        }

        const data = (await response.json()) as AuthResponse;

        if (isMounted) {
          applyAuthResponse(data);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    void refreshSession();

    return () => {
      isMounted = false;
    };
  }, [applyAuthResponse]);

  const login = useCallback(
    async (email: string, password: string) => {
      const response = await fetch(`${apiUrl}/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        throw new Error('Не удалось войти');
      }

      applyAuthResponse((await response.json()) as AuthResponse);
    },
    [applyAuthResponse],
  );

  const logout = useCallback(async () => {
    await fetch(`${apiUrl}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    });

    setAccessToken(null);
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      accessToken,
      user,
      isLoading,
      login,
      logout,
      hasPermission: (permission) => user?.permissions.includes(permission) ?? false,
    }),
    [accessToken, isLoading, login, logout, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('useAuth must be used inside AuthProvider');
  }

  return context;
}
