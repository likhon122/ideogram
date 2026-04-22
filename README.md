# Ideogram TypeScript Batch Generator (Generate + Super-Res + 4K/8K Download)

This project reproduces the same API flow captured in `ideogram.ai.har`:

1. Generate image: `POST /api/images/sample`
2. Poll status: `POST /api/gallery/retrieve-requests`
3. Trigger super-res upscale: `POST /api/images/sample` with `parent.type = "SUPER_RES"`
4. Download image: `GET /api/download/response/{responseId}/image?resolution=4K|8K`

Outputs are saved locally inside this workspace under `outputs/<run_timestamp>/`.

## Project Structure

```text
src/
  client/
    ideogramClient.ts     # Raw API calls
  core/
    workflow.ts           # End-to-end pipeline for one prompt
  types/
    ideogram.ts           # Request/response TypeScript types
  utils/
    files.ts              # File helpers
    logger.ts             # Console log formatter
  config.ts               # Environment configuration
  index.ts                # Batch CLI entrypoint
prompts/
  prompts.txt             # One prompt per line
docs/
  api-map.md              # HAR-derived endpoint + payload map
outputs/                  # Generated files + run reports
```

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy env template and fill values:

```bash
copy .env.example .env
```

Required minimum values in `.env`:

- `IDEOGRAM_USER_ID`
- `IDEOGRAM_COOKIE` (if your session requires cookie auth)
- `IDEOGRAM_ORG` (captured as `x-ideo-org`)

## Running

### Batch from prompts file

```bash
npm run generate -- --prompts-file prompts/prompts.txt --concurrency 2
```

### Single prompt

```bash
npm run generate -- --prompt "A cinematic emergency room close-up with dramatic lighting" --concurrency 1
```

### Start in 4K mode

```bash
npm run start:4k
```

### Start in 8K mode

```bash
npm run start:8k
```

### Quality mode with normal start command

```bash
npm run start -- 8k
```

or

```bash
npm run start -- --quality 8k
```

### Multiple inline prompts

```bash
npm run generate -- --prompt "Prompt one" --prompt "Prompt two" --concurrency 2
```

## Output

Each run creates:

- Images: `outputs/<timestamp>/*.png|jpg|webp`
- Run report: `outputs/<timestamp>/run-report.json`

The report includes success/failure summary and all request/response IDs for traceability.

## Notes

- HAR exports sometimes hide auth cookies/tokens. If you get 401/403, update `.env` auth values.
- On HTTP 403, the client now retries through a real local browser session (Chrome/Edge) to reduce Cloudflare bot blocks.
- Keep `IDEOGRAM_ENABLE_BROWSER_FALLBACK=true` and set `IDEOGRAM_BROWSER_EXECUTABLE_PATH` if auto-detection fails.
- A quota preflight request runs at startup (`IDEOGRAM_ENABLE_QUOTA_PREFLIGHT=true`) to validate session access before batch generation.
- Super-res request payload is modeled from captured traffic and now changes by mode:
  - 4K mode: `upscale_factor=X4`
  - 8K mode: `upscale_factor=X8`
- Download endpoint uses the super-res `response_id` and selected resolution (`4K` or `8K`).
