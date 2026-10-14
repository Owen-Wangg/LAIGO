import { Construct } from "constructs";

/**
 * Canonical environment names used across the CDK app.
 */
export type CanonicalEnvironment = "dev" | "test" | "prod";

/**
 * The canonical environment names accepted for deployment.
 */
export const ACCEPTED_ENVIRONMENTS: readonly CanonicalEnvironment[] = [
  "dev",
  "test",
  "prod",
] as const;

/**
 * Maps a raw environment string to its canonical form. Keys are already
 * lowercased/trimmed before lookup. Includes back-compat aliases:
 * "production" -> "prod" and "development" -> "dev".
 */
const ENVIRONMENT_ALIASES: Record<string, CanonicalEnvironment> = {
  dev: "dev",
  development: "dev",
  test: "test",
  prod: "prod",
  production: "prod",
};

/**
 * Resolves a raw environment value to its canonical form.
 *
 * Trims and lowercases the input, maps the accepted set (dev/test/prod) plus
 * the "production"->prod and "development"->dev aliases, and defaults to "dev"
 * when the value is unset or empty. Throws a clear Error for any other value.
 *
 * @param raw - The raw environment value (e.g. from CDK context)
 * @returns The canonical environment name
 */
export function resolveEnvironment(
  raw: string | undefined,
): CanonicalEnvironment {
  if (raw === undefined || raw.trim().length === 0) {
    return "dev";
  }

  const normalized = raw.trim().toLowerCase();
  const canonical = ENVIRONMENT_ALIASES[normalized];
  if (!canonical) {
    throw new Error(
      `Invalid Environment context value "${raw}". Accepted values are: ${ACCEPTED_ENVIRONMENTS.join(
        ", ",
      )} (aliases: production=prod, development=dev).`,
    );
  }

  return canonical;
}

/**
 * Reads the `Environment` context variable and returns whether the deployment
 * targets production. Used across stacks to gate environment-sensitive controls.
 *
 * @param scope - Any CDK construct (typically `this` inside a Stack constructor)
 * @returns true if the resolved environment is "prod"
 */
export function isProdEnvironment(scope: Construct): boolean {
  const env = scope.node.tryGetContext("Environment") as string | undefined;
  return resolveEnvironment(env) === "prod";
}

/**
 * Returns the canonical environment name from CDK context.
 * Defaults to "dev" when the context value is unset or empty.
 *
 * @param scope - Any CDK construct (typically `this` inside a Stack constructor)
 * @returns The canonical environment name ("dev" | "test" | "prod")
 */
export function getEnvironmentName(scope: Construct): CanonicalEnvironment {
  const env = scope.node.tryGetContext("Environment") as string | undefined;
  return resolveEnvironment(env);
}
