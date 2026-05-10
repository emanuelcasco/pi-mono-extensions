import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWebSearchTools } from "./src/web-search-tools.js";

export default function webSearchExtension(pi: ExtensionAPI): void {
	registerWebSearchTools(pi);
}
