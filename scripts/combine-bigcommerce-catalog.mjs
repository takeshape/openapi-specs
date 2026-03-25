/**
 * Script to combine BigCommerce Catalog API specs into a single OpenAPI specification.
 *
 * Strategy:
 * 1. Combine all specs and merge components
 * 2. Replace inline schemas with $refs to existing components (subset matching)
 * 3. Merge inline allOf extensions into component schemas (e.g., Product + channels -> Product)
 * 4. Rename component schemas to PascalCase
 * 5. Update all $refs to use new PascalCase names
 * 6. Clean up spec (unwrap single-item allOf, remove empty objects, normalize oneOf number/string to number)
 * 7. Validate the resulting OpenAPI spec
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

// ============================================================================
// Schema $ref utilities
// ============================================================================

const SCHEMA_REF_PREFIX = '#/components/schemas/';

/**
 * Check if a value is a $ref to a component schema.
 */
function isSchemaRef(obj) {
  return obj?.$ref?.startsWith(SCHEMA_REF_PREFIX) ?? false;
}

/**
 * Extract the schema name from a $ref object or string.
 * Returns null if not a valid schema ref.
 */
function getSchemaName(obj) {
  const ref = typeof obj === 'string' ? obj : obj?.$ref;
  if (!ref?.startsWith(SCHEMA_REF_PREFIX)) return null;
  return ref.replace(SCHEMA_REF_PREFIX, '');
}

/**
 * Create a $ref object pointing to a component schema.
 */
