/**
 * Maps backend error codes to user-friendly CLI messages.
 *
 * The NestJS backend throws exceptions like:
 *   new NotFoundException('PROJECT_NOT_FOUND')
 *   new ForbiddenException('PROJECT_ACCESS_DENIED')
 *   new BadRequestException('USER_NOT_IN_ORGANIZATION')
 *
 * These arrive in the response body as:
 *   { statusCode: 404, message: "PROJECT_NOT_FOUND", error: "Not Found" }
 *
 * This module turns those codes into clear, actionable messages.
 */

const ERROR_MESSAGES: Record<string, string> = {
  // ── Deploy Agent ────────────────────────────────────────────────────
  REPO_NOT_FOUND:
    "Repository not found. It may have been deleted or the URL is incorrect.",
  DEPLOYMENT_NOT_FOUND:
    "Deployment not found. It may have been removed already.",
  DATABASE_NOT_ENABLED:
    "Database is not enabled for this project. Enable it in your project settings first.",

  // ── Projects ─────────────────────────────────────────────────────────
  USER_NOT_IN_ORGANIZATION:
    "You are not a member of this organization. Contact an admin to be added.",
  PROJECT_NOT_FOUND:
    "Project not found. Check the project ID or run 'devver project list' to see your projects.",
  PROJECT_ACCESS_DENIED:
    "You don't have access to this project. Ask a project admin to add you as a team member.",
  SOME_MEMBERS_NOT_IN_ORGANIZATION:
    "Some team members are not in the organization. All members must belong to the organization first.",
  USER_NOT_TEAM_MEMBER: "You are not a team member of this project.",
  INVALID_DATABASE_MEMORY_REQUEST:
    "Invalid database memory configuration. Memory must be at least 0.5 GB.",
  INVALID_DATABASE_CPU_REQUEST:
    "Invalid database CPU configuration. CPU cores must be at least 0.1.",

  // ── Organizations ────────────────────────────────────────────────────
  CANNOT_DELETE_ORGANIZATION_WITH_MULTIPLE_MEMBERS:
    "Cannot delete this organization because it still has members. Remove all members first.",
  USER_MUST_HAVE_VERIFIED_EMAIL_FOR_INVITATIONS:
    "You need a verified email address to send or accept invitations.",
  CANNOT_TRANSFER_OWNERSHIP_TO_YOURSELF:
    "You cannot transfer ownership to yourself.",
  NEW_OWNER_MUST_BE_ADMINISTRATOR:
    "The new owner must be an administrator of the organization.",
  CANNOT_REMOVE_OWNER_FROM_ORGANIZATION:
    "Cannot remove the organization owner. Transfer ownership first.",
  NOT_ALLOWED_TO_REMOVE_USER:
    "You don't have permission to remove this user from the organization.",
  INVITATION_NOT_FOR_CURRENT_USER:
    "This invitation was sent to a different user.",
  ADMIN_ORGANIZATION_ROLE_NOT_FOUND:
    "The admin role is missing in the identity provider. Contact support.",

  // ── Comments ─────────────────────────────────────────────────────────
  COMMENT_ACCESS_DENIED: "You don't have access to this comment.",

  // ── Logto / Auth ─────────────────────────────────────────────────────
  UNAUTHORIZED: "Authentication required. Run 'devver auth login' to sign in.",
  FORBIDDEN: "You don't have permission to perform this action.",
  INVALID_CREDENTIALS: "Invalid credentials. Please check your login details.",
  EMAIL_ALREADY_IN_USE: "This email is already associated with an account.",

  // ── General ──────────────────────────────────────────────────────────
  NOT_FOUND: "The requested resource was not found.",
  CONFLICT: "A conflict occurred — the resource may already exist.",
  UNIQUE_CONSTRAINT: "A record with this value already exists.",
  DATABASE_UNIQUE_CONSTRAINT_VIOLATION:
    "A record with this value already exists.",
  VALIDATION_ERROR: "The request contained invalid data.",
  VALIDATION_ENTITY_NOT_FOUND: "A referenced entity does not exist.",
  INVALID_ID_FORMAT: "The provided ID has an invalid format.",
  MODEL_NOT_FOUND: "The requested model was not found.",
  ERROR_GENERATING_TOKEN:
    "An internal error occurred while generating an authentication token.",
  INVALID_REFRESH_TOKEN: "Your session has expired. Please log in again.",
  POPULATION_ERROR: "An error occurred while loading related data.",
  FILE_UPLOAD_FAILED: "The file upload failed. Please try again.",

  // ── Database / Infrastructure ────────────────────────────────────────
  DOCUMENT_NOT_FOUND: "The requested document does not exist.",
  INVALID_FIELD_TYPE:
    "Invalid value for a field. Check your input and try again.",
  MONGO_ERROR: "A database error occurred. Please try again later.",
  UNKNOWN_DATABASE_ERROR:
    "An unexpected database error occurred. Please contact support.",

  // ── Deploy (PM2 / build / nginx) ────────────────────────────────────
  INSTALL_ERROR:
    "Failed to install dependencies during deployment. Check your install command.",
  BUILD_ERROR:
    "Failed to build the project during deployment. Check your build command.",
  PROCESS_ERROR: "Failed to start the process during deployment.",
  NGINX_ERROR: "Failed to configure nginx during deployment.",
  PORT_CONFLICT: "A port conflict occurred during deployment.",
  DEPLOY_ERROR: "Deployment failed. Try again or contact support.",
  REPO_CREATE_FAILED:
    "Failed to create repository. Check the name and try again.",
  PM2_START_FAILED:
    "Failed to start the process. The process name may be incorrect.",
  PM2_STOP_FAILED:
    "Failed to stop the process. The process name may be incorrect.",
  PM2_RESTART_FAILED:
    "Failed to restart the process. The process name may be incorrect.",
  MONGO_INSTANCE_UNREACHABLE:
    "The MongoDB instance is currently unreachable. Try again later.",
  MONGO_DATABASES_FETCH_FAILED:
    "Failed to fetch databases from MongoDB. Try again later.",
};

