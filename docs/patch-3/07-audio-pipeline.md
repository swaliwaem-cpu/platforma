# 07. Оптимизация аудиопайплайна и согласование лимитов

Статус: реализовано локально; migration не развёрнута
Приоритет: P1
Область: ffmpeg, MinIO, transcription upload, память

## Проблема

Telegram voice сохраняется как OGG, затем перекодируется в несжатый mono WAV 16 кГц. Доменный слой разрешает до 30 минут, но transcriber принимает не более 25 МБ. Такой WAV достигает 25 МБ примерно за 13–14 минут, поэтому формально допустимый длинный ответ позднее завершится `OPENAI_INVALID_AUDIO`.

Дополнительно текущий путь несколько раз полностью читает файл: для header/checksum, загрузки в storage, повторного чтения из storage и создания `Blob`.

Затрагиваемые участки:

- `training-audio.service.ts`;
- `training-openai-transcriber.ts`;
- storage service;
- audio access endpoint и file metadata.

## Целевое решение

Предпочтительно объединять сегменты в поддерживаемый сжатый формат, например WebM/Opus, с контролируемыми параметрами mono/16 kHz. Если итоговый файл всё равно превышает 25 МБ, делить запись на части с небольшим контекстным перекрытием и последовательно объединять transcript.

Требуется единый источник лимитов:

- максимальная длительность;
- максимальный размер входных сегментов;
- максимальный размер provider upload;
- ffmpeg timeout;
- максимальная память на одну работу.

## Производительность

- Хэшировать файл потоково.
- Не читать сохранённый объект повторно сразу после его создания.
- Передавать provider client stream/file, если выбранная HTTP-реализация это поддерживает.
- Ограничить одновременное ffmpeg-кодирование отдельно от evaluator concurrency.
- Сохранять duration, input bytes, output bytes и ffmpeg latency.

## Границы

- Не отправлять Telegram OGG напрямую, пока формат явно не поддержан provider contract.
- Не удалять оригинальные сегменты до успешного transcription checkpoint.
- Не менять private bucket и audio RBAC.
- Не склеивать transcript без сохранения порядка сегментов.

## Критерии приёмки

- Любая разрешённая длительность гарантированно укладывается в provider contract либо заранее отклоняется.
- Ответ длиннее 13 минут не падает из-за внутреннего противоречия лимитов.
- Restart после транскрипции не вызывает повторную загрузку аудио.
- Пиковая память ограничена и проверена на максимальном допустимом файле.
- Audio access продолжает проверять ownership, checksum и private storage.

## Реализовано

- Новые merged-записи кодируются в mono 16 kHz WebM/Opus с ограниченным bitrate; ранее сохранённые WAV остаются читаемыми.
- Лимиты duration, segment/input bytes, provider upload, ffmpeg timeout/concurrency, буферизованной памяти, bitrate и overlap собраны в `training-audio-limits.ts` и валидируются fail-closed.
- Storage download/upload и SHA-256 работают потоково через временные файлы; provider получает file-backed `Blob`, а не собранный в памяти WAV.
- Если configured provider limit меньше merged-файла, ffmpeg создаёт последовательные WebM-части с перекрытием; transcript объединяется в исходном порядке с удалением точного дублирующего overlap.
- `TrainingAnswer` хранит duration, input/output bytes и ffmpeg latency через additive migration `20260808180000_optimize_training_audio_pipeline`.
- Private bucket, server-side RBAC, checksum/ownership-проверки и хранение исходных OGG-сегментов сохранены.
