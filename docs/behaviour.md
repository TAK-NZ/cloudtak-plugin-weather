# Behaviour details

Operational detail that the [README](../README.md) leaves out.

## Weather button

* A dot on the button shows that a layer is on and the controls are hidden (the panel is closed). The button's name and tooltip then read **Weather Controls, layers on, controls hidden**.
* Click the button to open the weather panel at the bottom of the map; click it again, or press Escape (focus returns to the button), to close it.

## Panel

* The panel is one box. The top row has four independent layer toggles, followed by the settings gear (**Weather Settings**) at the right end of the row. On a narrow screen the gear stays with the toggles on the last row.
* The bottom row has **Play**, **Now** (dimmed while the map is at Now, but still reachable with the keyboard), the time slider and the time of the frame with its time zone (for example `-40 min · 13:40 NZDT`, `Now · 01:20 UTC`, `+30 min · 14:50 NZST`).

## Clouds and Radar in forecast frames

* Clouds and Radar show the past exactly. They have no forecast, so they are hidden in forecast frames.
* Their toggles are dimmed with the tooltip **No forecast** while a forecast frame is shown, and clicking them still works.

## Play

* Clouds and Radar drop out while Play is in the forecast and come back after the wrap, and they are not requested for forecast frames.
* With only Clouds or Radar on, or the **Include forecast when playing** setting off, Play loops the last 2 hours.
* Play waits for the tiles of the next frame (at most 3 seconds), so a slow connection slows the loop instead of showing blank frames.
* Play pauses when you drag the slider, press Now, move, zoom or rotate the map, close the panel or switch the plugin off.
* If the server says it is rate limited, Play pauses with the warning icon and carries on by itself after at most a minute, or when you press Play.

## Tile loading and pacing

* Play loads the next frame while the current one is shown, and only that one.
* The first pass over the frames loads every visible tile of every layer that is on (about 20 tiles per layer and frame on a 1900 by 1400 screen), and the plugin paces it to about 180 tiles a minute so the relay limits are not hit.
* With several layers on, the first pass can therefore take minutes (about 6 with Clouds, Rain Regional and Radar and the forecast on a 1900 by 1400 screen). While Play waits, the time label stays on the frame that is shown.
* The second pass is served from the browser cache and runs at full speed.
* **Sharper** tiles need about four times as many requests, so with several layers on the pacing may not be enough to stay under the relay limit. Play then pauses as described under Play.

## Weather Settings

* The **Weather Settings** menu entry is in the right-side menu, or reached with the gear in the panel. Its window is titled Weather Settings.
* Opacity is set per layer (Rain Regional and Rain Global separately).
* There is one colour palette for both Rain layers and one for Radar. The palettes are named, with a light-to-heavy colour strip under each dropdown for rain and snow. The Radar strip shows snow only while the next option is on.
* **Show snow separately on radar**: when off, all radar precipitation is drawn as rain. The Rain layers always show snow.
* Map tile sharpness: Sharper loads about 4x the tiles, and Play loads more of them.
* The settings page also explains the layers (Rain Regional shows precipitation and its forecast wherever weather radar coverage exists, Rain Global covers the whole world) and the timeline.

### Time zone labels

The zone is shown after the time in the timeline:

* New Zealand: NZDT or NZST, decided for each frame's own time, so it is right across a daylight saving change.
* UTC.
* This device: the short name your browser gives the device zone (for example PDT or CEST), or a form like GMT+13 if it has no name.

### Settings saved by earlier versions

* Settings saved by an earlier version (one Rain choice: Off, Regional or Global) are converted once to the two Rain toggles.
* Rain and radar use colour palette 4 (Nexrad) by default. A stored default of palette 0 from an earlier version is switched to 4 once; other choices are kept, and a palette 0 you pick afterwards stays.

## Other plugins

* The weather panel has nothing to lose, so when another plugin opens its own panel at the bottom of the map (for example Rubber Sheet), the weather panel closes. The layers stay on and the dot appears on the button. It does not reopen by itself.
* The plugins tell each other through two events on `window`, `cloudtak-plugin:panel-open` and `cloudtak-plugin:panel-close`.
* Pressing Escape is left to an open modal dialog such as the image editor.
