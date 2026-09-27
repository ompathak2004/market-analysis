import { redirect } from "next/navigation";

export default async function CompanyIndex({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  redirect(`/c/${symbol.toUpperCase()}/des`);
}
