import { createHash } from 'node:crypto';

const TRAINING_POLICY_BODY = `Перед началом аттестации подтвердите ознакомление с правилами.

1. Голосовые сообщения, отправленные в рамках обучения и аттестации, сохраняются в защищённом хранилище Platforma.
2. Аудиозаписи хранятся бессрочно согласно принятому бизнес-решению. Автоматическое удаление исторических аудиозаписей не выполняется.
3. Аудиозаписи расшифровываются в текст.
4. Расшифровка и утверждённые администратором учебные материалы анализируются с применением искусственного интеллекта. Итоговый балл и ограничения рассчитываются сервером Platforma.
5. Результаты доступны сотруднику и уполномоченным администраторам. Полные расшифровки, технические ошибки и аудиофайлы сотруднику не показываются.
6. После подтверждения начала попытка списывается, запускается общий таймер; поставить попытку на паузу или отменить её нельзя.
7. Продолжая, вы подтверждаете, что ознакомились с текущей версией правил и согласны продолжить.`;

const TRAINING_POLICY_VERSION = '2026-07-28.1';
const TRAINING_POLICY_EFFECTIVE_AT = '2026-07-28T00:00:00.000Z';

export const CURRENT_TRAINING_POLICY = Object.freeze({
  version: TRAINING_POLICY_VERSION,
  title: 'Правила обучения и обработки голосовых ответов',
  body: TRAINING_POLICY_BODY,
  effectiveAt: TRAINING_POLICY_EFFECTIVE_AT,
  isActive: true,
  approvalStatus: 'APPROVED',
  checksum: createHash('sha256')
    .update(
      JSON.stringify({
        version: TRAINING_POLICY_VERSION,
        title: 'Правила обучения и обработки голосовых ответов',
        body: TRAINING_POLICY_BODY,
        effectiveAt: TRAINING_POLICY_EFFECTIVE_AT,
      }),
      'utf8',
    )
    .digest('hex'),
});
