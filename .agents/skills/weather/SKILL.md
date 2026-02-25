---
name: weather
description: Get current weather and forecasts (no API key required).
homepage: https://wttr.in/:help
metadata: {"openclaw":{"emoji":"weather","requires":{"bins":["curl"]}}}
---

# Weather

Two free services, no API keys needed.

## wttr.in (primary)

Quick one-liner:

```bash
curl -s "https://wttr.in/London?format=3"
# Output: London: Cloudy +8C
```

Compact format:

```bash
curl -s "https://wttr.in/London?format=%l:+%c+%t+%h+%w"
# Output: London: Cloudy +8C 71% 5km/h
```

Full forecast:

```bash
curl -s -L --retry 2 --retry-delay 1 "https://wttr.in/London?T"
```

Format codes: `%c` condition, `%t` temp, `%h` humidity, `%w` wind, `%l` location, `%m` moon

Tips:

- URL-encode spaces: `wttr.in/New+York`
- Airport codes: `wttr.in/JFK`
- Units: `?m` (metric) `?u` (USCS)
- Today only: `?1`, Current only: `?0`
- PNG: `curl -s "wttr.in/Berlin.png" -o /tmp/weather.png`

## Open-Meteo (fallback, JSON)

Free, no key, good for programmatic use:

```bash
curl -s "https://api.open-meteo.com/v1/forecast?latitude=51.5&longitude=-0.12&current_weather=true"
```

Find coordinates for a city, then query. Returns JSON with temp, windspeed, weathercode.

Docs: https://open-meteo.com/en/docs
