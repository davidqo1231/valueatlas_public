# ValueAtlas (static prototype)

Pure HTML/CSS/JS site shell + D3 embeds (no framework, no build step).

## Run locally

```bash
python -m http.server 8000 --directory public
```

Then open `http://localhost:8000/index.html` and click a country card.

## Meta files

Generate `public/data/meta/countries.json` from `mappings/countries_tiva.csv`:

```bash
python3 scripts/build_meta_countries.py
```

