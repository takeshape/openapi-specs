/**
 * Script to combine BigCommerce Catalog API specs into a single OpenAPI specification.
 *
 * Strategy:
 * 1. Combine all specs and merge components
 * 2. Replace inline schemas with $refs to existing components (deduplication)
 * 3. Rename component schemas to PascalCase
 * 4. Update all $refs to use new PascalCase names
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

/**
 * Converts a schema name to PascalCase.
 * Examples:
 *   productVariant_Base -> ProductVariantBase
 *   productVariant_Full -> ProductVariant (removes _Full suffix)
 *   metaCollection_Full -> MetaCollection
 *   error_Base -> ErrorBase
 *   brand_Full -> Brand
 */
function toPascalCase(name) {
  // Remove _Full suffix - the "Full" version is the main type
  let cleanName = name.replace(/_Full$/, '');

  // Split on underscores and camelCase boundaries
  const parts = cleanName
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .split('_')
    .filter(Boolean);

  // Capitalize each part and join
  return parts
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('');
}

/**
 * Build a map of old names to new PascalCase names.
 */
function buildNameMap(schemas) {
  const nameMap = new Map();
  const newNameCounts = new Map();

  // First pass: generate new names and count collisions
  for (const oldName of Object.keys(schemas)) {
    const newName = toPascalCase(oldName);
    newNameCounts.set(newName, (newNameCounts.get(newName) || 0) + 1);
  }

  // Second pass: resolve collisions
  for (const oldName of Object.keys(schemas)) {
    let newName = toPascalCase(oldName);

    // If there's a collision and this is a _Base type, keep Base suffix
    if (newNameCounts.get(newName) > 1) {
      if (oldName.endsWith('_Base')) {
        newName = toPascalCase(oldName.replace('_Base', '')) + 'Base';
      } else if (oldName.endsWith('_Post')) {
        newName = toPascalCase(oldName.replace('_Post', '')) + 'Post';
      } else if (oldName.endsWith('_Put')) {
        newName = toPascalCase(oldName.replace('_Put', '')) + 'Put';
      }
    }

    nameMap.set(oldName, newName);
  }

  return nameMap;
}

/**
 * Mapping of inline schema titles to the component they should reference.
 */
const INLINE_TITLE_TO_COMPONENT = {
  'Variant Base': 'productVariant_Full',
  'Option Value Product Base': 'productVariantOptionValue_Full',
  'Option Value Variant': 'productVariantOptionValue_Full',
  'Product Variant Option Value': 'productVariantOptionValue_Full',
};

/**
 * Check if an allOf pattern matches a known component.
 * Returns the component name to use, or null if no match.
 */
function matchAllOfToComponent(allOf) {
  if (!Array.isArray(allOf) || allOf.length < 1) return null;

  const first = allOf[0];
  const second = allOf[1];

  // Pattern: Variant Base + object with id/product_id/sku -> productVariant_Full
  if (first.title === 'Variant Base' ||
      first.$ref === '#/components/schemas/productVariant_Base') {
    if (second?.type === 'object' && second?.properties) {
      const props = Object.keys(second.properties);
      if (props.includes('id') && props.includes('product_id') && props.includes('sku')) {
        return 'productVariant_Full';
      }
    }
  }

  // Pattern: Option Value Product Base + object with id/option_id -> productVariantOptionValue_Full
  if (first.title === 'Option Value Product Base' ||
      first.$ref === '#/components/schemas/productVariantOptionValue_Base') {
    if (second?.type === 'object' && second?.properties) {
      const props = Object.keys(second.properties);
      if (props.includes('id') && props.includes('option_id')) {
        return 'productVariantOptionValue_Full';
      }
    }
  }

  return null;
}

/**
 * Process the spec to replace inline schemas with $refs to existing components.
 */
function deduplicateInlineSchemas(spec) {
  let replacementCount = 0;

  function processValue(value, path = []) {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) {
      return value.map((item, i) => processValue(item, [...path, i]));
    }
    if (typeof value !== 'object') return value;

    // Check for allOf that matches a known component
    if (value.allOf && Array.isArray(value.allOf)) {
      const matchedComponent = matchAllOfToComponent(value.allOf);
      if (matchedComponent) {
        // Prevent self-referential replacements - if we're inside the schema definition
        // for the matched component, don't replace it with a ref to itself
        const isInsideSchema = path[0] === 'components' && path[1] === 'schemas' && path[2] === matchedComponent;
        if (!isInsideSchema) {
          console.log(`  Replacing allOf at ${path.join('.')} -> ${matchedComponent}`);
          replacementCount++;
          return { $ref: `#/components/schemas/${matchedComponent}` };
        }
      }

      // Process allOf members recursively
      return {
        ...value,
        allOf: value.allOf.map((item, i) => processValue(item, [...path, 'allOf', i]))
      };
    }

    // Check for inline object with title that matches a known component
    if (value.title && value.type === 'object' && INLINE_TITLE_TO_COMPONENT[value.title]) {
      const component = INLINE_TITLE_TO_COMPONENT[value.title];
      console.log(`  Replacing inline "${value.title}" at ${path.join('.')} -> ${component}`);
      replacementCount++;
      return { $ref: `#/components/schemas/${component}` };
    }

    // Recurse into object properties
    const result = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = processValue(val, [...path, key]);
    }
    return result;
  }

  const processed = processValue(spec);
  console.log(`  Total inline replacements: ${replacementCount}`);
  return processed;
}

/**
 * Update all $refs to use new PascalCase names.
 */
function updateRefs(obj, nameMap) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(item => updateRefs(item, nameMap));
  if (typeof obj !== 'object') return obj;

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === '$ref' && typeof value === 'string' && value.startsWith('#/components/schemas/')) {
      const oldName = value.replace('#/components/schemas/', '');
      const newName = nameMap.get(oldName) || oldName;
      result[key] = `#/components/schemas/${newName}`;
    } else {
      result[key] = updateRefs(value, nameMap);
    }
  }
  return result;
}

