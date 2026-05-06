export const platformName = 'Platforma';

export type HealthStatus = {
  status: 'ok' | 'error';
  database: 'ok' | 'unavailable';
  postgis?: boolean;
  timestamp?: string;
  message?: string;
};

export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  status: 'ACTIVE' | 'BLOCKED' | 'INVITED';
  role: {
    id: string;
    name: string;
  };
  permissions: string[];
};

export type AuthResponse = {
  accessToken: string;
  user: AuthUser;
};
