# Insta Audio Dashboard (static)

A fully static version of the crawler's dashboard, deployable to Netlify. It has
**no backend** — all data is baked into `data.json` and audio is served as plain
files from `audio/`.

This is separate from the crawler (`../src`), which runs locally with a
headless browser and is **not** deployed.

## How it works

- `index.html` — the UI. On load it fetches `data.json` and does all filtering,
  sorting, pagination, the top-N tables, and CSV export **client-side** (this
  logic used to live in the `/api/dashboard` Node server).
- `data.json` — a snapshot of the `downloads` table from the crawler's SQLite DB.
- `audio/` — the `.m4a` files referenced by downloaded rows.
- `build.mjs` — regenerates `data.json` and `audio/` from the SQLite DB.

`data.json` and `audio/` are committed so Netlify can serve them directly.
Netlify never runs `build.mjs` (it has no access to the database).

## Refreshing the data

After the crawler has downloaded more, regenerate the snapshot from the repo root:

```bash
node dashboard/build.mjs
git add dashboard/data.json dashboard/audio
git commit -m "Refresh dashboard data"
git push
```

Netlify redeploys automatically on push.

## Netlify deploy settings

| Setting           | Value       |
| ----------------- | ----------- |
| Base directory    | `dashboard` |
| Build command     | *(leave blank, or the no-op in `netlify.toml`)* |
| Publish directory | `dashboard` |

These are also encoded in `netlify.toml`.

> ⚠️ The deployed site is **public** — the data and audio are openly accessible
> at the Netlify URL. Netlify password protection is a paid feature.
