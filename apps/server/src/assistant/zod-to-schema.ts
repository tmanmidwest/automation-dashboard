import { z } from 'zod';

/**
 * Minimal Zod → JSON Schema converter for the shapes the tool catalog uses
 * (string, number, boolean, array, record, optional, with `.describe()`), emitting the
 * `{ type: 'object', properties, required }` a tool's `function.parameters` expects.
 * Deliberately small — we control the input shapes, so a full converter isn't warranted.
 */
export function toParameterSchema(shape: z.ZodRawShape): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, schema] of Object.entries(shape)) {
    const { node, optional } = convert(schema as z.ZodTypeAny);
    properties[key] = node;
    if (!optional) required.push(key);
  }
  return { type: 'object', properties, required };
}

function convert(schema: z.ZodTypeAny): { node: Record<string, unknown>; optional: boolean } {
  // Unwrap Optional / Default, remembering the description from whichever layer has it.
  let current = schema;
  let optional = false;
  let description = current.description;
  while (current instanceof z.ZodOptional || current instanceof z.ZodDefault) {
    if (current instanceof z.ZodOptional) optional = true;
    current = (current._def as { innerType: z.ZodTypeAny }).innerType;
    description = description ?? current.description;
  }

  const node = describe(mapType(current), description);
  return { node, optional };
}

function mapType(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodNumber) return { type: 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodArray) {
    const el = convert((schema._def as { type: z.ZodTypeAny }).type);
    return { type: 'array', items: el.node };
  }
  if (schema instanceof z.ZodRecord) {
    return { type: 'object', additionalProperties: true };
  }
  if (schema instanceof z.ZodEnum) {
    return { type: 'string', enum: (schema._def as { values: string[] }).values };
  }
  // Fallback: accept anything.
  return {};
}

function describe(node: Record<string, unknown>, description?: string): Record<string, unknown> {
  return description ? { ...node, description } : node;
}
