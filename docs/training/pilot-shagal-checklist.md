# Pilot checklist — ЖК «Шагал»

Дата актуализации: 2026-07-28. Pilot не проводился, реальные материалы,
факты, вопросы, сотрудники и голоса не добавлялись.

## Роли и изоляция

- [ ] Назначены 1 admin, 1 training_admin и 3–5 test employees.
- [ ] Используются отдельные staging bot, OpenAI project, DB и buckets.
- [ ] Policy text и technical acceptance flow утверждены руководителем.
- [ ] Участники ознакомлены с бессрочным хранением audio и границами
  employee/admin visibility.

## Контент

- [ ] Каталожный объект ЖК «Шагал» выбран без создания дубля.
- [ ] Заполнен `pilot-content-template.md`: 1 MAIN, 10 FOLLOW_UP,
  facts/aliases, criteria/anchors и critical errors.
- [ ] Источники принадлежат компании, version/approved by/date зафиксированы.
- [ ] Pass score, attempt limit, timer, cooldown и retake policy утверждены.
- [ ] Draft validation пройдена, published version immutable.

## Calibration

- [ ] Подготовлено минимум 20–30 обезличенных примеров без audio в Git.
- [ ] Есть слабые/средние/сильные ответы, разные темп/дикция, цифры,
  ЖК/метро/застройщик, слова-паразиты, errors и unsupported claims.
- [ ] Expert labels/scores заполнены по
  `calibration-dataset-template.md`.
- [ ] AI/expert расхождения разобраны; scoring 55+15+15+15 и distinct −5 не
  меняются без отдельного продуктового решения.

## Pilot gate

- [ ] Staging, Telegram, audio, OpenAI synthetic smoke и go-live gates зелёные.
- [ ] Happy/review/recovery paths пройдены test users.
- [ ] Ответственный reviewer и incident/rollback owners назначены.
- [ ] После pilot выгружены только обезличенные metrics и safe error codes.
- [ ] Любой незакрытый обязательный пункт означает `NO-GO`.
