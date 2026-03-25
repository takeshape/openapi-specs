#!/usr/bin/env -S npx tsx
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
 * Usage: ./scripts/combine-bigcommerce-catalog.ts
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import got from 'got';
import yaml from 'js-yaml';
import type { OpenAPIV3 } from 'openapi-types';

import {
  buildNameMap,
  cleanupSpec,
  countSchemaRefs,
  getSchemaName,
  isSchemaRef,
  makeSchemaRef,
  mergeComponents,
  mergeTags,
  type OpenAPISpec,
  type ReferenceObject,
  renameSchemas,
  type SchemaObject,
  traverseSpec,
  updateRefs
} from './lib/openapi.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// BigCommerce-specific configuration
// ============================================================================

const BIGCOMMERCE_DOCS_BASE_URL = 'https://raw.githubusercontent.com/bigcommerce/docs/main/reference/catalog';

const CATALOG_SPECS = [
  'brands_catalog.v3.yml',
  'categories_catalog.v3.yml',
  'category-trees_catalog.v3.yml',
  'product-modifiers_catalog.v3.yml',
  'product-variant-options_catalog.v3.yml',
  'product-variants_catalog.v3.yml',
  'products_catalog.v3.yml'
];

async function fetchSpec(specName: string): Promise<OpenAPISpec> {
  const url = `${BIGCOMMERCE_DOCS_BASE_URL}/${specName}`;
  console.log(`Fetching ${specName}...`);
  const response = await got.get(url).text();
  return yaml.load(response) as OpenAPISpec;
}

// ============================================================================
// Subset Matching - Replace inline schemas with $refs to component schemas
// ============================================================================

type PropertyMap = Record<string, unknown>;

/**
 * Extract properties from a schema, flattening allOf if present.
 * Returns a map of property name -> property schema, or null if not an object schema.
 */
