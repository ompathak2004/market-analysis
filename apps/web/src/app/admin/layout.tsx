import type { ReactNode } from "react";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "contents" }} data-clarity-mask="true">
      {children}
    </div>
  );
}
