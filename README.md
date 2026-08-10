# Stratum

Stratum is a personal Home Assistant automation and dashboard workbench made by Synork. It combines a constrained AI agent, a complete local entity index, reviewable changes, and visual dashboard inspection.

The interaction shell is adapted from OpenCode's MIT-licensed web application patterns. Stratum is an independent project and is not affiliated with the OpenCode team.

## Included in the first build

- React workbench with Plan and Build modes
- Complete Home Assistant entity registry, including disabled entities
- Area and device context
- Read-only entity search tools for the agent
- Local automation and Lovelace dashboard proposals
- Reviewed helper creation for input booleans, numbers, text, selects, date/time, counters, timers, and schedules
- Entity-reference validation before approval
- Explicit publish and reject actions
- Revision snapshots before publishing
- Hidden dashboard previews
- Phone, tablet, and desktop rendering with browser-console capture
- Vision-model dashboard review
- Public web fetching with private-network and response-size protections
- SynorkAi-backed web search
- Read-only GitHub repository search, browsing, and file access
- Persisted thread compaction with full transcript retention and repeatable summary checkpoints
- OpenAI, Anthropic, OpenRouter, Azure AI Foundry, Amazon Bedrock, SynorkAi, custom OpenAI-compatible, and Ollama-compatible providers

## Principles

- Read broadly, write narrowly.
- Never expose provider credentials to the browser or model context.
- Run local reference checks and require exact configuration review before publishing.
- Preview and approve changes before publishing.
- Capture a revision snapshot before publishing an existing resource.
- Treat dashboard screenshots as evidence, not decoration.

## Development

Requires Node.js 24 or newer.

```bash
npm install
npm run dev
```

The server defaults to `http://localhost:8099`. In development it proxies Vite; production serves the built React application.

## Local Home Assistant app

This repository is laid out as a local Home Assistant app. Place the repository at:

```text
/var/lib/homeassistant/apps/local/loom
```

Refresh the local app store, build Stratum, set the Home Assistant frontend URL, and open it through Ingress. Home Assistant injects the Supervisor token at runtime; do not add a long-lived token to the repository.

Provider credentials are stored in `/config/loom.db` inside the app configuration mount with mode `0600`. They are never returned by the browser API.

GitHub public repositories work without configuration. Set the optional `github_token` app option to access repositories permitted by that token and receive higher API rate limits. Web search requires a configured SynorkAi provider; generic web fetch does not.

## Safety boundary

The model can inspect the full entity inventory but receives task-relevant context through structured tools. Automation and dashboard writes are unavailable as direct model tools: the model can only create local proposals. Publishing is a separate user-approved backend operation.
