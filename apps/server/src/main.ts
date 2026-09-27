import { buildApp } from "./app.js";
import { closeAppContext, createAppContext } from "./context.js";

const ctx = createAppContext("api");
const app = buildApp(ctx);

const shutdown = async (signal: string) => {
  ctx.logger.info({ signal }, "shutting down");
  await app.close();
  await closeAppContext(ctx);
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: ctx.config.API_PORT, host: "0.0.0.0" });
