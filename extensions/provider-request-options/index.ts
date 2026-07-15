import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

import { deepMerge, ProviderRequestOptionsLoader } from "./config.js";

export { deepMerge, isPlainObject, ProviderRequestOptionsLoader } from "./config.js";

export default function providerRequestOptions(pi: ExtensionAPI): void {
	let loader: ProviderRequestOptionsLoader | undefined;

	pi.on("before_provider_request", (event, ctx: ExtensionContext) => {
		const provider = ctx.model?.provider;
		if (!provider) return;

		loader ??= new ProviderRequestOptionsLoader(
			join(getAgentDir(), "settings.json"),
			(message) => ctx.ui.notify(message, "error"),
		);
		const options = loader.getOptions(provider);
		if (!options) return;

		return deepMerge(event.payload, options);
	});
}
