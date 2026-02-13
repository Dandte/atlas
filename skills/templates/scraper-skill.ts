// Template: Skill que hace scraping de una página web
import type { ToolResult } from "../../src/types.js";

interface Params {
  url?: string;
}

export async function execute(params: Params): Promise<ToolResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(params.url || "https://example.com", {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ATLAS/1.0)" },
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return { success: false, output: "", error: `HTTP ${response.status}` };
    }

    const html = await response.text();

    // Extraer texto limpio (quitar HTML tags)
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 5000);

    return { success: true, output: text };
  } catch (err: any) {
    clearTimeout(timeout);
    return { success: false, output: "", error: err.message };
  }
}
