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

/**
 * Checks if a schema is an "open" object schema that shouldn't be deduplicated.
 * Open object schemas are used as placeholders and matching them would be incorrect.
 */
function isOpenObjectSchema(obj) {
  if (typeof obj !== 'object' || obj === null) return false;
  if (obj.type !== 'object') return false;

  // Schema with additionalProperties: true is open
  if (obj.additionalProperties === true) return true;

  // Schema with no properties or empty properties is open
  if (!obj.properties || Object.keys(obj.properties).length === 0) return true;

  return false;
}

/**
 * Normalizes a property schema for comparison.
 * - Treats x-nullable and nullable as equivalent
 * - Ignores descriptions and other metadata
 * - Focuses on structural properties
 */
function normalizeProperty(prop) {
  if (!prop || typeof prop !== 'object') return prop;

  const normalized = {};

  // Core structural properties
  if (prop.type) normalized.type = prop.type;
  if (prop.$ref) normalized.$ref = prop.$ref;
  if (prop.format) normalized.format = prop.format;
  if (prop.enum) normalized.enum = [...prop.enum].sort();

  // Nullable (normalize x-nullable to nullable)
  if (prop.nullable || prop['x-nullable']) {
    normalized.nullable = true;
  }

  // Nested structures
  if (prop.items) {
    normalized.items = normalizeProperty(prop.items);
  }
  if (prop.properties) {
    normalized.properties = {};
    for (const [key, val] of Object.entries(prop.properties)) {
      normalized.properties[key] = normalizeProperty(val);
    }
  }
  if (prop.allOf) {
    normalized.allOf = prop.allOf.map(normalizeProperty);
  }
  if (prop.oneOf) {
    normalized.oneOf = prop.oneOf.map(normalizeProperty);
  }
  if (prop.anyOf) {
    normalized.anyOf = prop.anyOf.map(normalizeProperty);
  }

  // Constraints (optional but useful for matching)
  if (prop.minimum !== undefined) normalized.minimum = prop.minimum;
  if (prop.maximum !== undefined) normalized.maximum = prop.maximum;
  if (prop.minLength !== undefined) normalized.minLength = prop.minLength;
  if (prop.maxLength !== undefined) normalized.maxLength = prop.maxLength;
  if (prop.minItems !== undefined) normalized.minItems = prop.minItems;
  if (prop.maxItems !== undefined) normalized.maxItems = prop.maxItems;

  return normalized;
}

/**
 * Creates a stable JSON string for fingerprinting.
 */
function stableStringify(obj) {
  if (obj === null || obj === undefined) return String(obj);
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',') + '}';
}

/**
 * Creates a detailed fingerprint for a property schema.
 */
function getPropertyFingerprint(prop) {
  if (!prop) return 'null';
  const normalized = normalizeProperty(prop);
  return stableStringify(normalized);
}

/**
 * Creates a fingerprint for an object schema based on normalized properties.
 * Used to match inline schemas with component schemas.
 */
function getSchemaFingerprint(schema) {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.$ref) return `ref:${schema.$ref}`;
  if (schema.type !== 'object' || !schema.properties) return null;

  // Normalize and fingerprint
  const normalized = normalizeProperty(schema);
  return stableStringify(normalized);
}

/**
 * Resolves a $ref to its schema, handling nested refs.
 */
function resolveRef(ref, components) {
  if (!ref.startsWith('#/components/schemas/')) return null;
  const schemaName = ref.replace('#/components/schemas/', '');
  return components.schemas?.[schemaName];
}

/**
 * Gets the full set of properties for a schema, resolving allOf and $refs.
 */
function getResolvedProperties(schema, components, visited = new Set()) {
  if (!schema) return null;

  // Handle $ref
  if (schema.$ref) {
    if (visited.has(schema.$ref)) return null; // Prevent circular refs
    visited.add(schema.$ref);
    const resolved = resolveRef(schema.$ref, components);
    return resolved ? getResolvedProperties(resolved, components, visited) : null;
  }

  // Handle allOf by merging all properties
  if (schema.allOf) {
    const merged = {};
    for (const item of schema.allOf) {
      const props = getResolvedProperties(item, components, visited);
      if (props) Object.assign(merged, props);
    }
    return Object.keys(merged).length > 0 ? merged : null;
  }

  // Handle direct object schema
  if (schema.type === 'object' && schema.properties) {
    return { ...schema.properties };
  }

  return null;
}

/**
 * Builds a map of component schemas to their property fingerprints.
 */
