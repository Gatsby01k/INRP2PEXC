# Operator page baselines

Pixel baselines for the built operator product, recorded **only** in the canonical environment
(`docs/VISUAL_BASELINES.md`): `mcr.microsoft.com/playwright:v1.56.1-noble` on linux/amd64, through the
**Visual baselines (canonical update)** workflow or `bash apps/web/visual/docker.sh update`.

`ENVIRONMENT.json` records the environment, git SHA, run URL, time and baseline count of the last recording.
The compare guard refuses to run without it, so an empty directory fails the `visual-pages` job loudly rather
than passing on nothing.

Do not add, edit or delete a PNG here by hand. Baselines change only through the update path, and every changed
image is reviewed.
