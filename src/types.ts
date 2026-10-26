import type { AstroConfig as NativeAstroConfig, AstroIntegrationLogger as NativeAstroIntegrationLogger } from "astro";

export type HeadersFlat = Record<string, string>;
export type HeadersNested = Record<string, Record<string, string>>;
export type AstroHeaders = HeadersFlat | HeadersNested;
export type Routes = Record<string, Record<string, string>>;

export interface CspAutoHashesOptions {
	autoHashes?: boolean;
	hashStyleElements?: boolean;
	hashStyleAttributes?: boolean;
	hashInlineScripts?: boolean;
	stripUnsafeInline?: boolean;
	mode?: "global" | "route";
	maxHeaderLineLength?: number;
	overflow?: "error" | "warn";
}

export interface AstroCloudflarePagesHeadersOptions {
	/** Preferred source for flat headers or route-to-header maps. */
	headers?: AstroHeaders;
	/** @deprecated Universal routes are normalized to `/*` automatically. */
	workers?: boolean;
	/** Apply configured headers to Astro responses. Defaults to auto for Cloudflare. */
	runtime?: "auto" | boolean;
	/** Override the detected static asset output directory. */
	assetsDirectory?: string | URL;
	csp?: CspAutoHashesOptions;
}

/** @deprecated Use Astro's `AstroConfig` type. */
export type AstroConfig = NativeAstroConfig;

/** @deprecated Use Astro's `AstroIntegrationLogger` type. */
export type AstroIntegrationLogger = NativeAstroIntegrationLogger;
