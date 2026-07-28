# Training calibration dataset template

Хранить dataset в защищённом staging workspace. В Git разрешена только эта
пустая схема; raw personal audio, имена, Telegram IDs и прямые идентификаторы
запрещены.

| Поле | Значение |
| --- | --- |
| anonymized_sample_id | |
| content_version | |
| question_id / question | |
| answer_strength | weak / medium / strong |
| transcript | |
| expert_fact_labels | |
| expert_criterion_scores | |
| expected_score_range | |
| critical_errors | |
| unsupported_claims | |
| reviewer_comment | |
| speech_characteristics | темп/дикция/цифры/термины без identity |

Минимум 20–30 примеров должен покрывать слабые/средние/сильные ответы,
вариативные дикцию/темп, числа, названия ЖК/метро/застройщика,
слова-паразиты, factual errors и unsupported claims. Сравнивать AI score с
двумя expert labels/range; спорные случаи уходят в manual review.
