export const platformName = 'Platforma';

export type UserStatus = 'ACTIVE' | 'BLOCKED' | 'INVITED' | 'DEACTIVATED';

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
  status: UserStatus;
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

export type AdminRole = {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
};

export type AdminUser = {
  id: string;
  email: string;
  name: string | null;
  status: UserStatus;
  role: {
    id: string;
    name: string;
  };
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type AdminUsersResponse = {
  items: AdminUser[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export type AdminRolesResponse = {
  items: AdminRole[];
};
