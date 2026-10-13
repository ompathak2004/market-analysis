import { createLogger, isoDate, loadServiceConfig } from "@ma/core";
import { closeDb, companies, createDb } from "@ma/db";
import { refreshEstimates } from "./estimates.js";
import { eventImpact } from "./exposure.js";
import { refreshMomentumSignals } from "./momentum.js";
import { refreshRiskSignals } from "./risk.js";

const config = loadServiceConfig();
const logger = createLogger("intel-cli", config.LOG_LEVEL);
const db = createDb(config.DATABASE_URL, 4);
const [cmd, ...args] = process.argv.slice(2);
const asOf = isoDate(new Date());

try {
  switch (cmd) {
    case "estimates":
      logger.info({ written: await refreshEstimates(db, asOf) }, "estimates refreshed");
      break;
    case "momentum":
      logger.info(
        { written: await refreshMomentumSignals(db, asOf) },
        "momentum signals refreshed",
      );
      break;
    case "risk": {
      const ids = (await db.select({ id: companies.id }).from(companies)).map((c) => c.id);
      logger.info({ written: await refreshRiskSignals(db, ids, asOf) }, "risk signals refreshed");
      break;
    }
    case "event": {
      const [id, from, to] = args;
      console.log(
        JSON.stringify(await eventImpact(db, Number(id), from ?? asOf, to ?? asOf), null, 2),
      );
      break;
    }
    default:
      console.log("usage: cli <estimates|momentum|risk|event> [args]");
  }
} finally {
  await closeDb(db);
}
