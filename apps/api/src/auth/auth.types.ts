import { UserStatus } from '@prisma/client';

export type AuthenticatedUser = {
  id: string;
  email: string;
  name: string | null;
  brokerPhone: string | null;
  brokerEmail: string | null;
  status: UserStatus;
  role: {
    id: string;
    name: string;
  };
  profilePhotoFile: {
    id: string;
    url: string | null;
    originalName: string | null;
    mimeType: string | null;
    updatedAt: string;
  } | null;
  permissions: string[];
};

export type RequestWithAuth = {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthenticatedUser;
};

export type CookieOptions = {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
  path?: string;
  maxAge?: number;
};

export type CookieResponse = {
  cookie: (name: string, value: string, options?: CookieOptions) => void;
  clearCookie: (name: string, options?: Pick<CookieOptions, 'path' | 'sameSite' | 'secure'>) => void;
};

export type AccessTokenPayload = {
  sub: string;
  email: string;
  type: 'access';
};

export type RefreshTokenPayload = {
  sub: string;
  email: string;
  type: 'refresh';
  sessionId?: string;
};

export type MediaTokenPayload = {
  sub: string;
  email: string;
  type: 'media';
  scope: 'files:read';
  role: string;
};

export type LoginResponse = {
  accessToken: string;
  user: AuthenticatedUser;
};

export type EmailRegistrationRequestResponse = {
  ok: true;
};

export type EmailRegistrationRequestInput = {
  email: string;
  password: string;
  passwordConfirmation: string;
};

export type EmailRegistrationVerifyInput =
  | {
      token: string;
      email?: never;
      code?: never;
    }
  | {
      email: string;
      code: string;
      token?: never;
    };
