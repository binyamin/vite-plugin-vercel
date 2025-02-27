import { ResolvedConfig } from 'vite';
import glob from 'fast-glob';
import path, { basename, dirname } from 'path';
import { getOutput, getRoot, pathRelativeTo } from './utils';
import { build, BuildOptions, type Plugin } from 'esbuild';
import { ViteVercelApiEntry } from './types';
import { assert } from './assert';
import { vercelOutputVcConfigSchema } from './schemas/config/vc-config';
import fs, { copyFile } from 'fs/promises';
import type { Rewrite } from '@vercel/routing-utils';

export function getAdditionalEndpoints(resolvedConfig: ResolvedConfig) {
  return (resolvedConfig.vercel?.additionalEndpoints ?? []).map((e) => ({
    ...e,
    addRoute: e.addRoute ?? true,
    // path.resolve removes the trailing slash if any
    destination: path.posix.resolve('/', e.destination) + '.func',
  }));
}

export function getEntries(
  resolvedConfig: ResolvedConfig,
): ViteVercelApiEntry[] {
  const apiEntries = glob
    .sync(`${getRoot(resolvedConfig)}/api/**/*.*([a-zA-Z0-9])`)
    // from Vercel doc: Files with the underscore prefix are not turned into Serverless Functions.
    .filter((filepath) => !path.basename(filepath).startsWith('_'));

  if (apiEntries.length > 0) {
    console.warn(
      '@vercel/build is currently force building /api files itself, with no way to disable it. ' +
        'In order to avoid double compilation, you should temporarily rename /api to /_api while using this plugin. ' +
        '/_api functions are compiled under .vercel/output/functions/api/*.func as if they were in /api.',
    );
  }

  const otherApiEntries = glob
    .sync(`${getRoot(resolvedConfig)}/_api/**/*.*([a-zA-Z0-9])`)
    // from Vercel doc: Files with the underscore prefix are not turned into Serverless Functions.
    .filter((filepath) => !path.basename(filepath).startsWith('_'));

  return [...apiEntries, ...otherApiEntries].reduce((entryPoints, filePath) => {
    const outFilePath = pathRelativeTo(
      filePath,
      resolvedConfig,
      filePath.includes('/_api/') ? '_api' : 'api',
    );
    const parsed = path.posix.parse(outFilePath);

    entryPoints.push({
      source: filePath,
      destination: `api/${path.posix.join(parsed.dir, parsed.name)}.func`,
      addRoute: true,
    });

    return entryPoints;
  }, getAdditionalEndpoints(resolvedConfig));
}

const wasmPlugin: Plugin = {
  name: 'wasm',
  setup(build) {
    build.onResolve({ filter: /\.wasm/ }, (args) => {
      return {
        path: args.path.replace(/\.wasm\?module$/i, '.wasm'),
        external: true,
      };
    });
  },
};

const vercelOgPlugin = (ctx: { found: boolean; index: string }): Plugin => {
  return {
    name: 'vercel-og',
    setup(build) {
      build.onResolve({ filter: /@vercel\/og/ }, () => {
        ctx.found = true;
        return undefined;
      });

      build.onLoad({ filter: /@vercel\/og/ }, (args) => {
        ctx.index = args.path;
        return undefined;
      });
    },
  };
};

const standardBuildOptions: BuildOptions = {
  bundle: true,
  target: 'es2020',
  format: 'cjs',
  platform: 'node',
  logLevel: 'info',
  logOverride: {
    'ignored-bare-import': 'verbose',
    'require-resolve-not-external': 'verbose'
  },
  minify: true,
  plugins: [wasmPlugin],
};

export async function buildFn(
  resolvedConfig: ResolvedConfig,
  entry: ViteVercelApiEntry,
  buildOptions?: BuildOptions,
): Promise<void> {
  assert(
    entry.destination.length > 0,
    `Endpoint ${
      typeof entry.source === 'string' ? entry.source : '-'
    } does not have build destination`,
  );

  const outfile = path.join(
    getOutput(resolvedConfig, 'functions'),
    entry.destination,
    'index.js',
  );

  const options = Object.assign({}, standardBuildOptions, { outfile });

  if (buildOptions) {
    Object.assign(options, buildOptions);
  }

  if (!options.stdin) {
    if (typeof entry.source === 'string') {
      options.entryPoints = [entry.source];
    } else {
      assert(
        typeof entry.source === 'object',
        `\`{ source }\` must be a string or an object`,
      );
      assert(
        typeof entry.source.contents === 'string',
        `\`{ contents }\` must be a string`,
      );
      options.stdin = entry.source;
    }
  }

  if (entry.edge) {
    options.conditions = [
      'edge-light',
      'browser',
      'module',
      'import',
      'require',
    ];
    options.format = 'esm';
  }

  const ctx = { found: false, index: '' };
  options.plugins!.push(vercelOgPlugin(ctx));

  await build(options);

  // Special case for @vercel/og
  // See https://github.com/magne4000/vite-plugin-vercel/issues/23
  // and https://github.com/magne4000/vite-plugin-vercel/issues/25
  if (ctx.found && ctx.index) {
    const dir = dirname(ctx.index);
    const externalFiles = await glob(`${dir}/*.{ttf,wasm}`);

    for (const f of externalFiles) {
      await copyFile(
        f,
        path.join(
          getOutput(resolvedConfig, 'functions'),
          entry.destination,
          basename(f),
        ),
      );
    }
  }

  await writeVcConfig(resolvedConfig, entry.destination, Boolean(entry.edge));
}

export async function writeVcConfig(
  resolvedConfig: ResolvedConfig,
  destination: string,
  edge: boolean,
): Promise<void> {
  const vcConfig = path.join(
    getOutput(resolvedConfig, 'functions'),
    destination,
    '.vc-config.json',
  );

  await fs.writeFile(
    vcConfig,
    JSON.stringify(
      vercelOutputVcConfigSchema.parse(
        edge
          ? {
              runtime: 'edge',
              entrypoint: 'index.js',
            }
          : {
              runtime: 'nodejs16.x',
              handler: 'index.js',
              maxDuration: resolvedConfig.vercel?.defaultMaxDuration,
              launcherType: 'Nodejs',
              shouldAddHelpers: true,
            },
      ),
      undefined,
      2,
    ),
    'utf-8',
  );
}

function getSourceAndDestination(destination: string) {
  if (destination.startsWith('api/')) {
    return path.posix.resolve('/', destination);
  }
  return path.posix.resolve('/', destination, ':match*');
}

export async function buildEndpoints(
  resolvedConfig: ResolvedConfig,
): Promise<NonNullable<Rewrite[]>> {
  const entries = getEntries(resolvedConfig);

  for (const entry of entries) {
    await buildFn(resolvedConfig, entry);
  }

  return entries
    .filter((e) => e.addRoute !== false)
    .map((e) => e.destination.replace(/\.func$/, ''))
    .map((destination) => ({
      source: getSourceAndDestination(destination),
      destination: getSourceAndDestination(destination),
    }));
}