function extractProperties(schema: unknown, componentSchemas: Record<string, SchemaObject> = {}): PropertyMap | null {
  if (!schema || typeof schema !== 'object') return null;

  const schemaObj = schema as Record<string, unknown>;

  // If it's a $ref, resolve it
  if (isSchemaRef(schema)) {
    const refName = getSchemaName(schema);
    if (refName) {
      const resolved = componentSchemas[refName];
      if (resolved) {
        return extractProperties(resolved, componentSchemas);
      }
    }
    return null;
  }

  // If it has allOf, merge all properties
  if (schemaObj.allOf && Array.isArray(schemaObj.allOf)) {
    const merged: PropertyMap = {};
    for (const item of schemaObj.allOf) {
      const props = extractProperties(item, componentSchemas);
      if (props) {
        Object.assign(merged, props);
      }
    }
    return Object.keys(merged).length > 0 ? merged : null;
  }

  // Direct object with properties
  if (schemaObj.type === 'object' && schemaObj.properties) {
    return { ...(schemaObj.properties as PropertyMap) };
  }

  // Object without explicit type but has properties
  if (schemaObj.properties && !schemaObj.type) {
    return { ...(schemaObj.properties as PropertyMap) };
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
function getTypeSignature(prop: unknown): string {
  if (!prop || typeof prop !== 'object') return 'unknown';

  const propObj = prop as Record<string, unknown>;
  if (propObj.$ref) return 'ref';
  if (propObj.type === 'array') return 'array';
  return (propObj.type as string) || 'object';
}

/**
 * Check if inlineProps is a subset of componentProps.
 * Returns true if all properties in inline exist in component with compatible types.
 */
function isSubsetOf(inlineProps: PropertyMap | null, componentProps: PropertyMap | null): boolean {
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
function findMatchingComponent(inlineSchema: unknown, componentSchemas: Record<string, SchemaObject>): string | null {
  const inlineProps = extractProperties(inlineSchema, componentSchemas);

  if (!inlineProps) return null;

  const inlinePropCount = Object.keys(inlineProps).length;

  if (inlinePropCount < MIN_PROPERTIES_FOR_MATCH) return null;

  let bestMatch: string | null = null;
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
function deduplicateInlineSchemas(spec: OpenAPISpec): OpenAPISpec {
  const componentSchemas = (spec.components?.schemas || {}) as Record<string, SchemaObject>;
  let replacementCount = 0;

  const processed = traverseSpec(spec, (valueObj, path) => {
    // Check if this looks like an inline object schema that could be deduplicated
    const hasProperties = valueObj.properties || (valueObj.allOf && Array.isArray(valueObj.allOf));
    const isNotRef = !valueObj.$ref;

    if (hasProperties && isNotRef) {
      const matchedComponent = findMatchingComponent(valueObj, componentSchemas);

      if (matchedComponent) {
        console.log(`  Replacing inline schema at ${path.join('.')} -> ${matchedComponent}`);
        replacementCount++;
        return makeSchemaRef(matchedComponent);
      }
    }

    return undefined; // Use default recursion
  });

  console.log(`  Total replacements: ${replacementCount}`);
  return processed;
}

// ============================================================================
// Merge inline allOf extensions into component schemas
// ============================================================================

interface SimplificationResult {
  refName: string;
  propsToMerge: Record<string, unknown>;
}

/**
 * Find allOf patterns like [$ref: Component, {inline props}] and merge the inline
 * props into the component schema, then replace the allOf with a simple $ref.
 *
 * This simplifies the spec and helps the transform generate cleaner types.
 */
function mergeInlineExtensions(spec: OpenAPISpec): OpenAPISpec {
  const componentSchemas = (spec.components?.schemas || {}) as Record<string, SchemaObject>;
  const mergedProps = new Map<string, Record<string, unknown>>();

  /**
   * Check if an allOf can be simplified by merging into a component.
   * Returns { refName, propsToMerge } if simplifiable, null otherwise.
   */
  function canSimplifyAllOf(allOf: unknown[]): SimplificationResult | null {
    if (!Array.isArray(allOf) || allOf.length !== 2) return null;

    // Find the $ref item and the inline object item
    const refItem = allOf.find((item) => isSchemaRef(item)) as ReferenceObject | undefined;
    const inlineItem = allOf.find((item) => {
      const itemObj = item as Record<string, unknown>;
      return !itemObj.$ref && itemObj.properties;
    }) as Record<string, unknown> | undefined;

    if (!refItem || !inlineItem) return null;

    const refName = getSchemaName(refItem);

    // Make sure the component exists
    if (!refName || !componentSchemas[refName]) return null;

    return { refName, propsToMerge: inlineItem.properties as Record<string, unknown> };
  }

  const processed = traverseSpec(spec, (valueObj) => {
    // Check if this object has an allOf that can be simplified
    if (valueObj.allOf) {
      const simplification = canSimplifyAllOf(valueObj.allOf as unknown[]);
      if (simplification) {
        const { refName, propsToMerge } = simplification;

        // Track merged properties
        const existing = mergedProps.get(refName) ?? {};
        mergedProps.set(refName, { ...existing, ...propsToMerge });

        console.log(`  Merging inline props into ${refName}: ${Object.keys(propsToMerge).join(', ')}`);

        // Return simplified $ref, preserving sibling properties like title
        const { allOf: _, ...siblings } = valueObj;
        return { ...makeSchemaRef(refName), ...siblings };
      }
    }

    return undefined; // Use default recursion
  });

  // Now merge the collected properties into component schemas
  for (const [componentName, props] of mergedProps) {
    const component = processed.components?.schemas?.[componentName] as Record<string, unknown> | undefined;
    if (!component) continue;

    // If component uses allOf, add properties to the last item or create a new item
    if (component.allOf && Array.isArray(component.allOf)) {
      // Find an existing inline object to merge into, or add a new one
      const targetItem = component.allOf.find((item) => {
        const itemObj = item as Record<string, unknown>;
        return !itemObj.$ref && itemObj.properties;
      }) as Record<string, unknown> | undefined;

      if (targetItem) {
        targetItem.properties = { ...(targetItem.properties as Record<string, unknown>), ...props };
      } else {
        component.allOf.push({ type: 'object', properties: props });
      }
    } else if (component.properties) {
      // Simple object schema - just add properties
      component.properties = { ...(component.properties as Record<string, unknown>), ...props };
    } else {
      // Convert to object with properties
      component.type = 'object';
      component.properties = props;
    }
  }

  console.log(`  Merged properties into ${mergedProps.size} component schemas`);
  return processed;
}

// ============================================================================
// Flatten single-use allOf references
// ============================================================================

/**
 * Find $refs in an allOf that are only used once in the entire spec.
 */
function findSingleUseRefs(
  allOf: unknown[],
  schemas: Record<string, SchemaObject>,
  refCounts: Map<string, number>
): string[] {
  const refs: string[] = [];
  for (const item of allOf) {
    if (!isSchemaRef(item)) continue;
    const refName = getSchemaName(item);
    if (refName && refCounts.get(refName) === 1 && schemas[refName]) {
      refs.push(refName);
    }
  }
  return refs;
}

interface MergeResult {
  mergedProperties: Record<string, unknown>;
  newAllOf: unknown[];
  flattenedRefs: string[];
}

/**
 * Merge allOf items, flattening single-use refs into properties.
 * Returns { mergedProperties, newAllOf, flattenedRefs }.
 */
function mergeAllOfItems(
  allOf: unknown[],
  refsToFlatten: string[],
  schemas: Record<string, SchemaObject>
): MergeResult {
  const mergedProperties: Record<string, unknown> = {};
  const newAllOf: unknown[] = [];
  const flattenedRefs: string[] = [];

  for (const item of allOf) {
    if (isSchemaRef(item)) {
      const refName = getSchemaName(item);
      if (refName && refsToFlatten.includes(refName)) {
        const refSchema = schemas[refName] as Record<string, unknown>;
        if (refSchema.properties) {
          Object.assign(mergedProperties, refSchema.properties);
        }
        flattenedRefs.push(refName);
        continue;
      }
    }

    // Keep non-flattened items
    const itemObj = item as Record<string, unknown>;
    if (itemObj.properties) {
      Object.assign(mergedProperties, itemObj.properties);
    } else {
      newAllOf.push(item);
    }
  }

  return { mergedProperties, newAllOf, flattenedRefs };
}

/**
 * Update a schema after flattening its allOf.
 */
function applyFlattenedSchema(
  schema: Record<string, unknown>,
  newAllOf: unknown[],
  mergedProperties: Record<string, unknown>
): void {
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

/**
 * Flatten component schemas that use allOf with a $ref to a component that's only used once.
 * This merges the referenced schema's properties directly into the parent schema.
 */
function flattenSingleUseAllOf(spec: OpenAPISpec): OpenAPISpec {
  const schemas = spec.components?.schemas as Record<string, SchemaObject> | undefined;
  if (!schemas) return spec;

  const refCounts = countSchemaRefs(spec);
  const schemasToRemove = new Set<string>();

  for (const [schemaName, schema] of Object.entries(schemas)) {
    const schemaObj = schema as Record<string, unknown>;
    if (!schemaObj.allOf || !Array.isArray(schemaObj.allOf)) continue;

    const refsToFlatten = findSingleUseRefs(schemaObj.allOf, schemas, refCounts);
    if (refsToFlatten.length === 0) continue;

    const { mergedProperties, newAllOf, flattenedRefs } = mergeAllOfItems(schemaObj.allOf, refsToFlatten, schemas);

    for (const refName of flattenedRefs) {
      schemasToRemove.add(refName);
      console.log(`  Flattening ${refName} into ${schemaName}`);
    }

    applyFlattenedSchema(schemaObj, newAllOf, mergedProperties);
  }

  // Remove flattened schemas
  for (const name of schemasToRemove) {
    delete schemas[name];
  }

  console.log(`  Removed ${schemasToRemove.size} single-use schemas`);
  return spec;
}

// ============================================================================
// BigCommerce-specific fixes
// ============================================================================

/**
 * Fix BigCommerce spec issues - add missing properties to schemas.
 * The BigCommerce spec doesn't include `variants` in the response schemas,
 * even though the API returns variants when include=variants is used.
 */
function fixSpecIssues(spec: OpenAPISpec): OpenAPISpec {
  const schemas = spec.components?.schemas as Record<string, SchemaObject> | undefined;
  if (!schemas) return spec;

  // Add variants property to product_Full (which becomes Product after renaming)
  // The API returns variants when include=variants is used
  const productSchema = schemas.product_Full as Record<string, unknown> | undefined;

  if (productSchema && !hasVariantsProperty(productSchema)) {
    console.log('  Adding variants to product_Full');
    addVariantsProperty(productSchema);
  }

  return spec;
}

function hasVariantsProperty(schema: Record<string, unknown>): boolean {
  const props = schema.properties as Record<string, unknown> | undefined;
  if (props?.variants) return true;
  if (schema.allOf && Array.isArray(schema.allOf)) {
    for (const item of schema.allOf) {
      const itemObj = item as Record<string, unknown>;
      const itemProps = itemObj.properties as Record<string, unknown> | undefined;
      if (itemProps?.variants) return true;
    }
  }
  return false;
}

function addVariantsProperty(schema: Record<string, unknown>): void {
  const variantsProperty = {
    type: 'array',
    items: makeSchemaRef('productVariant_Full'),
    description: 'Product variants. Only returned when include=variants is specified.'
  };

  if (schema.allOf && Array.isArray(schema.allOf)) {
    // Add to an existing properties object in allOf, or create one
    const propsItem = schema.allOf.find((item) => {
      const itemObj = item as Record<string, unknown>;
      return itemObj.properties && !itemObj.$ref;
    }) as Record<string, unknown> | undefined;

    if (propsItem) {
      (propsItem.properties as Record<string, unknown>).variants = variantsProperty;
    } else {
      schema.allOf.push({ type: 'object', properties: { variants: variantsProperty } });
    }
  } else if (schema.properties) {
    (schema.properties as Record<string, unknown>).variants = variantsProperty;
  }
}

// ============================================================================
// Spec combining
// ============================================================================

async function combineSpecs(): Promise<OpenAPISpec> {
  const combined: OpenAPISpec = {
    openapi: '3.0.3',
    info: {
      title: 'BigCommerce Catalog API',
      description:
        'Combined BigCommerce Catalog API specification including products, categories, brands, and variants.',
      version: '1.0.0'
    },
    servers: [
      {
        url: 'https://api.bigcommerce.com/stores/{store_hash}/v3',
        variables: { store_hash: { default: 'your_store_hash' } }
      }
    ],
    tags: [],
    paths: {},
    components: { schemas: {}, parameters: {}, responses: {} }
  };

  const components = combined.components as OpenAPIV3.ComponentsObject;
  const tags = combined.tags as OpenAPIV3.TagObject[];

  for (const specName of CATALOG_SPECS) {
    const spec = await fetchSpec(specName);

    for (const [path, pathItem] of Object.entries(spec.paths || {})) {
      const existing = combined.paths[path];
      if (existing) {
        Object.assign(existing, pathItem);
      } else {
        combined.paths[path] = pathItem;
      }
    }

    if (spec.components) {
      mergeComponents(components, spec.components, specName);
    }
    mergeTags(tags, spec.tags);
  }

  // Sort paths and tags
  const sortedPaths: OpenAPIV3.PathsObject = {};
  for (const path of Object.keys(combined.paths).sort()) {
    sortedPaths[path] = combined.paths[path];
  }
  combined.paths = sortedPaths;
  tags.sort((a, b) => a.name.localeCompare(b.name));

  return combined;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
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
    const schemas = (spec.components?.schemas ?? {}) as Record<string, SchemaObject>;
    const nameMap = buildNameMap(schemas);

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
    spec = updateRefs(spec, nameMap) as OpenAPISpec;

    // Step 6: Clean up
    console.log('Step 6: Cleaning up spec...');
    spec = cleanupSpec(spec) as OpenAPISpec;

    const outputPath = join(__dirname, '..', 'specs', 'bigcommerce', 'catalog.v3.yml');
    const yamlOutput = yaml.dump(spec, { lineWidth: 120, noRefs: true, sortKeys: false });
    writeFileSync(outputPath, yamlOutput, 'utf8');

    console.log(`\nCombined spec written to: ${outputPath}`);
    console.log('\nSummary:');
    console.log(`  - Paths: ${Object.keys(spec.paths).length}`);
    console.log(`  - Schemas: ${Object.keys(spec.components?.schemas ?? {}).length}`);
    console.log(`  - Tags: ${spec.tags?.length ?? 0}`);

    // Validate the resulting spec
    console.log('\nStep 7: Validating OpenAPI spec...');
    await SwaggerParser.validate(outputPath);
    console.log('  Spec is valid!');
  } catch (error) {
    console.error('Error:', (error as Error).message || error);
    process.exit(1);
  }
}

main();
