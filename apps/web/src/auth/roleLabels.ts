const roleLabels: Record<string, string> = {
  admin: 'Администратор',
  editor: 'Редактор',
  marketing: 'Маркетинг',
  training_admin: 'Админ обучения',
  user: 'Пользователь',
};

export function formatRoleName(name: string) {
  return roleLabels[name] ?? name;
}
