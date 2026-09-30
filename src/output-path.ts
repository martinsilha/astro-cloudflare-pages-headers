import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function toPath(value: URL | string): string {
	return value instanceof URL ? fileURLToPath(value) : path.resolve(value);
}

function parseJsonc(value: string): unknown {
	let clean = "";
	let inString = false;
	let escaped = false;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		const next = value[index + 1];
		if (inString) {
			clean += character;
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') {
			inString = true;
			clean += character;
		} else if (character === "/" && next === "/") {
			while (index < value.length && value[index] !== "\n") index += 1;
			clean += "\n";
		} else if (character === "/" && next === "*") {
			index += 2;
			while (index < value.length && !(value[index] === "*" && value[index + 1] === "/")) index += 1;
			index += 1;
		} else clean += character;
	}
	return JSON.parse(clean.replace(/,\s*([}\]])/g, "$1")) as unknown;
}

export interface AssetLayoutConfig {
	root: URL;
	outDir: URL | string;
	base: string;
	build: { server: URL | string; client: URL | string; assets?: string };
}

interface GeneratedAssetsConfig {
	configPath: string;
	directory: string;
	htmlHandling?: string;
	notFoundHandling?: string;
}

async function generatedAssetsConfig(
	config: AssetLayoutConfig,
	renderedDir: string,
): Promise<GeneratedAssetsConfig | undefined> {
	const candidates = new Set<string>();
	const add = (value: string | URL | undefined) => {
		if (!value) return;
		const directory = toPath(value);
		candidates.add(path.join(directory, "wrangler.json"));
		candidates.add(path.join(directory, "wrangler.jsonc"));
		candidates.add(path.join(directory, "wrangler.toml"));
	};
	add(config.build.server);
	add(config.outDir);
	add(renderedDir);

	for (const configPath of candidates) {
		let text: string;
		try {
			text = await fs.readFile(configPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw new Error(`Could not read generated Wrangler configuration at ${configPath}.`, { cause: error });
		}
		let directory: unknown;
		let htmlHandling: string | undefined;
		let notFoundHandling: string | undefined;
		if (configPath.endsWith(".toml")) {
			directory = text.match(/^\s*directory\s*=\s*["']([^"']+)["']/m)?.[1];
			htmlHandling = text.match(/^\s*html_handling\s*=\s*["']([^"']+)["']/m)?.[1];
			notFoundHandling = text.match(/^\s*not_found_handling\s*=\s*["']([^"']+)["']/m)?.[1];
		} else {
			let parsed: { assets?: { directory?: unknown; html_handling?: unknown; not_found_handling?: unknown } };
			try {
				parsed = parseJsonc(text) as typeof parsed;
			} catch (error) {
				throw new Error(`Could not parse generated Wrangler configuration at ${configPath}.`, { cause: error });
			}
			directory = parsed.assets?.directory;
			htmlHandling = typeof parsed.assets?.html_handling === "string" ? parsed.assets.html_handling : undefined;
			notFoundHandling = typeof parsed.assets?.not_found_handling === "string" ? parsed.assets.not_found_handling : undefined;
		}
		if (typeof directory === "string") {
			return { configPath, directory, htmlHandling, notFoundHandling };
		}
	}
	return undefined;
}

export async function resolveGeneratedAssets(
	config: AssetLayoutConfig,
	renderedDir: string,
	options: { explicitDirectory?: string | URL; adapterName?: string; adapterVersion?: number; originalClientDir?: string },
): Promise<{ directory: string; htmlHandling: string; notFoundHandling?: string; configPath?: string }> {
	const generated = await generatedAssetsConfig(config, renderedDir);
	let directory: string | undefined;
	if (generated) directory = path.resolve(path.dirname(generated.configPath), generated.directory);

	if (!directory && options.explicitDirectory) {
		const value = options.explicitDirectory;
		directory = value instanceof URL ? fileURLToPath(value) : path.resolve(toPath(config.root), value);
	}

	if (options.adapterName === "@astrojs/cloudflare" && !directory) {
		if (options.adapterVersion === undefined) {
			throw new Error("Could not determine the installed @astrojs/cloudflare version or generated asset directory. Set assetsDirectory to the deployed static asset root.");
		}
		if (options.adapterVersion < 13) {
			directory = toPath(config.outDir);
		} else {
			const base = config.base.replace(/^\/+|\/+$/g, "");
			const candidate = options.originalClientDir ?? toPath(config.build.client);
			const withBase = base ? path.resolve(candidate, base) : candidate;
			if (renderedDir !== candidate && renderedDir !== withBase) {
				throw new Error(`Could not safely resolve the Cloudflare asset directory from rendered output ${renderedDir}. Set assetsDirectory to the deployed static asset root.`);
			}
			directory = candidate;
		}
	}

	if (!directory) directory = renderedDir;
	if (generated && options.explicitDirectory) {
		const explicit = options.explicitDirectory instanceof URL
			? fileURLToPath(options.explicitDirectory)
			: path.resolve(toPath(config.root), options.explicitDirectory);
		if (path.resolve(directory) !== path.resolve(explicit)) {
			throw new Error(`assetsDirectory ${explicit} disagrees with the deployment asset directory ${directory}.`);
		}
	}
	return {
		directory: path.resolve(directory),
		htmlHandling: generated?.htmlHandling ?? "auto-trailing-slash",
		notFoundHandling: generated?.notFoundHandling,
		configPath: generated?.configPath,
	};
}

export function resolveCloudflareVersion(root: URL, packageName: string): number | undefined {
	const rootPath = fileURLToPath(root);
	const require = createRequire(path.join(rootPath, "package.json"));
	let resolved: string;
	try {
		resolved = require.resolve(packageName);
	} catch {
		return undefined;
	}
	let directory = path.dirname(resolved);
	for (let depth = 0; depth < 8; depth += 1) {
		const packageJsonPath = path.join(directory, "package.json");
		try {
			const metadata = JSON.parse(require("node:fs").readFileSync(packageJsonPath, "utf8")) as { name?: string; version?: string };
			if (metadata.name === packageName && metadata.version) return Number(metadata.version.split(".")[0]);
		} catch {
			// Continue toward the project root.
		}
		const parent = path.dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return undefined;
}
