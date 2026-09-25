// VENDORED VERBATIM from openclaw/openclaw @ v2026.9.6 — packages/gateway-protocol/src/protocol-validator.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (Only change vs upstream: @openclaw/<pkg>/<module> workspace specifiers collapsed to ./<module>.js.)
import { normalizeTypeBoxValidationErrors } from "./json-schema.js";
import type { Static, TSchema } from "typebox";
import { Compile, type Validator as TypeBoxValidator } from "typebox/compile";
import type { ValidationError } from "./validation-errors.js";

/** Runtime validator shape shared by gateway clients and server handlers. */
export type ProtocolValidator<T = unknown> = ((data: unknown) => data is T) & {
  errors: ValidationError[] | null; // Ajv-style last validation errors.
  /** Original schema used by the validator, exposed for diagnostics/tests. */
  schema: unknown;
};

// Defer TypeBox compilation because the protocol entrypoint is common on startup paths.
export function lazyCompile<const Schema extends TSchema>(
  schema: Schema,
  precheck?: (data: unknown) => ValidationError | undefined,
): ProtocolValidator<Static<Schema>>;
// Keep compact hand-authored public types where schema-derived declarations are intentionally avoided.
export function lazyCompile<T>(
  schema: TSchema,
  precheck?: (data: unknown) => ValidationError | undefined,
): ProtocolValidator<T>;
/* @__NO_SIDE_EFFECTS__ */
export function lazyCompile<T = unknown>(
  schema: TSchema,
  precheck?: (data: unknown) => ValidationError | undefined,
): ProtocolValidator<T> {
  let compiled: TypeBoxValidator | undefined;
  let errors: ValidationError[] | null = null;

  const getCompiled = () => {
    compiled ??= Compile(schema as never);
    return compiled;
  };

  const validate = ((data: unknown): data is T => {
    const precheckError = precheck?.(data);
    if (precheckError) {
      errors = [precheckError];
      return false;
    }
    const current = getCompiled();
    const valid = current.Check(data);
    errors = valid ? null : normalizeTypeBoxValidationErrors([...current.Errors(data)]);
    return valid;
  }) as ProtocolValidator<T>;

  Object.defineProperties(validate, {
    errors: {
      configurable: true,
      enumerable: true,
      get: () => errors,
      set: (nextErrors: ValidationError[] | null | undefined) => {
        // Preserve Ajv-compatible mutability for callers/tests that clear errors.
        errors = nextErrors ?? null;
      },
    },
    schema: {
      configurable: true,
      enumerable: true,
      get: () => schema,
    },
  });

  return validate;
}
