# Runners

Runners should accept pinned config, write a new raw trial record, preserve
validity and blocking reasons, and avoid provider or repository side effects
unless the trial explicitly declares and satisfies its prerequisites.
