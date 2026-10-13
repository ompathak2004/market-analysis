import { Consumer } from "./consumer.js";
import { createWorkerContext } from "./context.js";

const ctx = createWorkerContext("worker");
const consumer = new Consumer(ctx, (reason) => void stop(reason));

async function stop(reason: string): Promise<never> {
  await consumer.shutdown(reason);
  process.exit(consumer.exitCode);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => void stop(signal));
}
process.on("unhandledRejection", (err) => ctx.logger.error({ err }, "unhandled rejection"));

try {
  await consumer.run();
} catch (err) {
  ctx.logger.error({ err }, "worker failed to start");
  consumer.exitCode = 1;
  await stop("startup failure");
}
