import { NextResponse } from "next/server";
import { ApiError, search } from "@/lib/api";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 1) return NextResponse.json({ results: [] });
  try {
    return NextResponse.json(await search(q));
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 502;
    return NextResponse.json({ results: [], error: (err as Error).message }, { status });
  }
}
