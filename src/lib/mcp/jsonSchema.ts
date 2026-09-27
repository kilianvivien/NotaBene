/**
 * The MCP tools' argument schemas as JSON Schema, for native function calling.
 *
 * Generated, not written: the agent's tool definitions must describe exactly
 * what `toolHandlers.ts` accepts, and a second hand-written copy is how the
 * two surfaces drift (plan §3.2, item 2). This covers the Zod subset those
 * schemas use — objects, strings, numbers, booleans, enums, arrays, literals,
 * unions, optional, nullable, defaults and refinements. A refinement is a
 * cross-field rule JSON Schema cannot say; the handler still enforces it and
 * its message comes back to the model as an ordinary tool error.
 */
import { z } from 'zod';

export type JsonSchema = Record<string, unknown>;

interface Converted {
  schema: JsonSchema;
  optional: boolean;
}

function convert(type: z.ZodTypeAny): Converted {
  const def = type._def as { typeName: z.ZodFirstPartyTypeKind; description?: string };
  const described = (schema: JsonSchema): JsonSchema =>
    def.description ? { ...schema, description: def.description } : schema;

  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodOptional:
      return {
        schema: convert((type as z.ZodOptional<z.ZodTypeAny>).unwrap()).schema,
        optional: true,
      };
    case z.ZodFirstPartyTypeKind.ZodDefault: {
      const inner = convert((type as z.ZodDefault<z.ZodTypeAny>).removeDefault()).schema;
      return {
        schema: {
          ...inner,
          default: (type as z.ZodDefault<z.ZodTypeAny>)._def.defaultValue(),
        },
        optional: true,
      };
    }
    case z.ZodFirstPartyTypeKind.ZodNullable: {
      const inner = convert((type as z.ZodNullable<z.ZodTypeAny>).unwrap());
      return {
        schema: { anyOf: [inner.schema, { type: 'null' }] },
        optional: inner.optional,
      };
    }
    case z.ZodFirstPartyTypeKind.ZodEffects:
      return convert((type as z.ZodEffects<z.ZodTypeAny>).innerType());
    case z.ZodFirstPartyTypeKind.ZodString: {
      const checks = (type as z.ZodString)._def.checks;
      const schema: JsonSchema = { type: 'string' };
      for (const check of checks) {
        if (check.kind === 'min') schema.minLength = check.value;
        if (check.kind === 'max') schema.maxLength = check.value;
        if (check.kind === 'datetime') schema.format = 'date-time';
      }
      return { schema: described(schema), optional: false };
    }
    case z.ZodFirstPartyTypeKind.ZodNumber: {
      const checks = (type as z.ZodNumber)._def.checks;
      const schema: JsonSchema = {
        type: checks.some((check) => check.kind === 'int') ? 'integer' : 'number',
      };
      for (const check of checks) {
        if (check.kind === 'min') schema.minimum = check.value;
        if (check.kind === 'max') schema.maximum = check.value;
      }
      return { schema: described(schema), optional: false };
    }
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return { schema: described({ type: 'boolean' }), optional: false };
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return {
        schema: described({
          type: 'string',
          enum: [...(type as z.ZodEnum<[string]>).options],
        }),
        optional: false,
      };
    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return {
        schema: described({ const: (type as z.ZodLiteral<unknown>).value }),
        optional: false,
      };
    case z.ZodFirstPartyTypeKind.ZodArray: {
      const array = type as z.ZodArray<z.ZodTypeAny>;
      const schema: JsonSchema = { type: 'array', items: convert(array.element).schema };
      if (array._def.minLength) schema.minItems = array._def.minLength.value;
      if (array._def.maxLength) schema.maxItems = array._def.maxLength.value;
      return { schema: described(schema), optional: false };
    }
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = (type as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const converted = convert(value);
        properties[key] = converted.schema;
        if (!converted.optional) required.push(key);
      }
      return {
        schema: described({
          type: 'object',
          properties,
          ...(required.length ? { required } : {}),
        }),
        optional: false,
      };
    }
    case z.ZodFirstPartyTypeKind.ZodUnion:
    case z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion: {
      const options = (type as z.ZodUnion<[z.ZodTypeAny]>).options as z.ZodTypeAny[];
      return {
        schema: described({ anyOf: options.map((option) => convert(option).schema) }),
        optional: false,
      };
    }
    case z.ZodFirstPartyTypeKind.ZodRecord:
      return { schema: described({ type: 'object' }), optional: false };
    // A note document is recursive (`z.lazy`). The tool accepts it; the model
    // is steered to Markdown, so describing the tree here would only cost
    // tokens on every turn.
    case z.ZodFirstPartyTypeKind.ZodLazy:
    case z.ZodFirstPartyTypeKind.ZodUnknown:
    case z.ZodFirstPartyTypeKind.ZodAny:
      return { schema: described({ type: 'object' }), optional: false };
    default:
      throw new Error(`jsonSchema: unsupported zod type ${String(def.typeName)}`);
  }
}

/** A tool's argument schema as the JSON Schema a provider's tool definition
 * takes. Always an object at the root, as every protocol requires. */
export function toolParameters(type: z.ZodTypeAny | null): JsonSchema {
  if (!type) return { type: 'object', properties: {} };
  const { schema } = convert(type);
  return schema.type === 'object' ? schema : { type: 'object', properties: {} };
}