function buildComponentIndex(components) {
  const index = {
    byFingerprint: new Map(), // fingerprint -> schema name
    byName: new Map(), // schema name -> { fingerprint, resolvedProps }
    allOfSchemas: new Map() // schema name -> array of base schema names (for allOf components)
  };

  if (!components?.schemas) return index;

  for (const [name, schema] of Object.entries(components.schemas)) {
    // Skip open object schemas - they shouldn't be matched against
    if (isOpenObjectSchema(schema)) {
      continue;
    }

    // Get direct fingerprint (without resolving allOf)
    const fingerprint = getSchemaFingerprint(schema);
    if (fingerprint) {
      index.byFingerprint.set(fingerprint, name);
    }

    // Get resolved properties (resolving allOf and refs)
    const resolvedProps = getResolvedProperties(schema, components);
    if (resolvedProps) {
      // Create detailed fingerprint including property types
      const propFingerprints = Object.entries(resolvedProps)
        .map(([propName, prop]) => `${propName}:${getPropertyFingerprint(prop)}`)
        .sort();
      const resolvedFingerprint = `props:[${propFingerprints.join(',')}]`;
      index.byName.set(name, { fingerprint, resolvedProps, resolvedFingerprint });

      // Track allOf structures
      if (schema.allOf) {
        const baseRefs = schema.allOf
          .filter((item) => item.$ref)
          .map((item) => item.$ref.replace('#/components/schemas/', ''));
        if (baseRefs.length > 0) {
          index.allOfSchemas.set(name, baseRefs);
        }
      }
    }
  }

  return index;
}

/**
 * Tries to find a matching component schema for an inline schema.
 */
function findMatchingComponent(inlineSchema, componentIndex, components) {
  if (!inlineSchema || inlineSchema.$ref) return null;

  const fingerprint = getSchemaFingerprint(inlineSchema);
  if (!fingerprint) return null;

  // Direct fingerprint match (includes normalized property types)
  const directMatch = componentIndex.byFingerprint.get(fingerprint);
  if (directMatch) {
    return directMatch;
  }

  // Try matching by fingerprint against component fingerprints
  for (const [name, info] of componentIndex.byName) {
    if (info.fingerprint === fingerprint || info.resolvedFingerprint === fingerprint) {
      return name;
    }
  }

  return null;
}

/**
 * Tries to match an allOf array to a single component schema.
 * For example, if allOf contains schemas that together match productVariant_Full,
 * return a reference to productVariant_Full.
 */
function tryMatchAllOfToComponent(allOfArray, componentIndex, components) {
  if (!Array.isArray(allOfArray) || allOfArray.length === 0) return null;

  // Get merged properties from all items in the allOf
  const mergedProps = {};
  for (const item of allOfArray) {
    if (item.$ref) {
      const resolved = resolveRef(item.$ref, components);
      const props = resolved ? getResolvedProperties(resolved, components) : null;
      if (props) Object.assign(mergedProps, props);
    } else if (item.type === 'object' && item.properties) {
      Object.assign(mergedProps, item.properties);
    } else {
      // Can't handle this allOf item
      return null;
    }
  }

  if (Object.keys(mergedProps).length === 0) return null;

  // Create detailed fingerprint including property types
  const propFingerprints = Object.entries(mergedProps)
    .map(([propName, prop]) => `${propName}:${getPropertyFingerprint(prop)}`)
    .sort();
  const mergedFingerprint = `props:[${propFingerprints.join(',')}]`;

  for (const [name, info] of componentIndex.byName) {
    if (info.resolvedFingerprint === mergedFingerprint) {
      return name;
    }
  }

  return null;
}

/**
 * Check if we're inside a component schema definition (to avoid self-references).
 */
function isInsideComponentSchema(path) {
  return path.length >= 3 && path[0] === 'components' && path[1] === 'schemas';
}

/**
 * Get the component schema name we're currently inside, if any.
 */
function getCurrentComponentName(path) {
  if (isInsideComponentSchema(path)) {
    return path[2];
  }
  return null;
}

/**
 * Replaces inline schemas with $refs where possible.
 */
