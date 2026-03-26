/**
 * Generic OpenAPI utilities for working with OpenAPI 3.x specifications.
 */

import isEqual from 'lodash/isEqual.js';
import type { OpenAPIV3 } from 'openapi-types';

// ============================================================================
// Clone utilities
// TODO: Switch to `import { deepCloneWithPath } from '@takeshape/util'` once
// @takeshape/prism npm publishing issue is resolved
// ============================================================================

type CloneWithPathHelper = (
  value: unknown,
  key: string | number | undefined,
  parent: Record<string, unknown> | unknown[] | undefined,
  path: string[]
) => unknown;

export function deepCloneWithPath(initialValue: unknown, customizer: CloneWithPathHelper): unknown {
  const clone: CloneWithPathHelper = (value, key, parent, path) => {
    const customizedValue = customizer(value, key, parent, path);
    const cloneValue = customizedValue ?? value;

    if (Array.isArray(cloneValue)) {
      return cloneValue.map((item, i) => clone(item, i, cloneValue, [...path, String(i)]));
    }

    if (isPlainObject(cloneValue)) {
      const result: Record<string, unknown> = {};
      for (const k of Object.keys(cloneValue)) {
        const newValue = clone(cloneValue[k], k, cloneValue, [...path, k]);
        if (newValue !== undefined) {
          result[k] = newValue;
        }
      }
      return result;
    }

    return cloneValue;
  };

  return clone(initialValue, undefined, undefined, []);
}

// ============================================================================
// Types
// ============================================================================

export type OpenAPISpec = OpenAPIV3.Document;
export type SchemaObject = OpenAPIV3.SchemaObject;
export type ReferenceObject = OpenAPIV3.ReferenceObject;
export type SchemaOrRef = SchemaObject | ReferenceObject;
export type ComponentsObject = OpenAPIV3.ComponentsObject;
export type TagObject = OpenAPIV3.TagObject;

/** Component schemas record - schemas are definitions, never refs at top level */
export type ComponentSchemas = Record<string, SchemaObject>;

/**
 * Get component schemas from a spec.
 * In valid OpenAPI, component schemas are always SchemaObjects (definitions),
 * never ReferenceObjects (which only appear within schemas).
 */
export function getComponentSchemas(spec: OpenAPISpec): ComponentSchemas {
  const schemas = spec.components?.schemas;
  if (!schemas) return {};

  // Filter out any refs (shouldn't exist at top level, but be safe)
  const result: ComponentSchemas = {};
  for (const [name, schema] of Object.entries(schemas)) {
    if (!isSchemaRef(schema)) {
      result[name] = schema;
    }
  }
  return result;
}

/** A plain object (not null, not array) */
export type PlainObject = Record<string, unknown>;

// ============================================================================
// Type guards
// ============================================================================

/**
 * Check if a value is a plain object (not null, not array).
 */
export function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An object schema with a properties field */
export interface ObjectSchemaWithProperties extends PlainObject {
  type?: 'object';
  properties: PlainObject;
}

/**
 * Check if a value is an object schema with properties.
 * Matches schemas with `properties` field, optionally with `type: 'object'`.
 */
export function isObjectSchema(value: unknown): value is ObjectSchemaWithProperties {
  return (
    isPlainObject(value) && isPlainObject(value.properties) && (value.type === undefined || value.type === 'object')
  );
}

// ============================================================================
// Schema $ref utilities
// ============================================================================

export const SCHEMA_REF_PREFIX = '#/components/schemas/';

/**
 * Check if a value is a $ref to a component schema.
 */
export function isSchemaRef(obj: unknown): obj is ReferenceObject {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    '$ref' in obj &&
    typeof obj.$ref === 'string' &&
    obj.$ref.startsWith(SCHEMA_REF_PREFIX)
  );
}

/**
 * Extract the schema name from a $ref object or string.
 * Returns null if not a valid schema ref.
 */
export function getSchemaName(obj: unknown): string | null {
  const ref = typeof obj === 'string' ? obj : isSchemaRef(obj) ? obj.$ref : null;
  if (!ref?.startsWith(SCHEMA_REF_PREFIX)) return null;
  return ref.replace(SCHEMA_REF_PREFIX, '');
}

/**
 * Create a $ref object pointing to a component schema.
 */
export function makeSchemaRef(name: string): ReferenceObject {
  return { $ref: `${SCHEMA_REF_PREFIX}${name}` };
}

// ============================================================================
// Spec traversal utilities
// ============================================================================

/**
 * Callback for transforming values during spec traversal.
 *
 * @param value - The current object being visited
 * @param path - Path to this object (e.g., ['components', 'schemas', 'User'])
 * @returns A replacement value, or undefined to use default cloning
 */