/**
 * Look up a user-friendly message for a backend error code.
 *
 * Falls back to `fallback` (or the raw code) when no mapping exists.
 */
export function getErrorMessage(code: string, fallback?: string): string {
  const entry: string | undefined = ERROR_MESSAGES[code];

  return entry ?? fallback ?? code;
}

/**
 * Format a backend error response into a human-readable string.
 *
 * Accepts the parsed JSON body from the NestJS error response and produces
 * a single-line message suitable for CLI output.
 */
export function formatBackendError(body: {
  message?: string | string[];
  error?: string;
  statusCode?: number;
  field?: string;
  value?: string;
  errors?: Array<{ field: string; message: string; value?: string }>;
}): string {
  const code = typeof body.message === "string" ? body.message : undefined;
  const statusLabel = body.statusCode ? `(${body.statusCode})` : "";

  // Validation errors with field details
  if (body.errors && Array.isArray(body.errors) && body.errors.length > 0) {
    const details = body.errors
      .map((e) => `${e.field}: ${e.message}`)
      .join("; ");
    return `Validation failed — ${details} ${statusLabel}`.trim();
  }

  // Unique constraint violation with field info
  if (code === "UNIQUE_CONSTRAINT_VIOLATION" && body.field) {
    const friendly = getErrorMessage("UNIQUE_CONSTRAINT");
    return `${friendly} (field: "${body.field}", value: "${body.value ?? ""}") ${statusLabel}`.trim();
  }

  // Known error code with a friendly message
  if (code) {
    const friendly = getErrorMessage(code);
    // If we got a friendly message that differs from the raw code, include both
    if (friendly !== code) {
      return `${friendly} ${statusLabel}`.trim();
    }
    // No friendly mapping — use the raw code with the HTTP error category
    if (body.error) {
      return `${code} — ${body.error} ${statusLabel}`.trim();
    }
    return `${code} ${statusLabel}`.trim();
  }

  // Array of messages (validation)
  if (Array.isArray(body.message) && body.message.length > 0) {
    return `${body.message.join("; ")} ${statusLabel}`.trim();
  }

  // Fallback: whatever we have
  if (body.error) {
    return `${body.error} ${statusLabel}`.trim();
  }

  return `Request failed ${statusLabel}`.trim();
}
