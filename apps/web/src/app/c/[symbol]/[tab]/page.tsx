import { NotFoundError } from "@ma/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { QuoteHeader, QuoteHeaderSkeleton, TabStrip } from "@/components/panes/company/header";
import { type SearchParams, TabView } from "@/components/panes/company/index";
import { Empty } from "@/components/ui/empty";
import { Pane } from "@/components/ui/pane";
import { isTab, TAB_TITLE } from "@/lib/commands";
import { getContext } from "@/server/context";
import { findCompany } from "@/server/queries";

export const dynamic = "force-dynamic";

type Params = Promise<{ symbol: string; tab: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { symbol, tab } = await params;
  const sym = decodeURIComponent(symbol).toUpperCase();
  return { title: `${sym} ${isTab(tab) ? TAB_TITLE[tab] : tab.toUpperCase()} · MA Terminal` };
}

async function inUniverse(symbol: string): Promise<boolean> {
  try {
    await findCompany(getContext(), symbol);
    return true;
  } catch (err) {
    if (err instanceof NotFoundError) return false;
    throw err;
  }
}

export default async function CompanyPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Promise<SearchParams>;
}) {
  const { symbol: raw, tab } = await params;
  if (!isTab(tab)) notFound();
  const symbol = decodeURIComponent(raw).toUpperCase();
  if (!(await inUniverse(symbol)))
    return (
      <div className="grid grid-solo">
        <Pane id="missing" title="NOT IN UNIVERSE" meta={symbol}>
          <Empty title={`${symbol} is not tracked`} hint="⌃K to search · Esc back">
            The terminal covers the NSE universe loaded by the universe job. Search by name or
            symbol, or go <Link href="/">HOME</Link>.
          </Empty>
        </Pane>
      </div>
    );
  const sp = await searchParams;
  return (
    <div className="screen screen-company">
      <Suspense fallback={<QuoteHeaderSkeleton symbol={symbol} />}>
        <QuoteHeader symbol={symbol} />
      </Suspense>
      <TabStrip symbol={symbol} tab={tab} />
      <TabView symbol={symbol} tab={tab} sp={sp} />
    </div>
  );
}
