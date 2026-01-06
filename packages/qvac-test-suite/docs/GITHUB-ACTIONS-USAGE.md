# GitHub Actions Usage

## For External Repos

See `docs/sdk-workflow-example.yml` - copy to your repo as `.github/workflows/qvac-tests.yml`.

## Required Secrets

Add these to your GitHub repo settings:

```
MQTT_PROTOCOL=mqtts
MQTT_HOST=your-broker.example.com
MQTT_PORT=8883
MQTT_USERNAME=github-actions
MQTT_PASSWORD=***
```

### Optional: TLS Certificates

For custom CA or client certificates, add the PEM file contents as secrets:

```bash
# Store entire PEM file content as secret
MQTT_CA_CERT=$(cat ca.crt)
MQTT_CLIENT_CERT=$(cat client.crt)
MQTT_CLIENT_KEY=$(cat client.key)
```

The workflow writes these to `/tmp/mqtt-certs/` and sets environment variables automatically.

## How It Works

1. **Build consumer once** (ubuntu-latest) - cross-platform build cached
2. **Run per platform** - downloads cached consumer
3. **Consumer runs in background** - registers with broker
4. **Producer runs in foreground** - orchestrates tests, waits for completion
5. **Results uploaded** - per-platform JSON reports as artifacts

## Customization

### Subset of Platforms

```yaml
with:
  platforms: '["ubuntu-latest", "macos-latest"]'  # Skip Windows
```

### Subdirectory Tests

```yaml
with:
  working-directory: 'tests/integration'
```

### Self-Signed Certs

Set `rejectUnauthorized: false` in your `qvac-test.config.js`.
