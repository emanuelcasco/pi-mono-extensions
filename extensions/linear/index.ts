import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerLinearTools } from "./src/linear-tools.js";

export default function linearExtension(pi: ExtensionAPI): void {
	registerLinearTools(pi);
}
