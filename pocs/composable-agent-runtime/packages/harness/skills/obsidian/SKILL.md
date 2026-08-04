---
name: obsidian
description: Manage local Obsidian vault notes through the registered Obsidian CLI.
tools: [exec(obsidian)]
platform: [darwin]
metadata:
  {
    "openclaw":
      {
        "requires":
          {
            "bins": ["obsidian"],
            "binMinVersions": { "obsidian": { "min": "1.12.7", "command": "obsidian version" } }
          },
        "setup":
          {
            "summary": "Obsidian works through the official Obsidian CLI connected to the running desktop app. Requires Obsidian 1.12.7 or newer with the command line interface registered.",
            "routes":
              [
                {
                  "kind": "instructions",
                  "label": "Register the Obsidian CLI",
                  "description": "Requires Obsidian 1.12.7 or newer with the command line interface registered. Keep the app installed.",
                  "helpUrl": "https://help.obsidian.md/cli",
                  "steps":
                    [
                      "Open the Obsidian desktop app and update it to 1.12.7 or newer.",
                      "Go to Settings > General > Advanced and enable Command line interface.",
                      "Click Register CLI to add it to your PATH.",
                      "Reopen this Skills page."
                    ]
                }
              ]
          }
      }
  }
---

# Obsidian

Use this skill to work with a local Obsidian vault through the `obsidian` CLI.
Use one `obsidian` command per `exec` call and do not use direct filesystem tools.
Do not pass `vault=...` or vault discovery commands. The host binds the approved vault.
Preferred read-only examples: `obsidian files`, `obsidian search query=...`, `obsidian read path=...`.
