import type { HandlerMap } from "../registry.js";
import { altdataHandlers } from "./altdata.js";
import { documentHandlers } from "./documents.js";
import { insightHandlers } from "./insights.js";
import { intelHandlers } from "./intel.js";
import { marketHandlers } from "./market.js";
import { opsHandlers } from "./ops.js";
import { priceHandlers } from "./prices.js";
import { relationshipHandlers } from "./relationships.js";
import { researchHandlers } from "./research.js";

export const HANDLERS: HandlerMap = {
  ...marketHandlers,
  ...priceHandlers,
  ...relationshipHandlers,
  ...intelHandlers,
  ...researchHandlers,
  ...insightHandlers,
  ...altdataHandlers,
  ...documentHandlers,
  ...opsHandlers,
};
