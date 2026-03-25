/**
 * Script to combine BigCommerce Catalog API specs into a single OpenAPI specification.
 *
 * Usage: node scripts/combine-bigcommerce-catalog.mjs
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import got from 'got';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

const BIGCOMMERCE_DOCS_BASE_URL =
  'https://raw.githubusercontent.com/bigcommerce/docs/main/reference/catalog';

const CATALOG_SPECS = [
  'brands_catalog.v3.yml',
  'categories_catalog.v3.yml',
  'category-trees_catalog.v3.yml',
  'product-modifiers_catalog.v3.yml',
  'product-variant-options_catalog.v3.yml',
  'product-variants_catalog.v3.yml',
  'products_catalog.v3.yml'
];

async function fetchSpec(specName) {
  const url = `${BIGCOMMERCE_DOCS_BASE_URL}/${specName}`;
  console.log(`Fetching ${specName}...`);

  const response = await got.get(url).text();
  return yaml.load(response);
}

function isEmptyObjectSchema(obj) {
  if (typeof obj !== 'object' || obj === null) return false;
  return (
    obj.type === 'object' &&
    typeof obj.properties === 'object' &&
    obj.properties !== null &&
    Object.keys(obj.properties).length === 0
  );
}

function cleanupSpec(obj) {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(cleanupSpec);
  }

  if (typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined) {
        continue;
      }

      // Handle allOf arrays - filter out empty object schemas
      if (key === 'allOf' && Array.isArray(value)) {
        const filtered = value.filter((item) => !isEmptyObjectSchema(item));
        if (filtered.length === 0) {
          // Skip the allOf entirely if all items are empty
          continue;
        } else if (filtered.length === 1) {
          // If only one item remains, merge it into parent
          // But only if it's not a $ref (to avoid $ref alongside other properties)
          const remaining = filtered[0];
          if (remaining.$ref) {
            // Keep it as allOf with single item for proper resolution
            result[key] = filtered.map(cleanupSpec);
          } else {
            // Merge the non-ref schema into parent
            const cleaned = cleanupSpec(remaining);
            Object.assign(result, cleaned);
          }
        } else {
          result[key] = filtered.map(cleanupSpec);
        }
      } else {
        result[key] = cleanupSpec(value);
      }
    }
    return result;
  }

  return obj;
}

function mergeComponents(target, source, specName) {
  const componentTypes = [
    'schemas',
    'responses',
    'parameters',
    'requestBodies',
    'headers',
    'securitySchemes',
    'callbacks'
  ];

  for (const type of componentTypes) {
    if (source[type]) {
      if (!target[type]) {
        target[type] = {};
      }
      for (const [name, schema] of Object.entries(source[type])) {
        if (target[type][name]) {
          // Check if the schemas are different
          const existingJson = JSON.stringify(target[type][name]);
          const newJson = JSON.stringify(schema);
          if (existingJson !== newJson) {
            console.warn(
              `Warning: Component ${type}.${name} already exists with different definition (from ${specName})`
            );
          }
        } else {
          target[type][name] = schema;
        }
      }
    }
  }
}

function mergeTags(target, source) {
  if (!source) return;

  for (const tag of source) {
    const existingTag = target.find((t) => t.name === tag.name);
    if (!existingTag) {
      target.push(tag);
    }
  }
}

async function combineSpecs() {
  const specs = await Promise.all(CATALOG_SPECS.map(fetchSpec));

  // Use the first spec as the base for common properties
  const baseSpec = specs[0];

  const info = {
    title: 'BigCommerce Catalog API',
    version: '3.0',
    description:
      'Combined BigCommerce Catalog API specification including products, categories, brands, variants, and modifiers.',
    termsOfService: baseSpec.info.termsOfService,
    contact: baseSpec.info.contact
  };

  // Only add license if it exists
  if (baseSpec.info.license) {
    info.license = baseSpec.info.license;
  }

  const combined = {
    openapi: baseSpec.openapi,
    info,
    servers: baseSpec.servers,
    paths: {},
    components: {
      schemas: {},
      responses: {},
      parameters: {},
      requestBodies: {},
      headers: {},
      securitySchemes: {},
      callbacks: {}
    },
    security: baseSpec.security,
    tags: [],
    externalDocs: baseSpec.externalDocs
  };

  // Merge all specs
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const specName = CATALOG_SPECS[i];

    // Merge paths
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      if (combined.paths[path]) {
        console.warn(`Warning: Path ${path} already exists (from ${specName})`);
        // Merge operations from both path items
        combined.paths[path] = { ...combined.paths[path], ...pathItem };
      } else {
        combined.paths[path] = pathItem;
      }
    }

    // Merge components
    if (spec.components) {
      mergeComponents(combined.components, spec.components, specName);
    }

    // Merge tags
    mergeTags(combined.tags, spec.tags);
  }

  // Sort paths alphabetically for consistency
  const sortedPaths = {};
  for (const path of Object.keys(combined.paths).sort()) {
    sortedPaths[path] = combined.paths[path];
  }
  combined.paths = sortedPaths;

  // Sort tags alphabetically
  combined.tags.sort((a, b) => a.name.localeCompare(b.name));

  return combined;
}

async function main() {
  console.log('Combining BigCommerce Catalog API specs...\n');

  try {
    const combinedSpec = await combineSpecs();

    const outputPath = join(__dirname, '..', 'specs', 'bigcommerce', 'catalog.v3.yml');
    // Clean up spec - remove undefined values and fix allOf patterns with empty objects
    const cleanedSpec = cleanupSpec(combinedSpec);
    const yamlOutput = yaml.dump(cleanedSpec, {
      lineWidth: 120,
      noRefs: true,
      sortKeys: false
    });

    writeFileSync(outputPath, yamlOutput, 'utf8');
    console.log(`\nCombined spec written to: ${outputPath}`);

    // Print summary
    const pathCount = Object.keys(combinedSpec.paths).length;
    const schemaCount = Object.keys(combinedSpec.components?.schemas ?? {}).length;
    console.log(`\nSummary:`);
    console.log(`  - Paths: ${pathCount}`);
    console.log(`  - Schemas: ${schemaCount}`);
    console.log(`  - Tags: ${combinedSpec.tags?.length ?? 0}`);
  } catch (error) {
    console.error('Error combining specs:', error);
    process.exit(1);
  }
}

main();
