import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFigmaTools } from "./src/figma-tools.js";

export default function figmaExtension(pi: ExtensionAPI): void {
	registerFigmaTools(pi);
}
