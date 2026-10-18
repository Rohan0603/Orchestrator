const pendingFixtureRuns = new Set<string>();
let submittingTask = false;

async function refresh(): Promise<void> {
  const status = document.querySelector<HTMLParagraphElement>("#status");
  const tasks = document.querySelector<HTMLUListElement>("#tasks");
  if (!status || !tasks) return;
  let statusResult;
  try {
    statusResult = await window.orchestrator.getStatus();
  } catch {
    status.textContent = "Error: Unable to load application status";
    tasks.replaceChildren();
    const error = document.createElement("li");
    error.textContent = "Unable to load tasks";
    tasks.append(error);
    return;
  }
  status.textContent = statusResult.ok
    ? `Database: ${statusResult.value.database}`
    : `Error: ${statusResult.error.message}`;
  let taskResult;
  try {
    taskResult = await window.orchestrator.listTasks();
  } catch {
    tasks.replaceChildren();
    const error = document.createElement("li");
    error.textContent = "Unable to load tasks";
    tasks.append(error);
    return;
  }
  if (!taskResult.ok) {
    tasks.replaceChildren();
    const error = document.createElement("li");
    error.textContent = taskResult.error.message;
    tasks.append(error);
    return;
  }
  tasks.replaceChildren();
  if (taskResult.value.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No tasks yet.";
    tasks.append(empty);
    return;
  }
  for (const task of taskResult.value) {
    const item = document.createElement("li");
    item.textContent = `${task.title} [${task.status}]`;
    if (task.riskTier === 1) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Run local fixture";
      button.disabled = pendingFixtureRuns.has(task.id);
      button.addEventListener("click", async () => {
        const runResult = document.querySelector<HTMLParagraphElement>("#run-result");
        if (pendingFixtureRuns.has(task.id)) return;
        pendingFixtureRuns.add(task.id);
        button.disabled = true;
        try {
          const result = await window.orchestrator.runFixture(task.id);
          if (runResult) {
            runResult.textContent = result.ok
              ? `Run ${result.value.status}; accepted: ${result.value.accepted}; ${result.value.acceptance?.reason ?? "No acceptance decision recorded"}; progress: ${result.value.progressAccepted} accepted, ${result.value.progressRejected} rejected.`
              : `Run blocked: ${result.error.message}`;
          }
        } catch {
          if (runResult) runResult.textContent = "Run failed: Unable to execute fixture";
        } finally {
          pendingFixtureRuns.delete(task.id);
          button.disabled = false;
          await refresh();
        }
      });
      item.append(" ", button);
    } else {
      const note = document.createElement("span");
      note.textContent = " Approval workflow not available in fixture UI.";
      item.append(note);
    }
    let history;
    try {
      history = await window.orchestrator.listRuns(task.id);
    } catch {
      const error = document.createElement("span");
      error.textContent = " Run history unavailable.";
      item.append(error);
      tasks.append(item);
      continue;
    }
    if (!history.ok) {
      const error = document.createElement("span");
      error.textContent = ` Run history unavailable: ${history.error.message}`;
      item.append(error);
    } else if (history.value.length > 0) {
      const runs = document.createElement("ul");
      for (const entry of history.value) {
        const run = document.createElement("li");
        run.textContent = `Run ${entry.run.id.slice(0, 8)}: ${entry.run.state}; attempt ${entry.attempt.outcome}`;
        if (entry.attempt.workerReport) run.title = entry.attempt.workerReport;
        runs.append(run);
      }
      item.append(runs);
    }
    tasks.append(item);
  }
}

document.querySelector<HTMLFormElement>("#task-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) return;
  if (submittingTask) return;
  submittingTask = true;
  const submit = form.querySelector<HTMLButtonElement>("button[type=submit]");
  if (submit) submit.disabled = true;
  const data = new FormData(form);
  const error = document.querySelector<HTMLParagraphElement>("#task-error");
  try {
    const result = await window.orchestrator.createTask({
      title: String(data.get("title") ?? ""),
      description: String(data.get("description") ?? ""),
      acceptanceCriteria: [String(data.get("criterion") ?? "")],
      riskTier: Number(data.get("riskTier") ?? 1) as 1 | 2 | 3
    });
    if (error) error.textContent = result.ok ? "" : result.error.message;
    if (result.ok) {
      form.reset();
      await refresh();
    }
  } catch {
    if (error) error.textContent = "Task creation failed";
  } finally {
    submittingTask = false;
    if (submit) submit.disabled = false;
  }
});

void refresh();
