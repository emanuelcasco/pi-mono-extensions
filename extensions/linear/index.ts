import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerLinearTools } from "./src/linear-tools.js";

export default function linearExtension(pi: ExtensionAPI): void {
	registerLinearTools(pi);
}
