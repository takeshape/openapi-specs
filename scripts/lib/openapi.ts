/**
 * Generic OpenAPI utilities for working with OpenAPI 3.x specifications.
 */

import isEqual from 'lodash/isEqual.js';
import type { OpenAPIV3 } from 'openapi-types';

// ============================================================================
// Types
// ============================================================================

export type OpenAPISpec = OpenAPIV3.Document;
export type SchemaObject = OpenAPIV3.SchemaObject;
export type ReferenceObject = OpenAPIV3.ReferenceObject;
export type SchemaOrRef = SchemaObject | ReferenceObject;
export type ComponentsObject = OpenAPIV3.ComponentsObject;
export type TagObject = OpenAPIV3.TagObject;

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
    if (typeof obj !== 'object') return;

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
 * Converts a schema name to PascalCase.
 */
export function toPascalCase(name: string): string {
  // Remove _Full suffix - the "Full" version is the main type
  const cleanName = name.replace(/_Full$/, '');

  // Split on underscores and camelCase boundaries
  const parts = cleanName
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .split('_')
    .filter(Boolean);

  // Capitalize each part and join
  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join('');
}

/**
 * Build a map of old names to new PascalCase names.
 */
export function buildNameMap(schemas: Record<string, SchemaObject>): Map<string, string> {
  const nameMap = new Map<string, string>();
  const newNameCounts = new Map<string, number>();

  // First pass: generate new names and count collisions
  for (const oldName of Object.keys(schemas)) {
    const newName = toPascalCase(oldName);
    newNameCounts.set(newName, (newNameCounts.get(newName) || 0) + 1);
  }

  // Second pass: resolve collisions by keeping suffix
  for (const oldName of Object.keys(schemas)) {
    let newName = toPascalCase(oldName);

    if ((newNameCounts.get(newName) ?? 0) > 1) {
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

/**
 * Update all $refs to use new names from a name map.
 */
export function updateRefs(obj: unknown, nameMap: Map<string, string>): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map((item) => updateRefs(item, nameMap));
  if (typeof obj !== 'object') return obj;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === '$ref' && typeof value === 'string') {
      const oldName = getSchemaName(value);
      if (oldName) {
        const newName = nameMap.get(oldName) || oldName;
        result[key] = makeSchemaRef(newName).$ref;
        continue;
      }
    }
    result[key] = updateRefs(value, nameMap);
  }
  return result;
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
 * Check if a oneOf represents a number/string union (common for amounts).
 * Returns true if oneOf contains exactly number and string types.
 */
export function isNumberStringUnion(oneOf: unknown[]): boolean {
  if (!Array.isArray(oneOf) || oneOf.length !== 2) return false;
  const types = oneOf
    .map((item) => (typeof item === 'object' && item !== null && 'type' in item ? item.type : null))
    .sort();
  return types[0] === 'number' && types[1] === 'string';
}

/**
 * Clean up the spec - remove empty allOf, unwrap single-item allOf, normalize oneOf, etc.
 */
export function cleanupSpec(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(cleanupSpec);
  if (typeof obj !== 'object') return obj;

  const objRecord = obj as Record<string, unknown>;

  // First, collect sibling properties (non-allOf/oneOf keys) that should be preserved
  const siblingProps: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(objRecord)) {
    if (key !== 'allOf' && key !== 'oneOf' && value !== undefined) {
      siblingProps[key] = cleanupSpec(value);
    }
  }

  // Handle oneOf with number/string union - normalize to number
  if (objRecord.oneOf && isNumberStringUnion(objRecord.oneOf as unknown[])) {
    const oneOf = objRecord.oneOf as Array<Record<string, unknown>>;
    const numberSchema = oneOf.find((item) => item.type === 'number') || {};
    return { type: 'number', ...numberSchema, ...siblingProps };
  }

  // Handle other oneOf - just recurse
  if (objRecord.oneOf && Array.isArray(objRecord.oneOf)) {
    return { oneOf: objRecord.oneOf.map(cleanupSpec), ...siblingProps };
  }

  // Handle allOf specially
  if (objRecord.allOf && Array.isArray(objRecord.allOf)) {
    // Filter out empty objects
    const filtered = objRecord.allOf.filter((item) => {
      const itemRecord = item as Record<string, unknown>;
      if (
        itemRecord.type === 'object' &&
        itemRecord.properties &&
        typeof itemRecord.properties === 'object' &&
        Object.keys(itemRecord.properties).length === 0
      ) {
        return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      // allOf is empty, just return sibling properties
      return Object.keys(siblingProps).length > 0 ? siblingProps : {};
    }

    if (filtered.length === 1) {
      // Unwrap single-item allOf, but preserve sibling properties
      const first = filtered[0] as Record<string, unknown>;
      if (first.$ref) {
        return { $ref: first.$ref, ...siblingProps };
      }
      return { ...(cleanupSpec(first) as Record<string, unknown>), ...siblingProps };
    }

    // Multiple items in allOf - keep it
    return { allOf: filtered.map(cleanupSpec), ...siblingProps };
  }

  // No allOf, just return cleaned sibling properties
  return siblingProps;
}

// ============================================================================
// Component merging utilities
// ============================================================================

/**
 * Merge components from source into target, warning on conflicts.
 */
export function mergeComponents(target: ComponentsObject, source: ComponentsObject, specName: string): void {
  const componentTypes = ['schemas', 'responses', 'parameters', 'requestBodies', 'headers', 'securitySchemes'] as const;

  for (const type of componentTypes) {
    const sourceComponents = source[type];
    if (sourceComponents) {
      if (!target[type]) {
        (target as Record<string, unknown>)[type] = {};
      }
      const targetComponents = target[type] as Record<string, unknown>;
      for (const [name, schema] of Object.entries(sourceComponents)) {
        if (targetComponents[name]) {
          if (!isEqual(targetComponents[name], schema)) {
            console.warn(
              `Warning: Component ${type}.${name} already exists with different definition (from ${specName})`
            );
          }
        } else {
          targetComponents[name] = schema;
        }
      }
    }
  }
}

/**
 * Merge tags from source into target, avoiding duplicates.
 */
export function mergeTags(target: TagObject[], source: TagObject[] | undefined): void {
  if (!source) return;
  for (const tag of source) {
    const existingTag = target.find((t) => t.name === tag.name);
    if (!existingTag) {
      target.push(tag);
    }
  }
}
