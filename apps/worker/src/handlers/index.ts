import type { HandlerMap } from "../registry.js";
import { altdataHandlers } from "./altdata.js";
import { documentHandlers } from "./documents.js";
import { influenceHandlers } from "./influence.js";
import { insightHandlers } from "./insights.js";
import { intelHandlers } from "./intel.js";
import { maintenanceHandlers } from "./maintenance.js";
import { marketHandlers } from "./market.js";
import { opsHandlers } from "./ops.js";
import { precisionHandlers } from "./precision.js";
import { priceHandlers } from "./prices.js";
import { relationshipHandlers } from "./relationships.js";
import { relationshipFactHandlers } from "./relationships-facts.js";
import { relationshipLlmHandlers } from "./relationships-llm.js";
import { researchHandlers } from "./research.js";

export const HANDLERS: HandlerMap = {
  ...marketHandlers,
  ...priceHandlers,
  ...relationshipHandlers,
  ...relationshipLlmHandlers,
  ...precisionHandlers,
  ...relationshipFactHandlers,
  ...intelHandlers,
  ...researchHandlers,
  ...influenceHandlers,
  ...insightHandlers,
  ...altdataHandlers,
  ...documentHandlers,
  ...opsHandlers,
  ...maintenanceHandlers,
};
