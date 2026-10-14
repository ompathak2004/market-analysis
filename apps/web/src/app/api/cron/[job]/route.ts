import { json } from "@/server/http/respond";

export const dynamic = "force-dynamic";

const gone = () =>
  json(
    {
      error: {
        code: "GONE",
        message: "cron routes were retired; the worker runs every schedule (see docs/ops.md)",
      },
    },
    410,
  );

export const GET = gone;
export const POST = gone;
