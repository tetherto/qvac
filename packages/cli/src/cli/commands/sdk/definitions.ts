// Shared command metadata: safe to load under Node, Bare and standalone builds.
export interface SdkOption {
  spec: string
  description: string
  default?: string | string[]
  multiple?: boolean
  required?: boolean
}
export interface SdkDefinition {
  name: string
  description: string
  options: SdkOption[]
  children: SdkDefinition[]
  action?: string
}
export const SDK: SdkDefinition = {
  name: 'sdk',
  options: [],
  children: [
    {
      name: 'bundle',
      options: [],
      children: [
        {
          name: 'sdk',
          options: [
            {
              spec: '-c, --config <path>',
              description: 'Config file path (default: auto-detect qvac.config.*)'
            },
            {
              spec: '--sdk-path <path>',
              description: 'Path to SDK package (default: auto-detect in node_modules)'
            },
            {
              spec: '--host <target>',
              description: 'Target host (repeatable)',
              multiple: true,
              default: []
            },
            {
              spec: '--defer <module>',
              description: 'Defer a module (repeatable)',
              multiple: true,
              default: []
            },
            {
              spec: '--no-install',
              description:
                'Do not install missing addon platform packages for mobile hosts into package.json'
            },
            {
              spec: '-q, --quiet',
              description: 'Minimal output'
            },
            {
              spec: '-v, --verbose',
              description: 'Detailed output'
            },
            {
              spec: '--offline',
              description: 'Skip GitHub and npm registry lookups in the engines.bare check'
            }
          ],
          children: [],
          description: 'Generate a tree-shaken Bare worker bundle with selected plugins',
          action: 'bundle_sdk_0'
        }
      ],
      description: 'Bundle QVAC artifacts for different runtimes'
    },
    {
      name: 'configure',
      options: [
        {
          spec: '-c, --config <path>',
          description: 'Config file to write (default: ./qvac.config.json)'
        },
        {
          spec: '-y, --yes',
          description: 'Non-interactive: write a sensible default starter (chat + transcription)'
        },
        {
          spec: '--modality <name>',
          description:
            'Non-interactive: add a modality (repeatable) — chat|embedding|transcription|speech|image|decision',
          multiple: true,
          default: []
        },
        {
          spec: '--force',
          description: 'Re-add a model that is already configured, overwriting its existing entry'
        },
        {
          spec: '-q, --quiet',
          description: 'Suppress output'
        }
      ],
      children: [],
      description: 'Interactively build a qvac.config.json (serve.models) for local models',
      action: 'configure_0'
    },
    {
      name: 'doctor',
      options: [
        {
          spec: '--deep',
          description: 'Start the installed SDK worker and verify its heartbeat'
        },
        {
          spec: '--json',
          description: 'Output the report as JSON'
        },
        {
          spec: '-q, --quiet',
          description: 'Suppress human-readable output (only set exit code)'
        },
        {
          spec: '-v, --verbose',
          description: 'Detailed output'
        },
        {
          spec: '--offline',
          description: 'Skip GitHub and npm registry lookups in the engines.bare check'
        }
      ],
      children: [],
      description: 'Validate that the host satisfies QVAC SDK system requirements',
      action: 'doctor_0'
    },
    {
      name: 'openai',
      options: [],
      children: [
        {
          name: 'coverage',
          options: [
            {
              spec: '--json',
              description: 'Output JSON report'
            },
            {
              spec: '--unsupported',
              description: 'List only unsupported endpoints'
            },
            {
              spec: '--unknown',
              description: 'List only uncategorized (unknown) endpoints'
            },
            {
              spec: '--primary-ai',
              description:
                'Restrict to spec-derived primary AI inference surface (Chat, Audio, Images, …)'
            },
            {
              spec: '--consumer-primary',
              description: 'Restrict to consumer-demanded primary AI surface'
            },
            {
              spec: '--offline',
              description: 'Use cached OpenAPI spec (~/.cache/qvac/openai-spec.yaml)'
            }
          ],
          children: [],
          description: 'Show OpenAI endpoint coverage for qvac serve --openai',
          action: 'openai_0'
        },
        {
          name: 'spec',
          options: [
            {
              spec: '-o, --output <path>',
              description: 'Write to file instead of stdout'
            },
            {
              spec: '--yaml',
              description: 'Emit YAML instead of JSON'
            }
          ],
          children: [],
          description:
            'Emit the OpenAPI spec for qvac serve --openai (without starting the server)',
          action: 'openai_1'
        }
      ],
      description: 'OpenAI adapter introspection'
    },
    {
      name: 'serve',
      options: [
        {
          spec: '--no-default',
          description: 'Do not mount the default surface'
        },
        {
          spec: '--openai',
          description: 'Mount the OpenAI-compatible REST API'
        },
        {
          spec: '-c, --config <path>',
          description: 'Config file path (default: auto-detect qvac.config.*)'
        },
        {
          spec: '-p, --port <number>',
          description: 'Port to listen on',
          default: '11434'
        },
        {
          spec: '-H, --host <address>',
          description: 'Host to bind to',
          default: '127.0.0.1'
        },
        {
          spec: '--model <alias>',
          description: 'Model alias to preload (repeatable, must be in config)',
          multiple: true,
          default: []
        },
        {
          spec: '--api-key <key>',
          description: 'Require Bearer token authentication'
        },
        {
          spec: '--api-key-file <path>',
          description:
            'Read the Bearer token from a file instead of argv (keeps it out of the process list)'
        },
        {
          spec: '--allow-unauthenticated',
          description: 'Permit binding to a non-loopback host without an API key'
        },
        {
          spec: '--cors',
          description: 'Validate that explicit trusted CORS origins are configured'
        },
        {
          spec: '--cors-origin <origin>',
          description: 'Trusted CORS origin (repeatable)',
          multiple: true,
          default: []
        },
        {
          spec: '--allowed-host <host>',
          description:
            'Accept this Host header besides loopback, IP addresses and the bind host; .example.com covers subdomains (repeatable)',
          multiple: true,
          default: []
        },
        {
          spec: '--allow-any-host',
          description: 'Accept any Host header (turns off DNS-rebinding protection)'
        },
        {
          spec: '--public-base-url <url>',
          description: 'Externally reachable origin (required for image response_format=url)'
        },
        {
          spec: '--docs',
          description:
            'Expose API explorer at /docs and add same-port loopback CORS origins; requires a fixed --port (JSON spec is always at /openapi.json)'
        },
        {
          spec: '--no-lazy-load',
          description:
            'Disable lazy loading; a request for an unloaded model returns 503 model_not_loaded instead of loading it'
        },
        {
          spec: '--load-concurrency <n>',
          description: 'Max simultaneous model loads (default: 1)'
        },
        {
          spec: '--load-timeout <ms>',
          description: 'Per-load timeout in milliseconds (default: unbounded)'
        },
        {
          spec: '--no-cancel-load-on-disconnect',
          description: 'Keep loading a model even if the client that triggered the load disconnects'
        },
        {
          spec: '--ready-fd <fd>',
          description:
            'Write the bound port to this inherited descriptor once listening (for supervisors using --port 0)'
        },
        {
          spec: '-v, --verbose',
          description: 'Detailed output'
        }
      ],
      children: [
        {
          name: 'openai',
          options: [
            {
              spec: '-c, --config <path>',
              description: 'Config file path (default: auto-detect qvac.config.*)'
            },
            {
              spec: '-p, --port <number>',
              description: 'Port to listen on',
              default: '11434'
            },
            {
              spec: '-H, --host <address>',
              description: 'Host to bind to',
              default: '127.0.0.1'
            },
            {
              spec: '--model <alias>',
              description: 'Model alias to preload (repeatable, must be in config)',
              multiple: true,
              default: []
            },
            {
              spec: '--api-key <key>',
              description: 'Require Bearer token authentication'
            },
            {
              spec: '--api-key-file <path>',
              description:
                'Read the Bearer token from a file instead of argv (keeps it out of the process list)'
            },
            {
              spec: '--allow-unauthenticated',
              description: 'Permit binding to a non-loopback host without an API key'
            },
            {
              spec: '--cors',
              description: 'Validate that explicit trusted CORS origins are configured'
            },
            {
              spec: '--cors-origin <origin>',
              description: 'Trusted CORS origin (repeatable)',
              multiple: true,
              default: []
            },
            {
              spec: '--allowed-host <host>',
              description:
                'Accept this Host header besides loopback, IP addresses and the bind host; .example.com covers subdomains (repeatable)',
              multiple: true,
              default: []
            },
            {
              spec: '--allow-any-host',
              description: 'Accept any Host header (turns off DNS-rebinding protection)'
            },
            {
              spec: '--public-base-url <url>',
              description: 'Externally reachable origin (required for image response_format=url)'
            },
            {
              spec: '--docs',
              description:
                'Expose API explorer at /docs and add same-port loopback CORS origins; requires a fixed --port (JSON spec is always at /openapi.json)'
            },
            {
              spec: '--no-lazy-load',
              description:
                'Disable lazy loading; a request for an unloaded model returns 503 model_not_loaded instead of loading it'
            },
            {
              spec: '--load-concurrency <n>',
              description: 'Max simultaneous model loads (default: 1)'
            },
            {
              spec: '--load-timeout <ms>',
              description: 'Per-load timeout in milliseconds (default: unbounded)'
            },
            {
              spec: '--no-cancel-load-on-disconnect',
              description:
                'Keep loading a model even if the client that triggered the load disconnects'
            },
            {
              spec: '--ready-fd <fd>',
              description:
                'Write the bound port to this inherited descriptor once listening (for supervisors using --port 0)'
            },
            {
              spec: '-v, --verbose',
              description: 'Detailed output'
            }
          ],
          children: [],
          description:
            'Deprecated: start the OpenAI-compatible REST API server with `qvac serve --openai --no-default`',
          action: 'serve_1'
        }
      ],
      description: 'Start an API server backed by QVAC',
      action: 'serve_0'
    },
    {
      name: 'verify',
      options: [],
      children: [
        {
          name: 'deps',
          options: [
            {
              spec: '--base <ref>',
              description: 'Base git ref or SHA',
              required: true
            },
            {
              spec: '--head <ref>',
              description: 'Head git ref or SHA',
              required: true
            },
            {
              spec: '--lockfile <path>',
              description: 'Path to npm package-lock.json',
              default: 'package-lock.json'
            },
            {
              spec: '-q, --quiet',
              description: 'Suppress output when there are no native changes'
            }
          ],
          children: [],
          description: 'Detect native addon changes between two npm lockfile refs',
          action: 'verify_0'
        },
        {
          name: 'bundle',
          options: [
            {
              spec: '--addons-source <path>',
              description: 'Path to a worker.bundle.js or a node_modules directory',
              required: true
            },
            {
              spec: '--host <target>',
              description: 'Target host (repeatable, at least one required)',
              multiple: true,
              default: []
            },
            {
              spec: '--bare-runtime-version <semver>',
              description: 'Override detected Bare runtime version for ABI checks'
            },
            {
              spec: '-c, --config <path>',
              description: 'Config file path (default: auto-detect qvac.config.*)'
            },
            {
              spec: '--project-root <path>',
              description:
                'Project root used to resolve bundle resolutions and runtime metadata (default: cwd)'
            },
            {
              spec: '--json',
              description: 'Output the verification result as JSON'
            },
            {
              spec: '-q, --quiet',
              description: 'Suppress success output'
            },
            {
              spec: '--offline',
              description:
                'Skip GitHub and npm registry lookups (runtime detection for new react-native-bare-kit releases, override suggestions)'
            }
          ],
          children: [],
          description: 'Verify native addon prebuilds and ABI for a bundle or node_modules tree',
          action: 'verify_1'
        }
      ],
      description: 'Verify QVAC artifacts and dependency changes'
    }
  ],
  description: 'SDK diagnostics, configuration, HTTP API and bundle tools'
}
