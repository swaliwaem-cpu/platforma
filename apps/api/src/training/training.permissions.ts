export const TRAINING_PERMISSION_DEFINITIONS = [
  ['training:take', 'Take training assessments'],
  ['training:own-results:read', 'Read own training results'],
  ['training:projects:read', 'Read training projects'],
  ['training:projects:manage', 'Manage training projects'],
  ['training:results:read', 'Read training results'],
  ['training:results:review', 'Review training results'],
  ['training:attempts:reset', 'Reset training attempts'],
  ['training:audio:read', 'Read protected training audio'],
  ['training:ranking:read', 'Read training ranking'],
  ['training:telegram:manage', 'Manage training Telegram integration'],
  ['training:data:delete', 'Delete training data'],
] as const;

export type TrainingPermissionKey = (typeof TRAINING_PERMISSION_DEFINITIONS)[number][0];

export const TRAINING_USER_PERMISSION_KEYS = [
  'training:take',
  'training:own-results:read',
  'training:projects:read',
] as const satisfies readonly TrainingPermissionKey[];

export const TRAINING_ADMIN_PERMISSION_KEYS = [
  'training:take',
  'training:own-results:read',
  'training:projects:read',
  'training:projects:manage',
  'training:results:read',
  'training:results:review',
  'training:attempts:reset',
  'training:audio:read',
  'training:ranking:read',
  'training:telegram:manage',
] as const satisfies readonly TrainingPermissionKey[];
