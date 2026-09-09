# /live — live fact-checking page (https://facthem.es/live/)

Built by `python -m fact_them_be.live.frontend.build` from
`fact_them_be/src/fact_them_be/live/frontend/`. Do not edit here — change the
source and rebuild. Data base: `https://live-data.facthem.es/`.

The page is static: it polls immutable 10 s JSON buckets published by the runner
on aton and embeds the YouTube stream, held back by the session's delay. It has
no operator controls: those live on the runner's own `/admin` page (localhost).

Go-live steps: `fact_them_be/src/fact_them_be/live/docs/RUNBOOK.md` §1.6.
