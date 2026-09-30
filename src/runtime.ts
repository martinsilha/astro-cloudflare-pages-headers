import { applyConfiguredHeaders } from "./runtime-core.js";
import type { Routes } from "./types.js";

declare const __ASTRO_CLOUDFLARE_PAGES_HEADERS_CONFIG__: RuntimeConfig;

interface RuntimeConfig {
	enabled: boolean;
	routes: Routes;
}

interface MiddlewareContext {
	url: URL;
}

export async function onRequest(context: MiddlewareContext, next: () => Promise<Response>): Promise<Response> {
	const response = await next();
	const config = __ASTRO_CLOUDFLARE_PAGES_HEADERS_CONFIG__;
	if (!config.enabled) return response;
	return applyConfiguredHeaders(response, config.routes, context.url);
}
