import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function CompanyIndex({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  redirect(`/c/${encodeURIComponent(decodeURIComponent(symbol).toUpperCase())}/des`);
}
