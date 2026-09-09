# /directo — live fact-checking page (https://facthem.es/directo/)

Built by `python -m fact_them_be.live.frontend.build` from
`fact_them_be/src/fact_them_be/live/frontend/`. Do not edit here — change the
source and rebuild. Data base: `https://pub-4b0592b162234f079cbe05777d9aa1f2.r2.dev/`.

The page is static: it polls immutable 10 s JSON buckets published by the runner
on aton and embeds the YouTube stream, held back by the session's delay. It has
no operator controls: those live on the runner's own `/admin` page (localhost).

Go-live steps: `fact_them_be/src/fact_them_be/live/docs/RUNBOOK.md` §1.6.