/**
 * Rename component schemas to PascalCase.
 */
function renameSchemas(components, nameMap) {
  if (!components?.schemas) return components;

  const newSchemas = {};
  for (const [oldName, schema] of Object.entries(components.schemas)) {
    const newName = nameMap.get(oldName) || oldName;

    // Update the title if it matches the old name
    const updatedSchema = { ...schema };
    if (updatedSchema.title === oldName) {
      updatedSchema.title = newName;
    }

    newSchemas[newName] = updatedSchema;
  }

  return { ...components, schemas: newSchemas };
}

/**
 * Clean up the spec - remove empty allOf, unwrap single-item allOf, etc.
 */
function cleanupSpec(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(cleanupSpec);
  if (typeof obj !== 'object') return obj;

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;

    if (key === 'allOf' && Array.isArray(value)) {
      // Filter out empty objects
      const filtered = value.filter(item => {
        if (item.type === 'object' && item.properties && Object.keys(item.properties).length === 0) {
          return false;
        }
        return true;
      });

      if (filtered.length === 0) continue;
      if (filtered.length === 1) {
        // Unwrap single-item allOf
        if (filtered[0].$ref) {
          result.$ref = filtered[0].$ref;
        } else {
          Object.assign(result, cleanupSpec(filtered[0]));
        }
        continue;
      }
      result[key] = filtered.map(cleanupSpec);
    } else {
      result[key] = cleanupSpec(value);
    }
  }
  return result;
}

function mergeComponents(target, source, specName) {
  const componentTypes = ['schemas', 'responses', 'parameters', 'requestBodies', 'headers', 'securitySchemes'];

  for (const type of componentTypes) {
    if (source[type]) {
      if (!target[type]) target[type] = {};
      for (const [name, schema] of Object.entries(source[type])) {
        if (target[type][name]) {
          const existingJson = JSON.stringify(target[type][name]);
          const newJson = JSON.stringify(schema);
          if (existingJson !== newJson) {
            console.warn(`Warning: Component ${type}.${name} already exists with different definition (from ${specName})`);
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
    const existingTag = target.find(t => t.name === tag.name);
    if (!existingTag) {
      target.push(tag);
    }
  }
}

async function combineSpecs() {
  const combined = {
    openapi: '3.0.3',
    info: {
      title: 'BigCommerce Catalog API',
      description: 'Combined BigCommerce Catalog API specification including products, categories, brands, and variants.',
      version: '1.0.0'
    },
    servers: [{ url: 'https://api.bigcommerce.com/stores/{store_hash}/v3', variables: { store_hash: { default: 'your_store_hash' } } }],
    tags: [],
    paths: {},
    components: { schemas: {}, parameters: {}, responses: {} }
  };

  for (const specName of CATALOG_SPECS) {
    const spec = await fetchSpec(specName);

    for (const [path, pathItem] of Object.entries(spec.paths || {})) {
      if (combined.paths[path]) {
        Object.assign(combined.paths[path], pathItem);
      } else {
        combined.paths[path] = pathItem;
      }
    }

    if (spec.components) {
      mergeComponents(combined.components, spec.components, specName);
    }
    mergeTags(combined.tags, spec.tags);
  }

  // Sort paths and tags
  const sortedPaths = {};
  for (const path of Object.keys(combined.paths).sort()) {
    sortedPaths[path] = combined.paths[path];
  }
  combined.paths = sortedPaths;
  combined.tags.sort((a, b) => a.name.localeCompare(b.name));

  return combined;
}

async function main() {
  console.log('Combining BigCommerce Catalog API specs...\n');

  try {
    let spec = await combineSpecs();

    console.log(`\nMerged ${Object.keys(spec.components?.schemas ?? {}).length} component schemas`);

    // Step 1: Deduplicate inline schemas
    console.log('\nStep 1: Deduplicating inline schemas...');
    spec = deduplicateInlineSchemas(spec);

    // Step 2: Build name map for PascalCase conversion
    console.log('\nStep 2: Building PascalCase name map...');
    const nameMap = buildNameMap(spec.components.schemas);

    // Log example renames
    const examples = ['productVariant_Base', 'productVariant_Full', 'metaCollection_Full', 'brand_Full', 'error_Base'];
    for (const ex of examples) {
      if (nameMap.has(ex)) {
        console.log(`  ${ex} -> ${nameMap.get(ex)}`);
      }
    }

    // Step 3: Rename schemas
    console.log('\nStep 3: Renaming schemas to PascalCase...');
    spec.components = renameSchemas(spec.components, nameMap);

    // Step 4: Update all $refs
    console.log('Step 4: Updating $refs to new names...');
    spec = updateRefs(spec, nameMap);

    // Step 5: Clean up
    console.log('Step 5: Cleaning up spec...');
    spec = cleanupSpec(spec);

    const outputPath = join(__dirname, '..', 'specs', 'bigcommerce', 'catalog.v3.yml');
    const yamlOutput = yaml.dump(spec, { lineWidth: 120, noRefs: true, sortKeys: false });
    writeFileSync(outputPath, yamlOutput, 'utf8');

    console.log(`\nCombined spec written to: ${outputPath}`);
    console.log(`\nSummary:`);
    console.log(`  - Paths: ${Object.keys(spec.paths).length}`);
    console.log(`  - Schemas: ${Object.keys(spec.components?.schemas ?? {}).length}`);
    console.log(`  - Tags: ${spec.tags?.length ?? 0}`);
  } catch (error) {
    console.error('Error combining specs:', error);
    process.exit(1);
  }
}

main();
