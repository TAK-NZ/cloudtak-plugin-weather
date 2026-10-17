# Weather

CloudTAK plugin that adds rain, radar and cloud layers to the map, with a rain forecast slider.

Weather data provided by [Rainbow.ai](https://rainbow.ai).

## What it does

* A weather button sits at the bottom centre of the map. A badge shows how many layers are on. All layers are off by default, so nothing is requested until you turn one on.
* **Clouds** and **Radar** are toggles. **Rain** is Off, Regional or Global.
* The **forecast slider** moves rain from **Now** up to 4 hours ahead in 10 minute steps. Clouds and radar always show the current data; they get a `current` tag while a forecast time is selected. The forecast is not remembered: the map opens at Now.
* The **Weather** menu entry (right-side menu, or the gear in the bar) has per-layer opacity, rain and radar colour palettes, a coverage mask, radar precipitation type, map tile sharpness, and the time zone for labels (New Zealand, UTC or this device). Settings are stored in the browser.
* Times are shown as approximate (`~`) because the weather service picks its own latest 10 minute data slot.

## Requirements

A CloudTAK server that provides `/api/weather/status` and `/api/weather/tile/{z}/{x}/{y}.png`, which is the [TAK-NZ CloudTAK fork](https://github.com/TAK-NZ/CloudTAK). If the endpoint is missing or switched off, the plugin adds nothing to the app.

The server holds the weather service key and relays the tiles. Set these environment variables on the CloudTAK API task:

| Variable | Meaning |
|---|---|
| `WEATHER_PROXY_URL` | HTTPS base URL of the weather proxy, without a trailing `/{z}/{x}/{y}.png` |
| `WEATHER_PROXY_KEY` | Dedicated weather proxy client key. It never reaches the browser |
| `WEATHER_RATE_LIMIT` | Optional. Tile requests per user per minute, 60 to 6000, default 900 |

## Install

The plugin is compiled into the CloudTAK web bundle when the CloudTAK image is built. List its URL in the `webPlugins` setting of the CDK context (several plugins can be separated by commas or spaces):

```json
"webPlugins": "https://github.com/TAK-NZ/cloudtak-plugin-weather.git"
```

The build clones the default branch (`main`) with `--depth 1`. A change to this repository alone does not change the image hash, so re-run the image build with `force_rebuild` or change a file under `api/` or `app/`. Users then choose **Settings → Refresh App**, because the service worker caches the old app.

## Development

Put a clone at `app/plugins/cloudtak-plugin-weather` inside a CloudTAK checkout (the folder is git-ignored by CloudTAK). The app's own ESLint, `vue-tsc` and Vitest configuration apply:

```bash
npm run test    # Vitest, plugin specs only
npm run lint
npm run check   # vue-tsc for the whole app
```

The same checks run as part of `npm run lint && npm run check && npm run build` in `app/`.

The menu icon is Font Awesome Free (CC BY 4.0). See [NOTICE](NOTICE).

## Licence

GNU Affero General Public License v3.0 only. See [LICENSE](LICENSE).
