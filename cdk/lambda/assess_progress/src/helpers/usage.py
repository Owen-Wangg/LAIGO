
import logging
from datetime import datetime, timezone

logger = logging.getLogger()

def check_and_increment_usage(connection, user_id):
    """
    Atomically checks and increments the daily message usage for a user.
    Uses UPDATE ... RETURNING to prevent race conditions from concurrent requests.
    Returns the current usage count for today.
    """
    if connection is None:
        logger.error("Database connection is None")
        raise ValueError("Database connection failed")

    try:
        cur = connection.cursor()
        current_time = datetime.now(timezone.utc)
        today = current_time.date()

        # Atomic operation: reset counter if new UTC day, otherwise increment.
        # Uses a single UPDATE ... RETURNING to prevent TOCTOU race conditions.
        cur.execute("""
            UPDATE "users"
            SET activity_counter = CASE
                WHEN last_activity IS NULL OR (last_activity AT TIME ZONE 'UTC')::date < %s::date
                THEN 1
                ELSE activity_counter + 1
            END,
            last_activity = %s
            WHERE user_id = %s
            RETURNING activity_counter
        """, (today, current_time, user_id))

        result = cur.fetchone()

        if not result:
            cur.close()
            logger.error(f"User not found: {user_id}")
            raise ValueError(f"User not found: {user_id}")

        new_count = result[0]
        connection.commit()
        cur.close()

        logger.info(f"Updated usage for user {user_id}: {new_count}")
        return new_count

    except Exception as e:
        logger.error(f"Error checking/incrementing usage: {e}")
        if connection:
            connection.rollback()
        raise
