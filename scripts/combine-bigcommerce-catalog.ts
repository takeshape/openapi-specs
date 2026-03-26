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
import camelCase from 'lodash/camelCase.js';
import upperFirst from 'lodash/upperFirst.js';
import type { OpenAPIV3 } from 'openapi-types';

import {
  buildNameMap,
  type ComponentSchemas,
  cleanupSpec,
  deepCloneWithPath,
  flattenSingleUseAllOf,
  getComponentSchemas,
  getSchemaName,
  isObjectSchema,
  isPlainObject,
  isSchemaRef,
  makeSchemaRef,
  mergeComponents,
  mergeTags,
  type OpenAPISpec,
  type PlainObject,
  renameSchemas,
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

/**
 * Convert a name to PascalCase using lodash.
 */
function toPascalCase(name: string): string {
  return upperFirst(camelCase(name));
}

/**
 * BigCommerce schema names use _Full suffix for "full" response types.
 * We treat these as the canonical type and remove the suffix before converting to PascalCase.
 */
function transformSchemaName(name: string): string {
  return toPascalCase(name.replace(/_Full$/, ''));
}

/**
 * Find schemas that should be removed because they're duplicates.
 * For each _Full schema, check if there's a PascalCase duplicate to remove.
 */
function findDuplicateSchemas(schemaNames: string[]): Set<string> {
  const duplicates = new Set<string>();
  const nameSet = new Set(schemaNames);

  for (const name of schemaNames) {
    if (name.endsWith('_Full')) {
      // e.g., pagination_Full -> Pagination
      const pascalDuplicate = toPascalCase(name.replace(/_Full$/, ''));
      if (nameSet.has(pascalDuplicate)) {
        duplicates.add(pascalDuplicate);
      }
    }
  }

  return duplicates;
}

/**
 * Check if a oneOf represents a number/string union.
 * BigCommerce uses these for monetary amounts - we normalize to just number.
 */
function isNumberStringUnion(oneOf: unknown[]): boolean {
  if (oneOf.length !== 2) return false;
  const types = oneOf.map((item) => (isPlainObject(item) && 'type' in item ? item.type : null)).sort();
  return types[0] === 'number' && types[1] === 'string';
}

/**
 * Normalize BigCommerce number/string unions to just number.
 * This simplifies type generation since both represent monetary values.
 */
function normalizeNumberStringUnions<T>(obj: T): T {
  return deepCloneWithPath(obj, (value) => {
    if (!isPlainObject(value)) return undefined;

    const oneOf = value.oneOf;
    if (!Array.isArray(oneOf) || !isNumberStringUnion(oneOf)) return undefined;

    const numberSchema = oneOf.find((item) => isPlainObject(item) && item.type === 'number');
    const { oneOf: _, ...rest } = value;
    return { type: 'number', ...(numberSchema as PlainObject), ...rest };
  }) as T;
}

async function fetchSpec(specName: string): Promise<OpenAPISpec> {
  const url = `${BIGCOMMERCE_DOCS_BASE_URL}/${specName}`;
  console.log(`Fetching ${specName}...`);
  const response = await got.get(url).text();
  const parsed = yaml.load(response);
  // Validate structure without dereferencing (which would create circular refs)
  // SwaggerParser.parse validates the spec is well-formed OpenAPI
  const validated = await SwaggerParser.parse(parsed as OpenAPISpec);
  return validated as OpenAPISpec;
}

// ============================================================================
// Subset Matching - Replace inline schemas with $refs to component schemas
// ============================================================================

type PropertyMap = PlainObject;

/**
 * Extract properties from a schema, flattening allOf if present.
 * Returns a map of property name -> property schema, or null if not an object schema.
 */
function extractProperties(schema: unknown, componentSchemas: ComponentSchemas = {}): PropertyMap | null {
  if (!isPlainObject(schema)) return null;

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
  if (Array.isArray(schema.allOf)) {
    const merged: PropertyMap = {};
    for (const item of schema.allOf) {
      const props = extractProperties(item, componentSchemas);
      if (props) {
        Object.assign(merged, props);
      }
    }
    return Object.keys(merged).length > 0 ? merged : null;
  }

  // Object with properties (with or without explicit type: 'object')
  if (isObjectSchema(schema)) {
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
function getTypeSignature(prop: unknown): string {
  if (!isPlainObject(prop)) return 'unknown';
  if (prop.$ref) return 'ref';
  if (prop.type === 'array') return 'array';
  return typeof prop.type === 'string' ? prop.type : 'object';
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

/**
 * Minimum properties required for subset matching.
 *
 * Why 3? Schemas with 1-2 properties (e.g., {id, name}) are too generic and match
 * many unrelated components, causing false positive replacements. With 3+ properties,
 * matches are specific enough to be meaningful. Empirically tested against BigCommerce
 * specs where 2 caused incorrect matches, 3 produced accurate deduplication.
 */
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
function findMatchingComponent(inlineSchema: unknown, componentSchemas: ComponentSchemas): string | null {
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
  const componentSchemas = getComponentSchemas(spec);
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
 * Returns a new spec - does not mutate the input.
 */
function mergeInlineExtensions(spec: OpenAPISpec): OpenAPISpec {
  const componentSchemas = getComponentSchemas(spec);
  const mergedProps = new Map<string, Record<string, unknown>>();

  function tryExtractSimplifiableAllOf(allOf: unknown[]): SimplificationResult | null {
    if (allOf.length !== 2) return null;

    const refItem = allOf.find((item) => isSchemaRef(item));
    const inlineItem = allOf.find((item) => isObjectSchema(item) && !item.$ref);

    if (!refItem || !isObjectSchema(inlineItem)) return null;

    const refName = getSchemaName(refItem);
    if (!refName || !componentSchemas[refName]) return null;

    return { refName, propsToMerge: inlineItem.properties };
  }

  const processed = traverseSpec(spec, (valueObj) => {
    if (Array.isArray(valueObj.allOf)) {
      const simplification = tryExtractSimplifiableAllOf(valueObj.allOf);
      if (simplification) {
        const { refName, propsToMerge } = simplification;

        const existing = mergedProps.get(refName) ?? {};
        mergedProps.set(refName, { ...existing, ...propsToMerge });

        console.log(`  Merging inline props into ${refName}: ${Object.keys(propsToMerge).join(', ')}`);

        const { allOf: _, ...siblings } = valueObj;
        return { ...makeSchemaRef(refName), ...siblings };
      }
    }
    return undefined;
  });

  if (mergedProps.size === 0) {
    console.log('  Merged properties into 0 component schemas');
    return processed;
  }

  // Build new schemas with merged properties
  const newSchemas: Record<string, OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject> = {};

  for (const [name, schema] of Object.entries(processed.components?.schemas ?? {})) {
    const props = mergedProps.get(name);
    if (!props) {
      newSchemas[name] = schema;
      continue;
    }

    if (!isPlainObject(schema)) {
      newSchemas[name] = schema;
      continue;
    }

    newSchemas[name] = mergePropsIntoSchema(schema, props);
  }

  console.log(`  Merged properties into ${mergedProps.size} component schemas`);

  return {
    ...processed,
    components: {
      ...processed.components,
      schemas: newSchemas
    }
  };
}

function mergePropsIntoSchema(schema: PlainObject, props: Record<string, unknown>): OpenAPIV3.SchemaObject {
  if (Array.isArray(schema.allOf)) {
    const targetIndex = schema.allOf.findIndex((item) => isObjectSchema(item) && !item.$ref);

    if (targetIndex >= 0) {
      const target = schema.allOf[targetIndex] as PlainObject;
      const newAllOf = [...schema.allOf];
      newAllOf[targetIndex] = {
        ...target,
        properties: { ...(target.properties as PlainObject), ...props }
      };
      return { ...schema, allOf: newAllOf } as OpenAPIV3.SchemaObject;
    }

    return {
      ...schema,
      allOf: [...schema.allOf, { type: 'object', properties: props }]
    } as OpenAPIV3.SchemaObject;
  }

  if (isObjectSchema(schema)) {
    return {
      ...schema,
      properties: { ...schema.properties, ...props }
    } as OpenAPIV3.SchemaObject;
  }

  return { ...schema, type: 'object', properties: props } as OpenAPIV3.SchemaObject;
}

// ============================================================================
// BigCommerce-specific fixes
// ============================================================================

/**
 * Fix BigCommerce spec issues - add missing properties to schemas.
 * Must be called after flattening so schemas are simple objects.
 * Returns a new spec - does not mutate the input.
 */
function fixSpecIssues(spec: OpenAPISpec): OpenAPISpec {
  const schemas = spec.components?.schemas;
  if (!schemas) return spec;

  const productSchema = schemas.product_Full;

  if (!isObjectSchema(productSchema) || productSchema.properties.variants) {
    return spec;
  }

  console.log('  Adding variants to product_Full');

  return {
    ...spec,
    components: {
      ...spec.components,
      schemas: {
        ...schemas,
        product_Full: {
          ...productSchema,
          properties: {
            ...productSchema.properties,
            variants: {
              type: 'array',
              items: makeSchemaRef('productVariant_Full'),
              description: 'Product variants. Only returned when include=variants is specified.'
            }
          }
        }
      }
    }
  };
}

// ============================================================================
// Spec combining
// ============================================================================

async function combineSpecs(): Promise<OpenAPISpec> {
  let components: OpenAPIV3.ComponentsObject = { schemas: {}, parameters: {}, responses: {} };
  let tags: OpenAPIV3.TagObject[] = [];
  const paths: OpenAPIV3.PathsObject = {};

  for (const specName of CATALOG_SPECS) {
    const spec = await fetchSpec(specName);

    for (const [path, pathItem] of Object.entries(spec.paths || {})) {
      const existing = paths[path];
      if (existing) {
        Object.assign(existing, pathItem);
      } else {
        paths[path] = pathItem;
      }
    }

    if (spec.components) {
      components = mergeComponents(components, spec.components, specName);
    }
    tags = mergeTags(tags, spec.tags);
  }

  // Sort paths and tags
  const sortedPaths: OpenAPIV3.PathsObject = {};
  for (const path of Object.keys(paths).sort()) {
    sortedPaths[path] = paths[path];
  }
  tags.sort((a, b) => a.name.localeCompare(b.name));

  return {
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
    tags,
    paths: sortedPaths,
    components
  };
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('Combining BigCommerce Catalog API specs...\n');

  try {
    let spec = await combineSpecs();

    console.log(`\nMerged ${Object.keys(spec.components?.schemas ?? {}).length} component schemas`);

    console.log('\nStep 1: Flattening single-use allOf references...');
    spec = flattenSingleUseAllOf(spec);

    console.log('\nStep 2: Fixing BigCommerce spec issues...');
    spec = fixSpecIssues(spec);

    console.log('\nStep 3: Deduplicating inline schemas (subset matching)...');
    spec = deduplicateInlineSchemas(spec);

    console.log('\nStep 4: Merging inline allOf extensions into components...');
    spec = mergeInlineExtensions(spec);

    console.log('\nStep 5: Removing duplicate schemas...');
    const schemas = getComponentSchemas(spec);
    const duplicates = findDuplicateSchemas(Object.keys(schemas));
    if (duplicates.size > 0) {
      console.log(`  Removing duplicates: ${[...duplicates].join(', ')}`);
      const specSchemas = spec.components?.schemas;
      if (specSchemas) {
        for (const name of duplicates) {
          delete specSchemas[name];
        }
      }
    }

    console.log('\nStep 6: Building PascalCase name map...');
    const filteredSchemas = getComponentSchemas(spec);
    const nameMap = buildNameMap(filteredSchemas, transformSchemaName);
    const examples = ['productVariant_Base', 'productVariant_Full', 'metaCollection_Full', 'brand_Full', 'error_Base'];
    for (const ex of examples) {
      if (nameMap.has(ex)) {
        console.log(`  ${ex} -> ${nameMap.get(ex)}`);
      }
    }

    console.log('\nStep 7: Renaming schemas to PascalCase...');
    spec.components = renameSchemas(spec.components, nameMap);
    spec = updateRefs(spec, nameMap);

    console.log('Step 8: Cleaning up spec...');
    spec = cleanupSpec(spec);

    console.log('Step 9: Normalizing number/string unions...');
    spec = normalizeNumberStringUnions(spec);

    const outputPath = join(__dirname, '..', 'specs', 'bigcommerce', 'catalog.v3.yml');
    const yamlOutput = yaml.dump(spec, { lineWidth: 120, noRefs: true, sortKeys: false });
    writeFileSync(outputPath, yamlOutput, 'utf8');

    console.log(`\nCombined spec written to: ${outputPath}`);
    console.log(
      `\nSummary: ${Object.keys(spec.paths).length} paths, ${Object.keys(spec.components?.schemas ?? {}).length} schemas, ${spec.tags?.length ?? 0} tags`
    );

    console.log('\nStep 10: Validating OpenAPI spec...');
    await SwaggerParser.validate(outputPath);
    console.log('  Spec is valid!');
  } catch (error) {
    console.error('Error:', (error as Error).message || error);
    process.exit(1);
  }
}

main();
