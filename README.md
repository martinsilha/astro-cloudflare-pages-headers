# astro-cloudflare-pages-headers

![npm](https://img.shields.io/npm/v/astro-cloudflare-pages-headers)
![GitHub](https://img.shields.io/github/license/martinsilha/astro-cloudflare-pages-headers)

![GitHub Workflow Status](https://img.shields.io/github/actions/workflow/status/martinsilha/astro-cloudflare-pages-headers/release.yml)
![GitHub Release Date](https://img.shields.io/github/release-date/martinsilha/astro-cloudflare-pages-headers)
![GitHub last commit](https://img.shields.io/github/last-commit/martinsilha/astro-cloudflare-pages-headers)


A lightweight [integration](https://astro.build/integrations/) for [Astro](https://astro.build/) that automatically generates a [Cloudflare Pages](https://pages.cloudflare.com/) `_headers` file for deployments based on your server header configuration.

## Features

- Automatic `_headers` generation: Reads header settings from your `astro.config.mjs` and generates a `_headers` file during build.
- Flexible configuration: Supports both flat and nested header formats.
- Informative logging: Provides useful log messages during setup and build

## Installation

Install the integration via `npm`, `pnpm`, or `yarn`:

```bash
npm install astro-cloudflare-pages-headers --save-dev
```

```bash
pnpm install astro-cloudflare-pages-headers --save-dev
```

```bash
yarn add astro-cloudflare-pages-headers --dev
```

## Usage

Add the integration to your [Astro configuration file](https://docs.astro.build/en/reference/configuration-reference/) (`astro.config.mjs`). The integration looks for [header settings](https://docs.astro.build/en/reference/configuration-reference/#serverheaders) in the `server.headers` property:

### Example with Flat Headers

`astro.config.mjs`:

```js,ts
import { defineConfig } from 'astro/config';
import { astroCloudflarePagesHeaders } from 'astro-cloudflare-pages-headers';

export default defineConfig({
  integrations: [
    astroCloudflarePagesHeaders(),
  ],
  server: {
    headers: {
      'X-Custom-Header': 'my-value',
      'X-Another-Header': 'another-value'
    },
  },
});
```

This configuration generates the following `_headers` file:

```plaintext
/*
  X-Custom-Header: my-value
  X-Another-Header: another-value
```

### Example with Nested Headers

`astro.config.mjs`:
```js,ts
import { defineConfig } from 'astro/config';
import { astroCloudflarePagesHeaders } from 'astro-cloudflare-pages-headers';

export default defineConfig({
  integrations: [
    astroCloudflarePagesHeaders(),
  ],
  server: {
    headers: {
      '/api': {
        'Cache-Control': 'max-age=3600',
      },
      '/static': {
        'X-Frame-Options': 'DENY',
      },
    },
  },
});
```

This configuration generates the following `_headers` file:

```plaintext
/api
  Cache-Control: max-age=3600

/static
  X-Frame-Options: DENY
```

## How It Works

### Setup

`astro:config:setup`

The integration reads your header configuation from `config.server.headers` and stores it internally.

### Build

`astro:build:done`

- If headers are configured, it converts them into the appropriate Cloudflare Pages format.
- It writes the generated content to a `_headers` file in your build output directory.
- Logs inform you if the file is successfully written or if any errors occur.
- If no headers are configured, it logs a warning and skips file generation.

## Development

### Running Unit Tests

This project uses [Vitest](https://vitest.dev/) for testing. To run the tests:

Unit tests cover various scenarios including flat headers, nested headers, error handling, and logging verification.

```bash
npm test
```

```bash
pnpm test
```

```bash
yarn test
```

### Testing Your Header Configuration

[MDN Observatory](https://observatory.mozilla.org/) is a great tool for testing your headers. You can use it to [test your headers locally](https://github.com/mdn/mdn-http-observatory/) or after deploying to Cloudflare Pages.

## Contributing

Contributions and improvements are welcome. Feel free to open issues or submit pull requests on the repository.

## License

This project is licensed under the [MIT License](https://opensource.org/license/mit). See the [LICENSE](LICENSE) file for details.

## Resources

- [Astro](https://astro.build/)
  - [Configuration Reference](https://docs.astro.build/en/reference/configuration-reference/)
  - [Server Headers](https://docs.astro.build/en/reference/configuration-reference/#serverheaders)
  - [Integrations](https://docs.astro.build/en/guides/integrations-guide/)

- [Cloudflare Pages](https://pages.cloudflare.com/)
  - [Cloudflare Pages Documentation](https://developers.cloudflare.com/pages/)
  - [Customizing Headers](https://developers.cloudflare.com/pages/platform/headers)

- [MDN Observatory](https://observatory.mozilla.org/)
  - [mdn-http-observatory](https://github.com/mdn/mdn-http-observatory/)

- [Vitest](https://vitest.dev/)
  
- [MIT License](https://opensource.org/licenses/MIT)
