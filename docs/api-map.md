# Ideogram HAR API Map

This project reproduces the same request chain observed in [ideogram.ai.har](../ideogram.ai.har).

## 1) Generate Base Image

- Endpoint: `POST /api/images/sample`
- URL: `https://ideogram.ai/api/images/sample`
- Payload shape (captured):

```json
{
  "prompt": "...",
  "user_id": "lFJrDL4wSMOFa7wfMdI5UA",
  "private": true,
  "model_version": "V_3_1",
  "model_uri": "model/V_3_1/version/0",
  "use_autoprompt_option": "ON",
  "sampling_speed": -2,
  "character_reference_parents": [],
  "product_reference_parents": [],
  "resolution": { "width": 1312, "height": 736 },
  "num_images": 1,
  "style_type": "AUTO",
  "category_id": "BqEAaCr-T-eH52OvESCHrw"
}
```

## 2) Poll Generation Status

- Endpoint: `POST /api/gallery/retrieve-requests`
- URL: `https://ideogram.ai/api/gallery/retrieve-requests`
- Payload:

```json
{
  "request_ids": ["<request_id>"]
}
```

- Wait until: `sampling_requests[0].is_completed === true`
- Read result id from: `sampling_requests[0].responses[0].response_id`

## 3) Trigger Super-Resolution (Upscale)

- Endpoint: `POST /api/images/sample`
- URL: `https://ideogram.ai/api/images/sample`
- Request type is inferred by payload `parent.type = "SUPER_RES"`.
- Payload shape (captured):

```json
{
  "prompt": "<base response prompt>",
  "user_id": "lFJrDL4wSMOFa7wfMdI5UA",
  "private": true,
  "model_version": "AUTO",
  "model_uri": "model/AUTO/version/0",
  "use_autoprompt_option": "OFF",
  "sampling_speed": -2,
  "parent": {
    "request_id": "<base request_id>",
    "response_id": "<base response_id>",
    "weight": 100,
    "type": "SUPER_RES"
  },
  "upscale_factor": "X4",
  "resolution": { "width": 1312, "height": 736 },
  "num_images": 1,
  "style_type": "AUTO",
  "internal": true,
  "category_id": "BqEAaCr-T-eH52OvESCHrw"
}
```

- Poll again with `/api/gallery/retrieve-requests` using the super-res `request_id`.

## 4) Download 4K Result

- Endpoint: `GET /api/download/response/{responseId}/image?resolution=4K`
- Example captured URL:

```text
https://ideogram.ai/api/download/response/imbc3PFZRD2QRpEXAvya2Q/image?resolution=4K
```

- Save the binary response as image bytes.

## Key Headers Observed

- `accept: */*`
- `content-type: application/json` (POST only)
- `origin: https://ideogram.ai`
- `referer: https://ideogram.ai/library/my-images` or generation detail page
- `user-agent: Mozilla/5.0 ...`
- `x-ideo-org: r2AQ-Mr3QUqo198XsOmg4g`
- `x-request-id: <unique request id>`
- `x-amplitude-session-id: <session timestamp>`

Some HAR exports omit auth cookies/tokens. This project supports injecting them via `.env`.
