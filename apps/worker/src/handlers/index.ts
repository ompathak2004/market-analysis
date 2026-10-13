import type { HandlerMap } from "../registry.js";
import { altdataHandlers } from "./altdata.js";
import { insightHandlers } from "./insights.js";
import { intelHandlers } from "./intel.js";
import { marketHandlers } from "./market.js";
import { opsHandlers } from "./ops.js";
import { relationshipHandlers } from "./relationships.js";
import { researchHandlers } from "./research.js";

export const HANDLERS: HandlerMap = {
  ...marketHandlers,
  ...relationshipHandlers,
  ...intelHandlers,
  ...researchHandlers,
  ...insightHandlers,
  ...altdataHandlers,
  ...opsHandlers,
};
