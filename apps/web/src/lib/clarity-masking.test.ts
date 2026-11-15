import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import AdminLayout from "../app/admin/layout";

afterEach(() => vi.unstubAllGlobals());

// Value: protects=admin content renders inside the recording mask;
// fails_when=the mask is removed or placed outside the child subtree; why_new=recorder helpers do not render admin routes;
// seam=none; no_claim=Clarity interpretation of markup (React server rendering only).
it("renders admin children inside the Clarity mask", () => {
  vi.stubGlobal("React", React);
  const html = renderToStaticMarkup(
    AdminLayout({
      children: React.createElement("section", null, "Private review content"),
    }),
  );
  expect(html).toMatch(
    /^<div[^>]*data-clarity-mask="true"[^>]*><section>Private review content<\/section><\/div>$/,
  );
});
