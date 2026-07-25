# Prompt для Codex

Выполни ТОЛЬКО финальный этап 11–12: security hardening, observability, deployment/rollback docs, полный fake E2E и подготовка pilot calibration. Не запускай реальный production deploy и не создавай реальные Telegram/OpenAI secrets.

Прочитай все audit/architecture/checklist документы, а из spec:
- security/storage rules в `00_rules_business.md`;
- architecture/jobs в `01_architecture_data_domain.md`;
- integration privacy в `02_telegram_audio_ai_documents.md`;
- env/deploy в `03_api_frontend_jobs_env.md`;
- stages/tests/DoD в `04_stages_tests_acceptance.md`.

Сделай:
1. Consent/notification, webhook hardening, rate/input limits, prompt-injection safeguards.
2. Проверку private audio access и privileged access audit policy.
3. Структурированные логи без secrets/audio/transcript; operational counters/latencies без нового monitoring stack.
4. Health/readiness worker strategy.
5. Полный fake E2E: admin project 1+10 → publish → Telegram link → 4 multi-segment voices → score/review/result/rating → fourth attempt blocked/version pinning.
6. Eval dataset scaffold 20–30 обезличенных fixtures без copyrighted/raw personal audio.
7. Env, migrations, worker, ffmpeg, webhook, backup, retention, deploy и rollback документацию.
8. Pilot checklist для ЖК «Шагал», но не seed'и реальные материалы, пока их не предоставили.
9. Финальный прогон `pnpm build` и всех tests.

Закрой checklist только по фактически выполненным пунктам. В конце дай changelog, нерешённые production prerequisites и ОСТАНОВИСЬ.
