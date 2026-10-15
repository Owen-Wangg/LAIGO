"use strict";

/**
 * Pure decision helper for the status field on PUT /student/edit_case.
 *
 * This endpoint exists to persist case content (title, type, description,
 * jurisdiction, province, statute). It is not a workflow control: moving a
 * case between states is owned exclusively by the dedicated routes
 * (review_case, instructor send_feedback, archive_case), each of which applies
 * its own authorization and side effects (e.g. sent_to_review, feedback
 * messages). The client only ever echoes the case's existing status back on an
 * edit, so this helper permits the status to stay the same and rejects any
 * attempt to change it.
 *
 * @param {object} params
 * @param {string|null|undefined} params.currentStatus - the case's current
 *   status as stored in the database
 * @param {string|null|undefined} params.requestedStatus - the status value
 *   supplied in the request body
 * @returns {{ allowed: boolean, statusCode?: number, error?: string }}
 */
function validateCaseStatusEdit({ currentStatus, requestedStatus }) {
  // No status supplied means no state change is being requested.
  if (requestedStatus === null || requestedStatus === undefined) {
    return { allowed: true };
  }

  if (requestedStatus === currentStatus) {
    return { allowed: true };
  }

  return {
    allowed: false,
    statusCode: 409,
    error:
      "Case status cannot be changed through this endpoint. Use the submit, feedback, or archive workflow instead.",
  };
}

module.exports = {
  validateCaseStatusEdit,
};
