export const platformName = 'Platforma';

export type HealthStatus = {
  status: 'ok' | 'error';
  database: 'ok' | 'unavailable';
  postgis?: boolean;
  timestamp?: string;
  message?: string;
};
