---
name: weather
description: Get current weather and short forecasts for cities via wttr.in.
tools: [http_request]
allow_list: [https://wttr.in/]
---

# Weather

Use `http_request` with wttr.in for current conditions and short forecasts (max 3 days). Pick the smallest format, the tool output is fed back as your next prompt.

## Format guide

**Default to `?format=3` for any "what's the weather...?" / "what about ...?" / single-location question.** Only escalate to a multi-day form if the user explicitly says "tomorrow", "weekend", "next N days".

- Current / casual -> `?format=3` (one line, smallest)
- Today's forecast -> `?1T`
- Tomorrow / weekend (2 days) -> `?2T`
- Full 3-day forecast -> `?T`

Every wttr.in call MUST end in one of these suffixes. **Never call `https://wttr.in/<location>` with no `?...` suffix** - the bare URL returns a multi-kilobyte response that will overflow the context.

```json
{ "url": "https://wttr.in/London?format=3", "method": "GET" }
{ "url": "https://wttr.in/New+York?2T", "method": "GET" }
```

## Notes

- No API key. Spaces in city -> `+` (e.g. `New+York`). Ask for the location if missing.
- **wttr.in caps at 3 days.** If the user asks for "next week" or longer, say so and offer `?T` (3-day grid). Options like `?7`, `format=11`, `num_of_days=` do not exist.
- Summarize in plain language. Do not claim live weather unless the request succeeded.
