import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HeadersFlat, HeadersNested, AstroHeaders, Routes } from "./types";
import type { AstroIntegration, AstroConfig, AstroIntegrationLogger } from "astro";

const NAME = "astro-cloudflare-pages-headers";

// Helper function to check if an object is empty.
const isEmptyObject = (obj: object): boolean => Object.keys(obj).length === 0;

// Updated helper function to convert the provided directory into a string path.
function getBuildDir(dir: URL | string): string {
	if (typeof dir === "string") {
		return path.resolve(dir);
	}
	const filePath = fileURLToPath(dir);
	// If the resolved filePath is not under process.cwd(), treat it as relative
	if (!filePath.startsWith(process.cwd())) {
		// Remove the leading "/" and resolve relative to process.cwd()
		return path.resolve(process.cwd(), filePath.substring(1));
	}
	return filePath;
}

// Helper function to generate the _headers file content.
function generateHeadersContent(
	routes: Routes,
): string {
	const lines: string[] = [];
	for (const [route, headers] of Object.entries(routes)) {
		lines.push(route);
		for (const [headerName, headerValue] of Object.entries(headers)) {
			lines.push(`  ${headerName}: ${headerValue}`);
		}
		lines.push(""); // Add an empty line between routes.
	}
	return lines.join("\n");
}

// New helper to parse astroHeaders into a routes object.
function parseHeaders(astroHeaders: AstroHeaders): Routes {
	const sampleValue = Object.values(astroHeaders)[0];
	if (typeof sampleValue === "string") {
		return { "/*": astroHeaders as HeadersFlat };
	}
	return astroHeaders as HeadersNested;
}

// Export an integration function.
// When called, it returns an object containing hooks with a scoped astroHeaders variable.
export default function astroCloudflarePagesHeaders() {
	let astroHeaders: AstroHeaders | undefined;

	return {
		name: "astroCloudflarePagesHeaders",
		hooks: {
			"astro:config:setup": ({ config, logger }: { config: AstroConfig; logger: AstroIntegrationLogger }) => {
				logger.info(`[${NAME}] Setting up integration`);
				if (config.server?.headers) {
					astroHeaders = config.server.headers as AstroHeaders;
				}
			},
			"astro:build:done": async ({ dir, logger }: { dir: URL | string; logger: AstroIntegrationLogger }) => {
				logger.info(`[${NAME}] Running build hook`);

				if (
					!astroHeaders ||
					(typeof astroHeaders === "object" && isEmptyObject(astroHeaders))
				) {
					logger.warn(
						`[${NAME}] No headers configuration found in Astro config. Skipping _headers generation.`,
					);
					return;
				}

				const routes = parseHeaders(astroHeaders);
				const buildDir = getBuildDir(dir);
				const headersFilePath = path.resolve(buildDir, "_headers");
				const headersContent = generateHeadersContent(routes);

				try {
					await fs.writeFile(headersFilePath, headersContent, "utf-8");
					logger.info(
						`[${NAME}] Successfully created _headers at ${headersFilePath}`,
					);
				} catch (err) {
					logger.error(`[${NAME}] Failed to write _headers file: ${err}`);
				}
			},
		},
	} as unknown as AstroIntegration;
}
