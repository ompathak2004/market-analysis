import { beforeEach, describe, expect, it, vi } from "vitest";
import { pdfToText } from "./documents.js";

const mock = vi.hoisted(() => ({ proxy: vi.fn() }));
vi.mock("unpdf", () => ({ getDocumentProxy: mock.proxy }));

beforeEach(() => vi.clearAllMocks());

describe("PDF text resource lifecycle", () => {
  it("reads pages sequentially, preserves text and releases page and document resources", async () => {
    const cleanup = vi.fn();
    const destroy = vi.fn();
    let active = 0;
    let peak = 0;
    const getPage = vi.fn(async (n: number) => {
      active++;
      peak = Math.max(peak, active);
      return {
        getTextContent: async () => ({ items: [{ str: `Page ${n}`, hasEOL: true }] }),
        cleanup: () => {
          active--;
          cleanup();
        },
      };
    });
    mock.proxy.mockResolvedValue({ numPages: 3, getPage, loadingTask: { destroy } });
    expect(await pdfToText(new Uint8Array())).toEqual({
      text: "Page 1\n\nPage 2\n\nPage 3",
      pageMap: [
        { page: 1, start: 0, end: 6 },
        { page: 2, start: 8, end: 14 },
        { page: 3, start: 16, end: 22 },
      ],
    });
    expect(peak).toBe(1);
    expect(cleanup).toHaveBeenCalledTimes(3);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("destroys the PDF even when text extraction fails", async () => {
    const destroy = vi.fn();
    mock.proxy.mockResolvedValue({
      numPages: 1,
      getPage: vi.fn().mockRejectedValue(new Error("bad page")),
      loadingTask: { destroy },
    });
    await expect(pdfToText(new Uint8Array())).rejects.toThrow("bad page");
    expect(destroy).toHaveBeenCalledOnce();
  });
});
