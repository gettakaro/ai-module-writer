import fs from 'node:fs';

export async function resolve(specifier, context, defaultResolve) {
  try {
    return await defaultResolve(specifier, context, defaultResolve);
  } catch (error) {
    if (!specifier.endsWith('.js')) {
      throw error;
    }

    const tsSpecifier = specifier.slice(0, -3) + '.ts';

    if (specifier.startsWith('file://')) {
      const tsUrl = new URL(tsSpecifier);
      if (fs.existsSync(tsUrl)) {
        return defaultResolve(tsSpecifier, context, defaultResolve);
      }
      throw error;
    }

    if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')) {
      const parentURL = context.parentURL ?? import.meta.url;
      const candidateUrl = new URL(tsSpecifier, parentURL);
      if (fs.existsSync(candidateUrl)) {
        return {
          url: candidateUrl.href,
          shortCircuit: true,
        };
      }
    }

    throw error;
  }
}
