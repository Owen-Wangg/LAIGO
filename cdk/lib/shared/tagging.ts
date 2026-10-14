import * as cdk from "aws-cdk-lib";
import { IConstruct } from "constructs";
import { IAspect, Annotations, CfnResource, Tags, TagManager } from "aws-cdk-lib";
import { resolveEnvironment } from "./environment";

// Re-export Tags for convenience
export { Tags };

/**
 * The minimum set of required tag keys that must be present on all taggable resources.
 */
export const REQUIRED_TAG_KEYS: readonly string[] = [
  "Project",
  "Environment",
  "ManagedBy",
  "Component",
] as const;

/**
 * Valid component names for the Component tag.
 */
export const VALID_COMPONENTS: readonly string[] = [
  "VPC",
  "Database",
  "API",
  "Auth",
  "CICD",
  "WAF",
  "Amplify",
  "DBFlow",
] as const;

/**
 * Tag value validation rules.
 */
export interface TagValueRule {
  maxLength: number;
  pattern?: RegExp;
  errorMessage: string;
}

export const TAG_VALUE_RULES: Record<string, TagValueRule> = {
  Owner: {
    maxLength: 256,
    pattern: /^[a-zA-Z0-9\-_ ]+$/,
    errorMessage:
      "Owner must be alphanumeric, hyphens, underscores, or spaces (max 256 chars)",
  },
  CostCenter: {
    maxLength: 256,
    pattern: undefined,
    errorMessage: "CostCenter must be at most 256 characters",
  },
  StackPrefix: {
    maxLength: 20,
    pattern: /^[a-zA-Z0-9-]+$/,
    errorMessage:
      "StackPrefix must be alphanumeric or hyphens, 1-20 characters",
  },
};

/**
 * Validates a tag value against its defined rules.
 * Returns null if valid, or an error message string if invalid.
 * If no rule exists for the given tagKey, returns null (no rule = valid).
 */
export function validateTagValue(
  tagKey: string,
  value: string
): string | null {
  const rule = TAG_VALUE_RULES[tagKey];
  if (!rule) {
    return null;
  }

  // Check non-empty
  if (!value || value.length === 0) {
    return rule.errorMessage;
  }

  // Check max length
  if (value.length > rule.maxLength) {
    return rule.errorMessage;
  }

  // Check pattern if defined
  if (rule.pattern && !rule.pattern.test(value)) {
    return rule.errorMessage;
  }

  return null;
}

/**
 * Reads context parameters and applies all global tags to the CDK app.
 * Tags applied: Project, Environment, ManagedBy, Version, Owner, CostCenter, StackPrefix.
 *
 * Throws if StackPrefix is missing/empty or fails validation.
 * Throws if Owner or CostCenter are provided but fail validation.
 * Throws if Environment is set to a value outside the accepted set.
 */
export function applyGlobalTags(app: cdk.App): void {
  // Read context parameters
  const stackPrefix = app.node.tryGetContext("StackPrefix") as string | undefined;
  const environment = app.node.tryGetContext("Environment") as string | undefined;
  const version = app.node.tryGetContext("Version") as string | undefined;
  const owner = app.node.tryGetContext("Owner") as string | undefined;
  const costCenter = app.node.tryGetContext("CostCenter") as string | undefined;

  // Validate StackPrefix — required
  if (!stackPrefix || stackPrefix.trim().length === 0) {
    throw new Error(
      "StackPrefix context parameter is required. Provide it via -c StackPrefix=<value>"
    );
  }
  const stackPrefixError = validateTagValue("StackPrefix", stackPrefix);
  if (stackPrefixError) {
    throw new Error(`Invalid StackPrefix value: ${stackPrefixError}`);
  }

  // Validate Owner if provided (non-empty)
  if (owner && owner.trim().length > 0) {
    const ownerError = validateTagValue("Owner", owner);
    if (ownerError) {
      throw new Error(`Invalid Owner value: ${ownerError}`);
    }
  }

  // Validate CostCenter if provided (non-empty)
  if (costCenter && costCenter.trim().length > 0) {
    const costCenterError = validateTagValue("CostCenter", costCenter);
    if (costCenterError) {
      throw new Error(`Invalid CostCenter value: ${costCenterError}`);
    }
  }

  // Resolve the environment to its canonical form, failing synth early on an
  // unrecognized value and defaulting to "dev" when unset.
  const effectiveEnvironment = resolveEnvironment(environment);
  const effectiveOwner = owner && owner.trim().length > 0 ? owner : "LAIGO-Team";
  const effectiveCostCenter = costCenter && costCenter.trim().length > 0 ? costCenter : "Engineering";

  // Apply tags at App scope
  Tags.of(app).add("Project", "LAIGO");
  Tags.of(app).add("Environment", effectiveEnvironment);
  Tags.of(app).add("ManagedBy", "CDK");
  Tags.of(app).add("StackPrefix", stackPrefix);
  Tags.of(app).add("Owner", effectiveOwner);
  Tags.of(app).add("CostCenter", effectiveCostCenter);

  // Conditionally apply Version tag only if non-empty
  if (version && version.trim().length > 0) {
    Tags.of(app).add("Version", version);
  }
}

/**
 * Applies the Component tag to a stack scope.
 * Must be called once in each stack's constructor with the stack's assigned component name.
 *
 * Throws if componentName is empty, undefined, null, or not in VALID_COMPONENTS.
 */
export function applyStandardTags(
  stack: cdk.Stack,
  componentName: string
): void {
  // Check for falsy values (undefined, null, empty string)
  if (!componentName || componentName.trim() === "") {
    throw new Error("A valid component name is required");
  }

  // Check if component name is in the valid set
  if (!VALID_COMPONENTS.includes(componentName)) {
    throw new Error(`Invalid component name: ${componentName}`);
  }

  // Apply the Component tag to the stack scope
  Tags.of(stack).add("Component", componentName);
}

/**
 * CDK Aspect that validates all taggable CfnResource constructs have the required tags.
 * Only checks CfnResource instances (leaf CloudFormation resources) to avoid
 * duplicate errors on higher-level constructs.
 *
 * Emits Annotations.addError for each missing required tag key.
 *
 * Apply at the App level: Aspects.of(app).add(new TagValidationAspect())
 */
export class TagValidationAspect implements IAspect {
  visit(node: IConstruct): void {
    // Only check CfnResource instances to avoid duplicate errors on higher-level constructs
    if (node instanceof CfnResource && TagManager.isTaggable(node)) {
      const tags: Record<string, string> = node.tags.tagValues();
      const missingKeys = REQUIRED_TAG_KEYS.filter((key) => !(key in tags));

      if (missingKeys.length > 0) {
        for (const key of missingKeys) {
          Annotations.of(node).addError(`Missing required tag: ${key}`);
        }
      }
    }
  }
}