export type TransformCallback = (value: Record<string, unknown>, path: string[]) => unknown | undefined;

/**
 * Traverse and transform an OpenAPI spec, calling the transform function for each object.
 *
 * Component schema definitions (under `components.schemas.*`) are cloned but not transformed.
 * The transform is only called for usages of schemas (in paths, responses, etc.).
 */
export function traverseSpec(spec: OpenAPISpec, transform: TransformCallback): OpenAPISpec {
  return deepCloneWithPath(spec, (value, _key, _parent, path) => {
    if (!isPlainObject(value)) return undefined;

    // Skip transform for component schema definitions (but still clone them)
    if (path[0] === 'components' && path[1] === 'schemas') {
      return undefined;
    }

    return transform(value, path);
  }) as OpenAPISpec;
}

// ============================================================================
// Schema reference counting
// ============================================================================

/**
 * Count how many times each component schema is referenced in the spec.
 */
export function countSchemaRefs(spec: OpenAPISpec): Map<string, number> {
  const refCounts = new Map<string, number>();

  function countRefs(obj: unknown): void {
    if (obj === null || obj === undefined) return;
    if (Array.isArray(obj)) {
      obj.forEach(countRefs);
      return;
    }
    if (!isPlainObject(obj)) return;

    if (isSchemaRef(obj)) {
      const refName = getSchemaName(obj);
      if (refName) {
        refCounts.set(refName, (refCounts.get(refName) || 0) + 1);
      }
    }

    for (const value of Object.values(obj)) {
      countRefs(value);
    }
  }

  countRefs(spec);
  return refCounts;
}

// ============================================================================
// Schema naming utilities
// ============================================================================

/**
 * Build a map of old schema names to new names.
 *
 * @param schemas - The component schemas to build names for
 * @param transformName - Function to transform each name (e.g., to PascalCase)
 */
export function buildNameMap(schemas: ComponentSchemas, transformName: (name: string) => string): Map<string, string> {
  const nameMap = new Map<string, string>();

  for (const oldName of Object.keys(schemas)) {
    nameMap.set(oldName, transformName(oldName));
  }

  return nameMap;
}

/**
 * Update all $refs to use new names from a name map.
 */
export function updateRefs<T>(obj: T, nameMap: Map<string, string>): T {
  return deepCloneWithPath(obj, (value, key) => {
    if (key === '$ref' && typeof value === 'string') {
      const oldName = getSchemaName(value);
      if (oldName) {
        const newName = nameMap.get(oldName) || oldName;
        return makeSchemaRef(newName).$ref;
      }
    }
    return undefined;
  }) as T;
}

/**
 * Rename component schemas using a name map.
 */
export function renameSchemas(
  components: ComponentsObject | undefined,
  nameMap: Map<string, string>
): ComponentsObject | undefined {
  if (!components?.schemas) return components;

  const newSchemas: Record<string, SchemaObject> = {};
  for (const [oldName, schema] of Object.entries(components.schemas)) {
    const newName = nameMap.get(oldName) || oldName;

    // Update the title if it matches the old name
    const updatedSchema = { ...schema } as SchemaObject;
    if (updatedSchema.title === oldName) {
      updatedSchema.title = newName;
    }

    newSchemas[newName] = updatedSchema;
  }

  return { ...components, schemas: newSchemas };
}

// ============================================================================
// Schema cleanup utilities
// ============================================================================

/**
 * Check if an allOf item is an empty object schema (type: object with no properties).
 */
function isEmptyObjectSchema(item: unknown): boolean {
  if (!isPlainObject(item)) return false;
  if (item.type !== 'object') return false;
  if (!isPlainObject(item.properties)) return false;
  return Object.keys(item.properties).length === 0;
}

/**
 * Clean up the spec - remove empty allOf, unwrap single-item allOf, etc.
 */
export function cleanupSpec<T>(obj: T): T {
  return deepCloneWithPath(obj, (value) => {
    if (!isPlainObject(value)) return undefined;

    const allOf = value.allOf;
    if (!Array.isArray(allOf)) return undefined;

    const { allOf: _, ...siblings } = value;
    const filtered = allOf.filter((item) => !isEmptyObjectSchema(item));

    if (filtered.length === 0) {
      return Object.keys(siblings).length > 0 ? siblings : {};
    }

    if (filtered.length === 1) {
      const first = filtered[0];
      if (isPlainObject(first) && first.$ref) {
        return { $ref: first.$ref, ...siblings };
      }
      if (isPlainObject(first)) {
        return { ...first, ...siblings };
      }
      return { ...siblings };
    }

    return { allOf: filtered, ...siblings };
  }) as T;
}

