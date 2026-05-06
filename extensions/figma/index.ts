import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerFigmaTools } from "./src/figma-tools.js";

export default function figmaExtension(pi: ExtensionAPI): void {
	registerFigmaTools(pi);
}
