/**
 * Script to combine BigCommerce Catalog API specs into a single OpenAPI specification.
 *
 * Strategy:
 * 1. Combine all specs and merge components
 * 2. Replace inline schemas with $refs to existing components (subset matching)
 * 3. Rename component schemas to PascalCase
 * 4. Update all $refs to use new PascalCase names
 *
 * Usage: node scripts/combine-bigcommerce-catalog.mjs
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import got from 'got';
import isEqual from 'lodash/isEqual.js';
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

  // Second pass: resolve collisions by keeping suffix
  for (const oldName of Object.keys(schemas)) {
    let newName = toPascalCase(oldName);

    if (newNameCounts.get(newName) > 1) {
      // Extract suffix and keep it for disambiguation
      const suffixMatch = oldName.match(/_([A-Za-z]+)$/);
      if (suffixMatch) {
        const suffix = suffixMatch[1];
        const baseName = oldName.replace(/_[A-Za-z]+$/, '');
        newName = toPascalCase(baseName) + suffix.charAt(0).toUpperCase() + suffix.slice(1).toLowerCase();
      }
    }

    nameMap.set(oldName, newName);
  }

  return nameMap;
}

// ============================================================================
// Subset Matching - Replace inline schemas with $refs to component schemas
// ============================================================================

/**
 * Extract properties from a schema, flattening allOf if present.
 * Returns a map of property name -> property schema, or null if not an object schema.
 */
function extractProperties(schema, componentSchemas = {}) {
  if (!schema || typeof schema !== 'object') return null;

  // If it's a $ref, resolve it
  if (schema.$ref) {
    const refName = schema.$ref.replace('#/components/schemas/', '');
    const resolved = componentSchemas[refName];
    if (resolved) {
      return extractProperties(resolved, componentSchemas);
    }
    return null;
  }

  // If it has allOf, merge all properties
  if (schema.allOf && Array.isArray(schema.allOf)) {
    const merged = {};
    for (const item of schema.allOf) {
      const props = extractProperties(item, componentSchemas);
      if (props) {
        Object.assign(merged, props);
      }
    }
    return Object.keys(merged).length > 0 ? merged : null;
  }

  // Direct object with properties
  if (schema.type === 'object' && schema.properties) {
    return { ...schema.properties };
  }

  // Object without explicit type but has properties
  if (schema.properties && !schema.type) {
    return { ...schema.properties };
  }

  return null;
}

/**
 * Get a simplified type signature for a property (for comparison).
 * Returns a basic type that can be compared for compatibility.
 *
 * Trade-off: This is intentionally loose for complex types (refs, arrays) to handle
 * cases where BigCommerce's spec uses inline objects in some places and $refs in others
 * for semantically equivalent schemas. The "smallest superset" heuristic in
 * findMatchingComponent helps reduce false positives from this loose matching.
 */
function getTypeSignature(prop) {
  if (!prop || typeof prop !== 'object') return 'unknown';

  if (prop.$ref) return 'ref';
  if (prop.type === 'array') return 'array';
  return prop.type || 'object';
}

/**
 * Check if inlineProps is a subset of componentProps.
 * Returns true if all properties in inline exist in component with compatible types.
 */
function isSubsetOf(inlineProps, componentProps) {
  if (!inlineProps || !componentProps) return false;

  for (const [propName, inlineProp] of Object.entries(inlineProps)) {
    const componentProp = componentProps[propName];

    // Property must exist in component
    if (!componentProp) {
      return false;
    }

    // Types must be compatible
    const inlineType = getTypeSignature(inlineProp);
    const componentType = getTypeSignature(componentProp);

    // Allow exact match or if inline is less specific
    if (inlineType !== componentType && inlineType !== 'object' && inlineType !== 'unknown') {
      return false;
    }
  }

  return true;
}

// Minimum properties required for subset matching to avoid false positives on tiny schemas
const MIN_PROPERTIES_FOR_MATCH = 3;

/**
 * Find the best matching component schema for an inline schema.
 * Returns the component name if found, null otherwise.
 *
 * Criteria:
 * - Component must be a superset of inline (all inline props exist in component)
 * - Prefer smallest superset (fewest extra properties)
 * - Require at least MIN_PROPERTIES_FOR_MATCH matching properties to avoid false positives
 */
