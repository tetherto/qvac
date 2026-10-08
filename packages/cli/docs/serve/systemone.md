# System One extension

Mount with `qvac serve --systemone`. The extension serves a System One HTTP API
for typed decisions backed by local QVAC models. Every route below lives under
`/v1`.

Server-wide behavior, including authentication, CORS, model loading, cancellation
and `serve.models`, is described in [README.md](README.md) and applies here. This
page covers the routes this extension adds.

## Endpoints

| Method | Path            | Notes                                             |
| ------ | --------------- | ------------------------------------------------- |
| `POST` | `/v1/systemone` | Typed decisions for a single state; blocking JSON |

## `POST /v1/systemone`

System One decision endpoint backed by the SDK's `decide()`. Evaluates one state
with `choice`, `score`, or `noul` questions.

### Loaded model

Requires an alias whose endpoint category is `decision`. Register a Laya decision
checkpoint in `serve.models` with SDK model type `llamacpp-decisions`. An
embedding-only checkpoint cannot answer decision questions.

```bash
qvac configure --modality decision
qvac serve --systemone --no-default
```

`configure` selects `LAYA_MULTILINGUAL_322M_Q8_0` and writes the following entry.
The interactive Decision capability lists the embedding-addon catalog models,
with this Laya checkpoint marked as recommended. Choose a Laya checkpoint for
decisions. The SDK defaults to GPU; set `device` to `cpu` in the parameter editor
or configuration to run on CPU.

```json
{
  "serve": {
    "models": {
      "laya-multilingual-322m-q8-0": {
        "model": "LAYA_MULTILINGUAL_322M_Q8_0",
        "type": "llamacpp-decisions",
        "preload": false
      }
    }
  }
}
```

The first request loads the model. Set `preload: true` or pass
`--model laya-multilingual-322m-q8-0` to load it at startup.

Choose another Laya checkpoint in interactive configuration. To use a local GGUF,
replace `model` with `src` in the entry above and set it to the file path.
When adding a Laya checkpoint through "Search all models", set
`type: 'llamacpp-decisions'` in the JSON editor or configuration.

### Request

Content-Type is `application/json`. Fields:

- `model` (required): configured model alias.
- `state` (required): text, structured JSON, a number, or a boolean. An array is
  one shared context, such as a conversation.
- `questions` (required): question IDs mapped to `choice`, `score`, or `noul`
  questions using the
  [SDK decision contract](https://docs.qvac.tether.io/sdk/ai-capabilities/laya-decisions/).
- `max_len`, `head_max_len` (optional): token budgets.

This endpoint uses the System One request shape. It rejects `states`, `stream`,
and unknown fields. Use SDK `decide({ states, ... })` directly for batch processing.

### Response

The SDK result as JSON, with `model` set to the configured alias, `answers` keyed
by question ID, and `usage` containing token counts and truncation information.
Each answer retains its confidence and probability fields.

The route returns the full result without a token stream. A client disconnect
cancels the SDK request.

### Examples

```bash
curl -sS http://127.0.0.1:11434/v1/systemone \
  -H "Content-Type: application/json" \
  -d '{
    "model": "laya-multilingual-322m-q8-0",
    "state": {"ticket": "I was charged twice. Please refund."},
    "questions": {
      "route": {
        "type": "choice",
        "instructions": "Which queue should receive this ticket?",
        "criteria": {"billing": "Payment issues", "technical": "Software bugs"}
      },
      "urgent": {
        "type": "noul",
        "instructions": "Does this require immediate human attention?"
      }
    }
  }'
```

Point clients that support a configurable System One API origin at
`http://127.0.0.1:11434` and select your configured model alias.
