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

/**
 * Resolves a $ref to its schema.
 */
function resolveRef(ref, components) {
  if (!ref || !ref.startsWith('#/components/schemas/')) return null;
  const name = ref.replace('#/components/schemas/', '');
  return components?.schemas?.[name];
}

/**
 * Deep clones an object.
 */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Flattens an allOf array into a single merged schema.
 * Resolves $refs and merges all properties together.
 */
function flattenAllOf(allOf, components) {
  const merged = {
    type: 'object',
    properties: {}
  };
  const requiredFields = [];
  let description = null;
  let title = null;

  for (const member of allOf) {
    let schema = member;

    // Resolve $ref
    if (member.$ref) {
      const resolved = resolveRef(member.$ref, components);
      if (!resolved) continue;
      schema = deepClone(resolved);
    }

    // Skip empty objects
    if (schema.type === 'object' && (!schema.properties || Object.keys(schema.properties).length === 0)) {
      continue;
    }

    // Recursively flatten nested allOf
    if (schema.allOf) {
      schema = flattenAllOf(schema.allOf, components);
    }

    // Merge properties
    if (schema.properties) {
      Object.assign(merged.properties, schema.properties);
    }

    // Collect required fields
    if (schema.required) {
      requiredFields.push(...schema.required);
    }

    // Keep first title and description
    if (!title && schema.title) title = schema.title;
    if (!description && schema.description) description = schema.description;
  }

  if (requiredFields.length > 0) {
    merged.required = [...new Set(requiredFields)];
  }
  if (title) merged.title = title;
  if (description) merged.description = description;

  return merged;
}

/**
 * Converts a path like /catalog/variants to a PascalCase name like CatalogVariants
 */
function pathToName(path) {
  return path
    .split('/')
    .filter(Boolean)
    .filter(p => !p.startsWith('{'))
    .map(p => p.charAt(0).toUpperCase() + p.slice(1).replace(/-([a-z])/g, (_, c) => c.toUpperCase()))
    .join('');
}

/**
 * Processes the spec to flatten allOf structures in response schemas.
 * Creates new component schemas for flattened structures.
 */
function flattenResponseAllOfs(spec) {
  const newComponents = {};
  let flattenCount = 0;

  function processSchema(schema, contextName) {
    if (!schema || typeof schema !== 'object') return schema;

    // Handle arrays
    if (Array.isArray(schema)) {
      return schema.map((item, i) => processSchema(item, `${contextName}${i}`));
    }

    // Handle allOf - flatten it
    if (schema.allOf && Array.isArray(schema.allOf)) {
      const flattened = flattenAllOf(schema.allOf, spec.components);

      // Process the flattened schema's nested structures
      if (flattened.properties) {
        for (const [propName, propSchema] of Object.entries(flattened.properties)) {
          flattened.properties[propName] = processSchema(propSchema, `${contextName}${propName.charAt(0).toUpperCase() + propName.slice(1)}`);
        }
      }

      // If this flattened schema has substantial properties, create a component
      const propCount = Object.keys(flattened.properties || {}).length;
      if (propCount > 2) {
        const componentName = flattened.title || contextName;
        // Clean up the name
        const cleanName = componentName.replace(/[^a-zA-Z0-9_]/g, '');

        if (!newComponents[cleanName]) {
          newComponents[cleanName] = flattened;
          flattenCount++;
        }
        return { $ref: `#/components/schemas/${cleanName}` };
      }

      return flattened;
    }

    // Process object properties recursively
    const result = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'properties' && typeof value === 'object') {
        result[key] = {};
        for (const [propName, propSchema] of Object.entries(value)) {
          result[key][propName] = processSchema(propSchema, `${contextName}${propName.charAt(0).toUpperCase() + propName.slice(1)}`);
        }
      } else if (key === 'items') {
        result[key] = processSchema(value, `${contextName}Item`);
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        result[key] = processSchema(value, contextName);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  // Process all paths - both responses and request bodies
  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    const baseName = pathToName(path);

    for (const [method, operation] of Object.entries(pathItem)) {
      if (!operation || typeof operation !== 'object') continue;

      const opName = operation.operationId || `${method}${baseName}`;

      // Process responses
      if (operation.responses) {
        for (const [statusCode, response] of Object.entries(operation.responses)) {
          if (!response?.content?.['application/json']?.schema) continue;

          const contextName = `${opName.charAt(0).toUpperCase() + opName.slice(1)}Response`;
          response.content['application/json'].schema = processSchema(
            response.content['application/json'].schema,
            contextName
          );
        }
      }

      // Process request bodies
      if (operation.requestBody?.content?.['application/json']?.schema) {
        const contextName = `${opName.charAt(0).toUpperCase() + opName.slice(1)}Input`;
        operation.requestBody.content['application/json'].schema = processSchema(
          operation.requestBody.content['application/json'].schema,
          contextName
        );
      }
    }
  }

  // Process component schemas
  if (spec.components?.schemas) {
    for (const [name, schema] of Object.entries(spec.components.schemas)) {
      spec.components.schemas[name] = processSchema(schema, name);
    }
  }

  // Add new components to spec
  if (!spec.components) spec.components = {};
  if (!spec.components.schemas) spec.components.schemas = {};
  Object.assign(spec.components.schemas, newComponents);

  console.log(`  Flattened ${flattenCount} allOf structures into components`);
  return spec;
}

/**
 * Removes empty object schemas from allOf arrays.
 */
function cleanupSpec(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(cleanupSpec);
  if (typeof obj !== 'object') return obj;

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;

    if (key === 'allOf' && Array.isArray(value)) {
      const filtered = value.filter(item => {
        if (item.type === 'object' && item.properties && Object.keys(item.properties).length === 0) {
          return false;
        }
        return true;
      });

      if (filtered.length === 0) continue;
      if (filtered.length === 1) {
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

    console.log('\nFlattening allOf structures in responses...');
    spec = flattenResponseAllOfs(spec);

    console.log('\nCleaning up spec...');
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
