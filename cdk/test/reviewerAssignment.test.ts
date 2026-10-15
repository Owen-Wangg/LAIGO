// Unit tests for the pure reviewer-assignment guard used by
// PUT /student/review_case. The module is plain JS (shared with the Lambda
// runtime), required directly.
//
// The handler resolves `validReviewerIds` from the database using a
// parameterized query that returns only reviewers who are on the requesting
// student's roster (instructor_students) AND hold the instructor role. These
// tests exercise the decision logic over that resolved set: a reviewer that is
// not a roster instructor (whether an unknown/non-roster user, or a roster
// member lacking the instructor role) simply does not appear in
// `validReviewerIds`, and must cause the whole assignment to be rejected.
const {
  validateReviewerAssignment,
} = require("../lambda/handlers/utils/reviewerAssignment");

describe("validateReviewerAssignment", () => {
  const student = "student-1";
  const instructorA = "instructor-a";
  const instructorB = "instructor-b";
  const outsiderInstructor = "instructor-x"; // real instructor, not on roster
  const rosterStudentUser = "user-s"; // on roster relation but not an instructor

  test("allows when every requested reviewer is a roster instructor", () => {
    const result = validateReviewerAssignment({
      requestedReviewerIds: [instructorA, instructorB],
      validReviewerIds: [instructorA, instructorB],
    });
    expect(result.allowed).toBe(true);
    expect(result.statusCode).toBeUndefined();
  });

  test("denies when a requested reviewer is a user but not on the roster", () => {
    // The DB query excludes outsiderInstructor, so it is absent from the set.
    const result = validateReviewerAssignment({
      requestedReviewerIds: [instructorA, outsiderInstructor],
      validReviewerIds: [instructorA],
    });
    expect(result.allowed).toBe(false);
    expect(result.statusCode).toBe(403);
    expect(result.error).toMatch(/not assigned instructors/i);
  });

  test("denies when a requested reviewer is on the roster but lacks the instructor role", () => {
    // The DB query's role filter excludes rosterStudentUser from the set.
    const result = validateReviewerAssignment({
      requestedReviewerIds: [instructorA, rosterStudentUser],
      validReviewerIds: [instructorA],
    });
    expect(result.allowed).toBe(false);
    expect(result.statusCode).toBe(403);
    expect(result.error).toMatch(/not assigned instructors/i);
  });

  test("denies when none of the requested reviewers are valid", () => {
    const result = validateReviewerAssignment({
      requestedReviewerIds: [outsiderInstructor, rosterStudentUser],
      validReviewerIds: [],
    });
    expect(result.allowed).toBe(false);
    expect(result.statusCode).toBe(403);
  });

  test("allows an empty reviewer list (case submitted with no reviewers)", () => {
    const result = validateReviewerAssignment({
      requestedReviewerIds: [],
      validReviewerIds: [],
    });
    expect(result.allowed).toBe(true);
  });

  test("treats a non-array request as empty and allows it", () => {
    const result = validateReviewerAssignment({
      requestedReviewerIds: undefined,
      validReviewerIds: [],
    });
    expect(result.allowed).toBe(true);
  });

  test("denies a duplicated id that is not a valid reviewer", () => {
    const result = validateReviewerAssignment({
      requestedReviewerIds: [outsiderInstructor, outsiderInstructor],
      validReviewerIds: [],
    });
    expect(result.allowed).toBe(false);
    expect(result.statusCode).toBe(403);
  });

  test("allows duplicated ids when the id is a valid reviewer", () => {
    const result = validateReviewerAssignment({
      requestedReviewerIds: [instructorA, instructorA],
      validReviewerIds: [instructorA],
    });
    expect(result.allowed).toBe(true);
  });

  test("denies when the student passes their own id as a reviewer", () => {
    // The student is not an instructor on their own roster, so they are
    // excluded from the resolved valid set.
    const result = validateReviewerAssignment({
      requestedReviewerIds: [student],
      validReviewerIds: [],
    });
    expect(result.allowed).toBe(false);
    expect(result.statusCode).toBe(403);
  });
});
