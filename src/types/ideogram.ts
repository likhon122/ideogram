export interface Resolution {
  width: number;
  height: number;
}

export interface GenerateImagePayload {
  prompt: string;
  user_id: string;
  private: boolean;
  model_version: string;
  model_uri: string;
  use_autoprompt_option: "ON" | "OFF" | "AUTO";
  sampling_speed: number;
  character_reference_parents: unknown[];
  product_reference_parents: unknown[];
  resolution: Resolution;
  num_images: number;
  style_type: string;
  category_id?: string;
}

export interface SuperResPayload {
  prompt: string;
  user_id: string;
  private: boolean;
  model_version: string;
  model_uri: string;
  use_autoprompt_option: "ON" | "OFF" | "AUTO";
  sampling_speed: number;
  parent: {
    request_id?: string;
    response_id?: string;
    image_id?: string;
    weight: number;
    type: "SUPER_RES";
  };
  upscale_factor: string;
  resolution: Resolution;
  num_images: number;
  style_type: string;
  internal: boolean;
  category_id?: string;
}

export interface SampleResponse {
  user_id: string;
  caption: string;
  request_id: string;
  response_ids: string[];
  status: string | null;
}

export interface SamplingResponseItem {
  response_id: string;
  prompt: string;
  response_index?: number;
}

export interface SamplingRequestStatus {
  request_id: string;
  request_type: string;
  is_completed: boolean;
  is_errored: boolean;
  completion_percentage?: number;
  model_version?: string;
  model_uri?: string;
  can_upscale?: boolean;
  max_upscale_factor?: number;
  image_resolution?: string;
  width?: number;
  height?: number;
  responses: SamplingResponseItem[];
}

export interface RetrieveRequestsResponse {
  sampling_requests: SamplingRequestStatus[];
}

export interface DownloadResult {
  bytes: Buffer;
  contentType: string;
}

export interface RunResult {
  promptIndex: number;
  prompt: string;
  initialRequestId: string;
  initialResponseId: string;
  superResRequestId: string;
  superResResponseId: string;
  outputPath: string;
}

export interface UploadResponse {
  success: boolean;
  id: string;
  file_name: string;
  error_message?: string;
  asset_id?: string;
  canvas_transaction_id?: string;
}

export interface UploadMetadataResponse {
  image_id: string;
  height: number;
  width: number;
  image_resolution: string;
  max_upscale_factor: number;
  aspect_ratio?: string;
  format?: string;
  upload_type?: string;
}
