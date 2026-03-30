import { cmd } from "./cmd";
import "../config/detectors";
import { readConfigFile, writeConfigFile } from "../config";
import { detectProject } from "../config/detect";

export const InitConfigCommand = cmd({
  command: "init",
  describe: "init devver config in current directory",
  async handler() {
    const existing = readConfigFile();
    if (existing) {
      console.log("✓ Config file already exists (.devver.yaml)");
      return;
    }

    const detection = await detectProject();

    console.log("\nProject detection:");
    if (detection.results.length === 0) {
      console.log("  No frameworks detected");
    } else {
      for (const result of detection.results) {
        console.log(`  ✓ ${result.detected.displayName}`);
      }
    }

    if (detection.results.length > 0) {
      writeConfigFile(detection);
    } else {
      writeConfigFile(detection);
      console.log("  (config file created anyway)");
    }
  },
});
