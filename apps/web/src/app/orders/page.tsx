import type { Metadata } from "next";
import { OrderFlowView } from "@/components/orders/order-flow";
import { Pane } from "@/components/ui/pane";
import { getContext } from "@/server/context";
import { ORDER_FLOW_MONTHS, type OrderFlowMonths, orderFlow } from "@/server/queries/orders";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Order flow · MA Terminal",
  description:
    "Who orders from whom in India: buyer-to-contractor map of order wins disclosed to NSE, each linked to its filing.",
};

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>;
}) {
  const { m } = await searchParams;
  const months = (ORDER_FLOW_MONTHS.find((x) => String(x) === m) ?? 12) as OrderFlowMonths;
  try {
    const flow = await orderFlow(getContext(), months);
    return (
      <div className="grid grid-orders">
        <OrderFlowView flow={flow} />
      </div>
    );
  } catch {
    return (
      <div className="grid grid-orders">
        <Pane id="orders" title="ORDER FLOW" meta="unavailable" pad>
          <p className="muted">Order data is unavailable right now. Try again shortly.</p>
        </Pane>
      </div>
    );
  }
}
