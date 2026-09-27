import { describe, expect, it } from "vitest";
import { parseTrendlyneReports } from "./trendlyne.js";

const row = (postHref: string) => `
<table><tbody><tr>
  <td></td><td data-sort="25 Sep 2026">25 Sep 2026</td>
  <td><a href="https://trendlyne.com/research-reports/stock/2242832/INDGN/indegene-ltd/">Indegene</a></td>
  <td><a href="#">ICICI Direct</a></td><td></td><td>750.00</td><td>608.95</td><td>23.2</td><td>Buy</td>
  <td><a href="${postHref}">post</a></td><td></td><td></td>
</tr></tbody></table>`;

describe("parseTrendlyneReports", () => {
  it("parses a row and stores an absolute report url", () => {
    const [call] = parseTrendlyneReports(row("/posts/5860286/centum-electronics-ltd"));
    expect(call).toMatchObject({
      nseSymbol: "INDGN",
      broker: "ICICI Direct",
      publishedAt: "2026-09-25",
      rating: "Buy",
      targetPrice: 750,
      priceAtCall: 608.95,
      reportUrl: "https://trendlyne.com/posts/5860286/centum-electronics-ltd",
    });
  });

  it("keeps absolute urls unchanged", () => {
    const [call] = parseTrendlyneReports(row("https://trendlyne.com/posts/1/x"));
    expect(call?.reportUrl).toBe("https://trendlyne.com/posts/1/x");
  });
});
