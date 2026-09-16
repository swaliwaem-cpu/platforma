# 04: Fail-closed Internet и Web Search accounting

**Parent spec:** `docs/helpar/fix-zaebal.md`

**What to build:** Интернет остаётся управляемым контуром доверенных источников: planner не получает произвольный Web Search, discovery работает только в admin/background lane. Каждый физический Responses/Web Search attempt резервируется до HTTP, фактическое usage сначала settlement-ится, а нарушение tool-call contract безопасно отклоняется без retry, fallback и регистрации источника.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] До реализации добавлен RED-сценарий: один stub Responses HTTP request возвращает два `web_search_call` при request contract `max_tool_calls=1`.
- [ ] Planner остаётся structured intent parser и не получает произвольный web tool.
- [ ] Discovery нового official site запускается только admin/background lane, ограничен exact-host trust policy и не влияет на текущий chat answer.
- [ ] Request сохраняет `max_tool_calls=1`, но до HTTP резервируется верхняя стоимость двух Web Search calls до отдельного доказательства стабильности provider contract.
- [ ] Все возвращённые `web_search_call` и физические attempts учитываются; известное usage settlement-ится до проверки результата.
- [ ] Количество calls, отличное от одного, отклоняет candidate с `ASSISTANT_SOURCE_DISCOVERY_TOOL_CALL_LIMIT_EXCEEDED`.
- [ ] После contract violation отсутствуют retry, Terra fallback, checkpoint mutation, source registration и indexing.
- [ ] `PROVIDER_BUDGET_CONTRACT_VIOLATION` становится critical rollout condition при `charge > reserve`, оставшемся RESERVED attempt или расхождении receipts с reported usage.
- [ ] Receipts позволяют однозначно различить operation run, execution и каждый физический attempt без утечки raw provider payload/секретов.
- [ ] Dry-run гарантированно делает ноль provider calls; успешный stub-сценарий доказывает один request/один Web Search и корректные reserve/settlement/registration.
- [ ] Targeted source/discovery/ledger, disposable PostgreSQL и fix-token regression suites проходят вместе с затронутым build, релевантными full gates и `git diff --check`.
- [ ] Ни один реальный платный вызов не выполняется в рамках автоматической реализации; live canary разрешён только отдельной свежей командой с точным cap в тикете 06.
- [ ] Disposable-ресурсы очищены, unrelated dirty/untracked-файлы сохранены, изменения оформлены одним scoped local commit без push/deploy.

