export type HeadersFlat = Record<string, string>;
export type HeadersNested = Record<string, Record<string, string>>;
export type AstroHeaders = HeadersFlat | HeadersNested;

export type Routes = Record<string, Record<string, string>>;

export interface AstroConfig {
	server?: {
		headers?: AstroHeaders;
	};
}

export interface AstroIntegrationLogger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}
