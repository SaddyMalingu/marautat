/**
 * Entry point for Trendjack Hunter
 * Mirrors the structure of Writer's Flow/index.js
 */

import runTrendjackHunter, {
  formatBriefsForWhatsApp,
  getStatistics,
} from "./orchestrator.js";

export default runTrendjackHunter;

export {
  runTrendjackHunter,
  formatBriefsForWhatsApp,
  getStatistics,
};
