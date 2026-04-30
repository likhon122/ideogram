import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "./logger.js";

interface TrackingData {
  lastUpdated: string;
  geminiKeyUsage: Record<string, number>;
}

class GeminiTracker {
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
        
        // Ensure geminiKeyUsage exists in case of old format
        if (!parsed.geminiKeyUsage) {
          parsed.geminiKeyUsage = {};
        }
        
        return parsed;
      } catch {
        logger.warn("Could not parse tracking.json, creating fresh data");
      }
    }

    return {
      lastUpdated: new Date().toISOString(),
      geminiKeyUsage: {},
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

  trackGeminiKeyUsage(keyIndex: number): void {
    const keyLabel = `key_${keyIndex}`;
    if (!this.data.geminiKeyUsage[keyLabel]) {
      this.data.geminiKeyUsage[keyLabel] = 0;
    }
    this.data.geminiKeyUsage[keyLabel]++;
    this.save();
  }

  getCurrentTrackingData(): TrackingData {
    return this.data;
  }
}

const tracker = new GeminiTracker();
export default tracker;
