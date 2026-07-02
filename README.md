# LEMONS. Weather Map v6

A tiny lemon-themed personal weather app for GitHub Pages.

## What is new in v6

- **Lemons says**: now tucked right above the stats as tiny unobtrusive small-print quips only.
- **NWS weather alerts**: US alerts appear as a minimal dark-lemon banner instead of scary red.
- **Saved places**: lowkey saved-spots drawer, stored only in the browser. The save/places/share buttons now live tastefully in the header.
- **Share links**: lowkey share button copies a `?lat=&lon=&name=` URL.
- **Lemonrise / Lemonset**: sunrise and sunset shown with clean lemon icons instead of sun icons.
- **Air + pollen tab**: AQI, PM2.5, PM10, ozone, NO2, and pollen vibe when available.
- Plain visits go back to the **“Where are you, Lemons?”** homepage. Shared links still open directly to the forecast.

## Files

```text
index.html
style.css
app.js
README.md
```

## Free hosting on GitHub Pages

1. Create a new GitHub repo.
2. Upload these files into the root of the repo.
3. Go to **Settings → Pages**.
4. Source: **Deploy from a branch**.
5. Branch: **main** / folder: **root**.
6. Save.

Geolocation only works reliably on HTTPS or localhost. GitHub Pages gives you HTTPS, so use the GitHub Pages URL instead of opening the file directly on a phone.

## Data sources

- Open-Meteo forecast + multi-model forecast blend
- Open-Meteo Air Quality
- NWS / weather.gov forecast and alerts for US locations
- MET Norway forecast when available
- Bright Sky / DWD for Germany when available
- RainViewer radar tiles
- OpenStreetMap / CARTO basemap