function deduplicateSchemas(obj, componentIndex, components, path = []) {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item, i) => deduplicateSchemas(item, componentIndex, components, [...path, i]));
  }

  // Get the current component name to avoid self-references
  const currentComponent = getCurrentComponentName(path);

  if (typeof obj === 'object') {
    // Handle allOf - try to match entire allOf to a component
    if (obj.allOf && Array.isArray(obj.allOf)) {
      // Check if object has sibling properties that must be preserved
      const siblingKeys = Object.keys(obj).filter((k) => k !== 'allOf');
      const hasSiblings = siblingKeys.length > 0;

      // Only collapse allOf to $ref if there are no siblings
      // (In OpenAPI 3.0, $ref can't coexist with other properties)
      if (!hasSiblings) {
        const matchedComponent = tryMatchAllOfToComponent(obj.allOf, componentIndex, components);
        // Avoid self-references
        if (matchedComponent && matchedComponent !== currentComponent) {
          console.log(`  Replaced allOf at ${path.join('.')} with $ref to ${matchedComponent}`);
          return { $ref: `#/components/schemas/${matchedComponent}` };
        }
      }

      // Try to replace individual items in the allOf
      const newAllOf = obj.allOf.map((item, i) => {
        if (item.$ref) return item; // Already a ref
        // Skip open object schemas - they're placeholders
        if (isOpenObjectSchema(item)) return item;

        const match = findMatchingComponent(item, componentIndex, components);
        // Avoid self-references
        if (match && match !== currentComponent) {
          console.log(`  Replaced inline schema at ${[...path, 'allOf', i].join('.')} with $ref to ${match}`);
          return { $ref: `#/components/schemas/${match}` };
        }
        return deduplicateSchemas(item, componentIndex, components, [...path, 'allOf', i]);
      });

      // After replacing items, try again to match the whole allOf (only if no siblings)
      if (!hasSiblings) {
        const afterMatch = tryMatchAllOfToComponent(newAllOf, componentIndex, components);
        // Avoid self-references
        if (afterMatch && afterMatch !== currentComponent) {
          console.log(`  Collapsed allOf at ${path.join('.')} to $ref to ${afterMatch}`);
          return { $ref: `#/components/schemas/${afterMatch}` };
        }
      }

      return { ...obj, allOf: newAllOf };
    }

    // Handle inline object schemas (skip open object schemas - they're placeholders)
    if (obj.type === 'object' && obj.properties && !obj.$ref && !isOpenObjectSchema(obj)) {
      const match = findMatchingComponent(obj, componentIndex, components);
      // Avoid self-references
      if (match && match !== currentComponent) {
        console.log(`  Replaced inline object at ${path.join('.')} with $ref to ${match}`);
        return { $ref: `#/components/schemas/${match}` };
      }
    }

    // Recurse into object properties
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = deduplicateSchemas(value, componentIndex, components, [...path, key]);
    }
    return result;
  }

  return obj;
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
          // Check if the parent has other sibling keys besides 'allOf'
          const siblingKeys = Object.keys(obj).filter((k) => k !== 'allOf');
          if (siblingKeys.length > 0) {
            // Keep the allOf intact to preserve valid schema structure
            // (In OpenAPI 3.0, $ref can't coexist with other properties)
            result[key] = filtered.map(cleanupSpec);
          } else {
            // If only one item remains and no siblings, merge it into parent or keep as ref
            const remaining = filtered[0];
            if (remaining.$ref) {
              // Just use the ref directly (unwrap single-item allOf)
              result.$ref = remaining.$ref;
            } else {
              // Merge the non-ref schema into parent
              const cleaned = cleanupSpec(remaining);
              Object.assign(result, cleaned);
            }
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

    // Build component index for deduplication
    console.log('\nDeduplicating inline schemas...');
    const componentIndex = buildComponentIndex(combinedSpec.components);
    console.log(`  Found ${componentIndex.byName.size} component schemas to match against`);

    // Deduplicate inline schemas by replacing with $refs
    const deduplicatedSpec = deduplicateSchemas(
      combinedSpec,
      componentIndex,
      combinedSpec.components
    );

    // Clean up spec - remove undefined values and fix allOf patterns with empty objects
    const cleanedSpec = cleanupSpec(deduplicatedSpec);

    const outputPath = join(__dirname, '..', 'specs', 'bigcommerce', 'catalog.v3.yml');
    const yamlOutput = yaml.dump(cleanedSpec, {
      lineWidth: 120,
      noRefs: true,
      sortKeys: false
    });

    writeFileSync(outputPath, yamlOutput, 'utf8');
    console.log(`\nCombined spec written to: ${outputPath}`);

    // Print summary
    const pathCount = Object.keys(cleanedSpec.paths).length;
    const schemaCount = Object.keys(cleanedSpec.components?.schemas ?? {}).length;
    console.log(`\nSummary:`);
    console.log(`  - Paths: ${pathCount}`);
    console.log(`  - Schemas: ${schemaCount}`);
    console.log(`  - Tags: ${cleanedSpec.tags?.length ?? 0}`);
  } catch (error) {
    console.error('Error combining specs:', error);
    process.exit(1);
  }
}

main();