// ============================================================================
// Component merging utilities
// ============================================================================

// ============================================================================
// Flatten single-use allOf references
// ============================================================================

/**
 * Flatten component schemas that use allOf with a $ref to a component that's only used once.
 * This merges the referenced schema's properties directly into the parent schema and removes
 * the now-unused schema definitions.
 *
 * Returns a new spec - does not mutate the input.
 */
export function flattenSingleUseAllOf(spec: OpenAPISpec): OpenAPISpec {
  const schemas = getComponentSchemas(spec);
  if (Object.keys(schemas).length === 0) return spec;

  const refCounts = countSchemaRefs(spec);
  const schemasToRemove = new Set<string>();
  const newSchemas: Record<string, SchemaObject> = {};

  for (const [name, schema] of Object.entries(schemas)) {
    if (!isPlainObject(schema) || !Array.isArray(schema.allOf)) {
      newSchemas[name] = schema;
      continue;
    }

    const refsToFlatten = findSingleUseRefs(schema.allOf, schemas, refCounts);
    if (refsToFlatten.length === 0) {
      newSchemas[name] = schema;
      continue;
    }

    const { mergedProperties, newAllOf, flattenedRefs } = mergeAllOfItems(schema.allOf, refsToFlatten, schemas);

    for (const refName of flattenedRefs) {
      schemasToRemove.add(refName);
    }

    newSchemas[name] = buildFlattenedSchema(schema, newAllOf, mergedProperties);
  }

  // Remove flattened schemas
  for (const name of schemasToRemove) {
    delete newSchemas[name];
  }

  return {
    ...spec,
    components: {
      ...spec.components,
      schemas: newSchemas
    }
  };
}

function findSingleUseRefs(allOf: unknown[], schemas: ComponentSchemas, refCounts: Map<string, number>): string[] {
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
  mergedProperties: PlainObject;
  newAllOf: unknown[];
  flattenedRefs: string[];
}

function mergeAllOfItems(allOf: unknown[], refsToFlatten: string[], schemas: ComponentSchemas): MergeResult {
  const mergedProperties: PlainObject = {};
  const newAllOf: unknown[] = [];
  const flattenedRefs: string[] = [];

  for (const item of allOf) {
    if (isSchemaRef(item)) {
      const refName = getSchemaName(item);
      if (refName && refsToFlatten.includes(refName)) {
        const refSchema = schemas[refName];
        if (isObjectSchema(refSchema)) {
          Object.assign(mergedProperties, refSchema.properties);
        }
        flattenedRefs.push(refName);
        continue;
      }
    }

    if (isObjectSchema(item)) {
      Object.assign(mergedProperties, item.properties);
    } else {
      newAllOf.push(item);
    }
  }

  return { mergedProperties, newAllOf, flattenedRefs };
}

function buildFlattenedSchema(original: PlainObject, newAllOf: unknown[], mergedProperties: PlainObject): SchemaObject {
  const { allOf: _, ...rest } = original;

  if (newAllOf.length === 0) {
    return { ...rest, type: 'object', properties: mergedProperties } as SchemaObject;
  }
  return { ...rest, allOf: [...newAllOf, { type: 'object', properties: mergedProperties }] } as SchemaObject;
}

// ============================================================================
// Component merging utilities
// ============================================================================

/**
 * Merge components from source into target, warning on conflicts.
 * Returns a new ComponentsObject with merged components.
 */
export function mergeComponents(
  target: ComponentsObject,
  source: ComponentsObject,
  specName: string
): ComponentsObject {
  const componentTypes = ['schemas', 'responses', 'parameters', 'requestBodies', 'headers', 'securitySchemes'] as const;
  const result: ComponentsObject = { ...target };

  for (const type of componentTypes) {
    const sourceComponents = source[type];
    if (sourceComponents) {
      const targetComponents = { ...(result[type] || {}) } as Record<string, unknown>;
      for (const [name, value] of Object.entries(sourceComponents)) {
        if (targetComponents[name]) {
          if (!isEqual(targetComponents[name], value)) {
            console.warn(
              `Warning: Component ${type}.${name} already exists with different definition (from ${specName})`
            );
          }
        } else {
          targetComponents[name] = value;
        }
      }
      (result as Record<string, unknown>)[type] = targetComponents;
    }
  }

  return result;
}

/**
 * Merge tags from source into target, avoiding duplicates.
 * Returns a new array with merged tags.
 */
export function mergeTags(target: TagObject[], source: TagObject[] | undefined): TagObject[] {
  if (!source) return target;
  const result = [...target];
  for (const tag of source) {
    const existingTag = result.find((t) => t.name === tag.name);
    if (!existingTag) {
      result.push(tag);
    }
  }
  return result;
}