function findMatchingComponent(inlineSchema, componentSchemas) {
  const inlineProps = extractProperties(inlineSchema, componentSchemas);

  if (!inlineProps) return null;

  const inlinePropCount = Object.keys(inlineProps).length;

  if (inlinePropCount < MIN_PROPERTIES_FOR_MATCH) return null;

  let bestMatch = null;
  let bestExtraProps = Infinity;

  for (const [componentName, componentSchema] of Object.entries(componentSchemas)) {
    const componentProps = extractProperties(componentSchema, componentSchemas);
    if (!componentProps) continue;

    const componentPropCount = Object.keys(componentProps).length;

    // Component must have at least as many properties
    if (componentPropCount < inlinePropCount) continue;

    // Check if inline is a subset of component
    if (isSubsetOf(inlineProps, componentProps)) {
      const extraProps = componentPropCount - inlinePropCount;

      // Prefer exact matches, then smallest supersets
      if (extraProps < bestExtraProps) {
        bestMatch = componentName;
        bestExtraProps = extraProps;
      }

      // Exact match - stop searching
      if (extraProps === 0) break;
    }
  }

  return bestMatch;
}

/**
 * Process the spec to replace inline schemas with $refs to existing components.
 * Only processes paths - component schemas are left as-is (they are the canonical definitions).
 */
function deduplicateInlineSchemas(spec) {
  const componentSchemas = spec.components?.schemas || {};
  let replacementCount = 0;

  function processValue(value, path = []) {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) {
      return value.map((item, i) => processValue(item, [...path, i]));
    }
    if (typeof value !== 'object') return value;

    // Skip component schema definitions - they are canonical, don't replace them
    if (path[0] === 'components' && path[1] === 'schemas') {
      // Still recurse to process nested schemas, but don't replace the top-level component
      const result = {};
      for (const [key, val] of Object.entries(value)) {
        result[key] = processValue(val, [...path, key]);
      }
      return result;
    }

    // Check if this looks like an inline object schema that could be deduplicated
    const hasProperties = value.properties || (value.allOf && Array.isArray(value.allOf));
    const isNotRef = !value.$ref;

    if (hasProperties && isNotRef) {
      const matchedComponent = findMatchingComponent(value, componentSchemas);

      if (matchedComponent) {
        console.log(`  Replacing inline schema at ${path.join('.')} -> ${matchedComponent}`);
        replacementCount++;
        return { $ref: `#/components/schemas/${matchedComponent}` };
      }
    }

    // Recurse into object properties
    const result = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = processValue(val, [...path, key]);
    }
    return result;
  }

  const processed = processValue(spec);
  console.log(`  Total replacements: ${replacementCount}`);
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

  // First, collect sibling properties (non-allOf keys) that should be preserved
  const siblingProps = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key !== 'allOf' && value !== undefined) {
      siblingProps[key] = cleanupSpec(value);
    }
  }

  // Handle allOf specially
  if (obj.allOf && Array.isArray(obj.allOf)) {
    // Filter out empty objects
    const filtered = obj.allOf.filter(item => {
      if (item.type === 'object' && item.properties && Object.keys(item.properties).length === 0) {
        return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      // allOf is empty, just return sibling properties
      return Object.keys(siblingProps).length > 0 ? siblingProps : result;
    }

    if (filtered.length === 1) {
      // Unwrap single-item allOf, but preserve sibling properties
      if (filtered[0].$ref) {
        return { $ref: filtered[0].$ref, ...siblingProps };
      } else {
        return { ...cleanupSpec(filtered[0]), ...siblingProps };
      }
    }

    // Multiple items in allOf - keep it
    return { allOf: filtered.map(cleanupSpec), ...siblingProps };
  }

  // No allOf, just return cleaned sibling properties
  return siblingProps;
}

function mergeComponents(target, source, specName) {
  const componentTypes = ['schemas', 'responses', 'parameters', 'requestBodies', 'headers', 'securitySchemes'];

  for (const type of componentTypes) {
    if (source[type]) {
      if (!target[type]) target[type] = {};
      for (const [name, schema] of Object.entries(source[type])) {
        if (target[type][name]) {
          if (!isEqual(target[type][name], schema)) {
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

    // Step 1: Deduplicate inline schemas using subset matching
    console.log('\nStep 1: Deduplicating inline schemas (subset matching)...');
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

    // Validate the resulting spec
    console.log('\nStep 6: Validating OpenAPI spec...');
    await SwaggerParser.validate(outputPath);
    console.log('  Spec is valid!');
  } catch (error) {
    console.error('Error:', error.message || error);
    process.exit(1);
  }
}

main();
