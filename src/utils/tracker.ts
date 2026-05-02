import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "./logger.js";

interface TrackingData {
  lastUpdated: string;
  apiKeyUsage: Record<string, number>;
  geminiKeyUsage?: Record<string, number>;
}

class ApiKeyTracker {
  private trackingFilePath: string;
  private data: TrackingData;

  constructor() {
    this.trackingFilePath = path.join(process.cwd(), "tracking.json");
    this.data = this.loadOrCreate();
  }

  private loadOrCreate(): TrackingData {
    if (fs.existsSync(this.trackingFilePath)) {
      try {
        const raw = fs.readFileSync(this.trackingFilePath, "utf-8");
        const parsed = JSON.parse(raw) as TrackingData;
        
        // Migrate older tracking files that only stored Gemini usage.
        if (!parsed.apiKeyUsage) {
          parsed.apiKeyUsage = parsed.geminiKeyUsage ?? {};
        }
        
        return parsed;
      } catch {
        logger.warn("Could not parse tracking.json, creating fresh data");
      }
    }

    return {
      lastUpdated: new Date().toISOString(),
      apiKeyUsage: {},
    };
  }

  private save(): void {
    this.data.lastUpdated = new Date().toISOString();
    try {
      fs.writeFileSync(
        this.trackingFilePath,
        JSON.stringify(this.data, null, 2),
        "utf-8"
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to save tracking.json: ${errMsg}`);
    }
  }

  trackApiKeyUsage(keyIndex: number): void {
    const keyLabel = `key_${keyIndex}`;
    if (!this.data.apiKeyUsage[keyLabel]) {
      this.data.apiKeyUsage[keyLabel] = 0;
    }
    this.data.apiKeyUsage[keyLabel]++;
    this.save();
  }

  getCurrentTrackingData(): TrackingData {
    return this.data;
  }
}

const tracker = new ApiKeyTracker();
export default tracker;
