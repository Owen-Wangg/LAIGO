"use strict";

/**
 * Pure decision helper for assigning reviewers to a case.
 *
 * The caller is responsible for resolving, from the database, the set of
 * reviewer user_ids that are valid for the requesting student: a reviewer is
 * valid only when it is on the student's roster (instructor_students) and holds
 * the instructor role. This function compares the reviewer_ids requested in the
 * body against that validated set and decides whether the assignment may
 * proceed.
 *
 * An empty request (no reviewer_ids) is allowed: the case may still be marked
 * submitted with no reviewers and no notifications.
 *
 * @param {object} params
 * @param {string[]} params.requestedReviewerIds - reviewer_ids from the request body
 * @param {Iterable<string>} params.validReviewerIds - reviewer user_ids confirmed
 *   to be roster instructors for the requesting student
 * @returns {{ allowed: boolean, statusCode?: number, error?: string }}
 */
function validateReviewerAssignment({ requestedReviewerIds, validReviewerIds }) {
  const requested = Array.isArray(requestedReviewerIds)
    ? requestedReviewerIds
    : [];

  if (requested.length === 0) {
    return { allowed: true };
  }

  const validSet = new Set(validReviewerIds || []);

  const allRequestedValid = requested.every((id) => validSet.has(id));

  if (!allRequestedValid) {
    return {
      allowed: false,
      statusCode: 403,
      error:
        "Access denied: one or more reviewers are not assigned instructors for this student",
    };
  }

  return { allowed: true };
}

module.exports = {
  validateReviewerAssignment,
};
