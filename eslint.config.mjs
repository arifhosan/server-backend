// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import path from 'node:path';


/**
 * Each folder under src/modules is an independent sub-project. It may use
 * src/common and src/database (shared infrastructure) but must never reach
 * into a sibling module.
 *
 * This is resolved rather than pattern-matched, because how far a relative
 * import has to climb to escape a module depends on how deep the importing
 * file sits - a glob cannot tell the two apart.
 */
const MODULES_ROOT = path.join(import.meta.dirname, 'src', 'modules');

function moduleOf(absPath) {
  const rel = path.relative(MODULES_ROOT, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep)[0];
}

const moduleBoundaries = {
  rules: {
    'no-cross-module-import': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          crossModule:
            "'{{from}}' must not import from the '{{target}}' module. Modules are independent sub-projects; move anything genuinely shared into src/common or src/database.",
        },
      },
      create(context) {
        const self = moduleOf(context.filename);
        if (!self) return {};

        return {
          ImportDeclaration(node) {
            const source = node.source.value;
            if (typeof source !== 'string') return;

            let resolved;
            if (source.startsWith('@/')) {
              resolved = path.join(
                import.meta.dirname,
                'src',
                source.slice(2),
              );
            } else if (source.startsWith('.')) {
              resolved = path.resolve(path.dirname(context.filename), source);
            } else {
              return; // bare package specifier
            }

            const target = moduleOf(resolved);
            if (target && target !== self) {
              context.report({
                node: node.source,
                messageId: 'crossModule',
                data: { from: self, target },
              });
            }
          },
        };
      },
    },
  },
};

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['src/modules/**/*.ts'],
    plugins: { boundaries: moduleBoundaries },
    rules: { 'boundaries/no-cross-module-import': 'error' },
  },
  {
    rules: {
      // These were relaxed to accommodate untyped code that no longer exists.
      // A floating promise or an unsafe `any` is a real defect here, so they
      // fail the build rather than printing a warning nobody reads.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
    },
  },
);
