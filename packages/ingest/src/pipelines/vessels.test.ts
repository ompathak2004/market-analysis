import { describe, expect, it } from "vitest";
import { parseFleetPage } from "./vessels.js";

const SCI_CARDS = `
<ul class="ab-tab-items">
  <li class="active"><div class="prsntfltinner">
    <div class="prsntfltimg"><a href="#"><img src="x.jpg" alt="" /></a></div>
    <div class="fltname">Desh Bhakt</div>
    <table>
      <tr><td>IMO Number</td><td><b>9232905</b></td></tr>
      <tr><td>Year of Built</td><td><b>2003</b></td></tr>
      <tr><td>Gross Tonnage</td><td><b>61,978</b></td></tr>
      <tr><td>Deadweight</td><td><b>113,913</b></td></tr>
    </table>
  </div></li>
  <li class="active"><div class="prsntfltinner">
    <div class="fltname">Bad Check Digit</div>
    <table>
      <tr><td>IMO Number</td><td><b>9232906</b></td></tr>
      <tr><td>Deadweight</td><td><b>57,127.8</b></td></tr>
    </table>
  </div></li>
  <li class="active"><div class="prsntfltinner">
    <div class="fltname">Swarna Kamal</div>
    <table>
      <tr><td>IMO Number</td><td><b>9467732</b></td></tr>
      <tr><td>Deadweight</td><td><b>57,127.8</b></td></tr>
    </table>
  </div></li>
</ul>`;

const GENERIC_TABLE = `
<table>
  <tr><th>Vessel</th><th>Type</th><th>IMO</th><th>DWT</th></tr>
  <tr><td>Jag Lok</td><td>Crude tanker</td><td>9232905</td><td>1,05,000</td></tr>
  <tr><td>Jag Leela</td><td>Bulk carrier</td><td>IMO 9467732</td><td>12</td></tr>
</table>`;

describe("parseFleetPage", () => {
  it("reads SCI fleet cards, validating IMOs and rounding deadweight", () => {
    expect(parseFleetPage(SCI_CARDS, "Crude tanker")).toEqual([
      { imo: 9_232_905, name: "DESH BHAKT", dwt: 113_913, type: "Crude tanker" },
      { imo: 9_467_732, name: "SWARNA KAMAL", dwt: 57_128, type: "Crude tanker" },
    ]);
  });

  it("reads generic fleet tables and ignores out-of-range tonnage", () => {
    expect(parseFleetPage(GENERIC_TABLE)).toEqual([
      { imo: 9_232_905, name: "JAG LOK", dwt: 105_000, type: "Crude tanker" },
      { imo: 9_467_732, name: "JAG LEELA", dwt: null, type: "Bulk carrier" },
    ]);
  });
});
