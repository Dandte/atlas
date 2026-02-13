// Template: Skill que consulta una API REST
import type { ToolResult } from "../../src/types.js";

interface Params {
  endpoint?: string;
}

export async function execute(params: Params): Promise<ToolResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch("https://api.example.com/data", {
      signal: controller.signal,
      headers: { "Accept": "application/json", "User-Agent": "ATLAS/1.0" },
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return { success: false, output: "", error: `HTTP ${response.status}` };
    }

    const data = await response.json();
    return { success: true, output: JSON.stringify(data, null, 2) };
  } catch (err: any) {
    clearTimeout(timeout);
    return {
      success: false, output: "",
      error: err.name === "AbortError" ? "Timeout 15s" : err.message,
    };
  }
}