function makeSchemaRef(name) {
  return { $ref: `${SCHEMA_REF_PREFIX}${name}` };
}

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
  if (isSchemaRef(schema)) {
    const refName = getSchemaName(schema);
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
        return makeSchemaRef(matchedComponent);
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

// ============================================================================
// Merge inline allOf extensions into component schemas
// ============================================================================

/**
 * Find allOf patterns like [$ref: Component, {inline props}] and merge the inline
 * props into the component schema, then replace the allOf with a simple $ref.
 *
 * This simplifies the spec and helps the transform generate cleaner types.
 */
function mergeInlineExtensions(spec) {
  const componentSchemas = spec.components?.schemas || {};
  const mergedProps = new Map(); // Track what we've merged into each component

  /**
   * Check if an allOf can be simplified by merging into a component.
   * Returns { refName, propsToMerge } if simplifiable, null otherwise.
   */
  function canSimplifyAllOf(allOf) {
    if (!Array.isArray(allOf) || allOf.length !== 2) return null;

    // Find the $ref item and the inline object item
    const refItem = allOf.find(item => isSchemaRef(item));
    const inlineItem = allOf.find(item => !item.$ref && item.properties);

    if (!refItem || !inlineItem) return null;

    const refName = getSchemaName(refItem);

    // Make sure the component exists
    if (!componentSchemas[refName]) return null;

    return { refName, propsToMerge: inlineItem.properties };
  }

  /**
   * Process the spec to find and simplify allOf patterns.
   */
  function processValue(value, path = []) {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) {
      return value.map((item, i) => processValue(item, [...path, i]));
    }
    if (typeof value !== 'object') return value;

    // Skip component schema definitions themselves
    if (path[0] === 'components' && path[1] === 'schemas') {
      const result = {};
      for (const [key, val] of Object.entries(value)) {
        result[key] = processValue(val, [...path, key]);
      }
      return result;
    }

    // Check if this object has an allOf that can be simplified
    if (value.allOf) {
      const simplification = canSimplifyAllOf(value.allOf);
      if (simplification) {
        const { refName, propsToMerge } = simplification;

        // Track merged properties
        if (!mergedProps.has(refName)) {
          mergedProps.set(refName, {});
        }
        Object.assign(mergedProps.get(refName), propsToMerge);

        console.log(`  Merging inline props into ${refName}: ${Object.keys(propsToMerge).join(', ')}`);

        // Return simplified $ref, preserving sibling properties like title
        const { allOf, ...siblings } = value;
        return { ...makeSchemaRef(refName), ...siblings };
      }
    }

    // Recurse into object properties
    const result = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = processValue(val, [...path, key]);
    }
    return result;
  }

  // Process the spec
  const processed = processValue(spec);

  // Now merge the collected properties into component schemas
  for (const [componentName, props] of mergedProps) {
    const component = processed.components.schemas[componentName];
    if (!component) continue;

    // If component uses allOf, add properties to the last item or create a new item
    if (component.allOf && Array.isArray(component.allOf)) {
      // Find an existing inline object to merge into, or add a new one
      let targetItem = component.allOf.find(item => !item.$ref && item.properties);
      if (targetItem) {
        targetItem.properties = { ...targetItem.properties, ...props };
      } else {
        component.allOf.push({ type: 'object', properties: props });
      }
    } else if (component.properties) {
      // Simple object schema - just add properties
      component.properties = { ...component.properties, ...props };
    } else {
      // Convert to object with properties
      component.type = 'object';
      component.properties = props;
    }
  }

  console.log(`  Merged properties into ${mergedProps.size} component schemas`);
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
    if (key === '$ref' && getSchemaName(value)) {
      const oldName = getSchemaName(value);
      const newName = nameMap.get(oldName) || oldName;
      result[key] = makeSchemaRef(newName).$ref;
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
 * Check if a oneOf represents a number/string union (common in BigCommerce for amounts).
 * Returns true if oneOf contains exactly number and string types.
 */
function isNumberStringUnion(oneOf) {
  if (!Array.isArray(oneOf) || oneOf.length !== 2) return false;
  const types = oneOf.map(item => item.type).sort();
  return types[0] === 'number' && types[1] === 'string';
}

/**
 * Clean up the spec - remove empty allOf, unwrap single-item allOf, normalize oneOf, etc.
 */
function cleanupSpec(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(cleanupSpec);
  if (typeof obj !== 'object') return obj;

  const result = {};

  // First, collect sibling properties (non-allOf/oneOf keys) that should be preserved
  const siblingProps = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key !== 'allOf' && key !== 'oneOf' && value !== undefined) {
      siblingProps[key] = cleanupSpec(value);
    }
  }

  // Handle oneOf with number/string union - normalize to number
  if (obj.oneOf && isNumberStringUnion(obj.oneOf)) {
    const numberSchema = obj.oneOf.find(item => item.type === 'number');
    return { type: 'number', ...numberSchema, ...siblingProps };
  }

  // Handle other oneOf - just recurse
  if (obj.oneOf && Array.isArray(obj.oneOf)) {
    return { oneOf: obj.oneOf.map(cleanupSpec), ...siblingProps };
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

/**
 * Fix BigCommerce spec issues - add missing properties to schemas.
 * The BigCommerce spec doesn't include `variants` in the response schemas,
 * even though the API returns variants when include=variants is used.
 */
function fixSpecIssues(spec) {
  const schemas = spec.components?.schemas;
  if (!schemas) return spec;

  // Add variants property to product_Full (which becomes Product after renaming)
  // The API returns variants when include=variants is used
  const productSchema = schemas.product_Full;

  if (productSchema && !hasVariantsProperty(productSchema)) {
    console.log('  Adding variants to product_Full');
    addVariantsProperty(productSchema, schemas);
  }

  return spec;
}

function hasVariantsProperty(schema) {
  if (schema.properties?.variants) return true;
  if (schema.allOf) {
    for (const item of schema.allOf) {
      if (item.properties?.variants) return true;
    }
  }
  return false;
}

function addVariantsProperty(schema, allSchemas) {
  const variantsProperty = {
    type: 'array',
    items: makeSchemaRef('productVariant_Full'),
    description: 'Product variants. Only returned when include=variants is specified.'
  };

  if (schema.allOf) {
    // Add to an existing properties object in allOf, or create one
    let propsItem = schema.allOf.find(item => item.properties && !item.$ref);
    if (propsItem) {
      propsItem.properties.variants = variantsProperty;
    } else {
      schema.allOf.push({ type: 'object', properties: { variants: variantsProperty } });
    }
  } else if (schema.properties) {
    schema.properties.variants = variantsProperty;
  }
}

/**
 * Count how many times each component schema is referenced in the spec.
 */
function countSchemaRefs(spec) {
  const refCounts = new Map();

  function countRefs(obj) {
    if (obj === null || obj === undefined) return;
    if (Array.isArray(obj)) {
      obj.forEach(countRefs);
      return;
    }
    if (typeof obj !== 'object') return;

    if (isSchemaRef(obj)) {
      const refName = getSchemaName(obj);
      refCounts.set(refName, (refCounts.get(refName) || 0) + 1);
    }

    for (const value of Object.values(obj)) {
      countRefs(value);
    }
  }

  countRefs(spec);
  return refCounts;
}

/**
 * Flatten component schemas that use allOf with a $ref to a component that's only used once.
 * This merges the referenced schema's properties directly into the parent schema.
 */
function flattenSingleUseAllOf(spec) {
  const schemas = spec.components?.schemas;
  if (!schemas) return spec;

  const refCounts = countSchemaRefs(spec);
  const schemasToRemove = new Set();

  for (const [schemaName, schema] of Object.entries(schemas)) {
    if (!schema.allOf || !Array.isArray(schema.allOf)) continue;

    // Find $refs in this allOf that are only used once
    const refsToFlatten = [];
    for (const item of schema.allOf) {
      if (isSchemaRef(item)) {
        const refName = getSchemaName(item);
        if (refCounts.get(refName) === 1 && schemas[refName]) {
          refsToFlatten.push(refName);
        }
      }
    }

    if (refsToFlatten.length === 0) continue;

    // Merge properties from single-use refs into this schema
    const mergedProperties = {};
    const newAllOf = [];

    for (const item of schema.allOf) {
      if (isSchemaRef(item)) {
        const refName = getSchemaName(item);
        if (refsToFlatten.includes(refName)) {
          const refSchema = schemas[refName];
          if (refSchema.properties) {
            Object.assign(mergedProperties, refSchema.properties);
          }
          schemasToRemove.add(refName);
          console.log(`  Flattening ${refName} into ${schemaName}`);
          continue;
        }
      }

      // Keep non-flattened items
      if (item.properties) {
        Object.assign(mergedProperties, item.properties);
      } else {
        newAllOf.push(item);
      }
    }

    // Update the schema
    if (newAllOf.length === 0) {
      // All items were flattened - convert to simple object
      delete schema.allOf;
      schema.type = 'object';
      schema.properties = mergedProperties;
    } else {
      // Some items remain - keep allOf but add merged properties
      schema.allOf = [...newAllOf, { type: 'object', properties: mergedProperties }];
    }
  }

  // Remove flattened schemas
  for (const name of schemasToRemove) {
    delete schemas[name];
  }

  console.log(`  Removed ${schemasToRemove.size} single-use schemas`);
  return spec;
}

async function main() {
  console.log('Combining BigCommerce Catalog API specs...\n');

  try {
    let spec = await combineSpecs();

    console.log(`\nMerged ${Object.keys(spec.components?.schemas ?? {}).length} component schemas`);

    // Step 0: Fix BigCommerce spec issues
    console.log('\nStep 0: Fixing BigCommerce spec issues...');
    spec = fixSpecIssues(spec);

    // Step 0.5: Flatten single-use allOf references
    console.log('\nStep 0.5: Flattening single-use allOf references...');
    spec = flattenSingleUseAllOf(spec);

    // Step 1: Deduplicate inline schemas using subset matching
    console.log('\nStep 1: Deduplicating inline schemas (subset matching)...');
    spec = deduplicateInlineSchemas(spec);

    // Step 2: Merge inline allOf extensions into component schemas
    console.log('\nStep 2: Merging inline allOf extensions into components...');
    spec = mergeInlineExtensions(spec);

    // Step 3: Build name map for PascalCase conversion
    console.log('\nStep 3: Building PascalCase name map...');
    const nameMap = buildNameMap(spec.components.schemas);

    // Log example renames
    const examples = ['productVariant_Base', 'productVariant_Full', 'metaCollection_Full', 'brand_Full', 'error_Base'];
    for (const ex of examples) {
      if (nameMap.has(ex)) {
        console.log(`  ${ex} -> ${nameMap.get(ex)}`);
      }
    }

    // Step 4: Rename schemas
    console.log('\nStep 4: Renaming schemas to PascalCase...');
    spec.components = renameSchemas(spec.components, nameMap);

    // Step 5: Update all $refs
    console.log('Step 5: Updating $refs to new names...');
    spec = updateRefs(spec, nameMap);

    // Step 6: Clean up
    console.log('Step 6: Cleaning up spec...');
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
    console.log('\nStep 7: Validating OpenAPI spec...');
    await SwaggerParser.validate(outputPath);
    console.log('  Spec is valid!');
  } catch (error) {
    console.error('Error:', error.message || error);
    process.exit(1);
  }
}

main();
