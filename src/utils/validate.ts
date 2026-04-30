/**
 * Validates that an entity name is not empty/whitespace and does not contain path traversal characters.
 * Throws an Error on failure — callers that need CLI exit-1 behavior should catch and exit.
 */
export function validateEntityName(entityName: string, entityType: string): void {
  if (!entityName || entityName.trim() === '') {
    throw new Error(`${entityType} name must not be empty`);
  }
  if (entityName.includes('/') || entityName.includes('\\') || entityName.includes('..')) {
    throw new Error(`${entityType} name '${entityName}' contains invalid path characters`);
  }
}
