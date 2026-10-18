async function refresh(): Promise<void> {
  const status = document.querySelector<HTMLParagraphElement>("#status");
  const tasks = document.querySelector<HTMLUListElement>("#tasks");
  if (!status || !tasks) return;
  const statusResult = await window.orchestrator.getStatus();
  status.textContent = statusResult.ok
    ? `Database: ${statusResult.value.database}`
    : `Error: ${statusResult.error.message}`;
  const taskResult = await window.orchestrator.listTasks();
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
      button.addEventListener("click", async () => {
        const result = await window.orchestrator.runFixture(task.id);
        const runResult = document.querySelector<HTMLParagraphElement>("#run-result");
        if (runResult) {
          runResult.textContent = result.ok
            ? `Run ${result.value.status}; accepted: ${result.value.accepted}; progress: ${result.value.progressAccepted} accepted, ${result.value.progressRejected} rejected.`
            : `Run blocked: ${result.error.message}`;
        }
      });
      item.append(" ", button);
    } else {
      const note = document.createElement("span");
      note.textContent = " Approval workflow not available in fixture UI.";
      item.append(note);
    }
    const history = await window.orchestrator.listRuns(task.id);
    if (history.ok && history.value.length > 0) {
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
  const data = new FormData(form);
  const result = await window.orchestrator.createTask({
    title: String(data.get("title") ?? ""),
    description: String(data.get("description") ?? ""),
    acceptanceCriteria: [String(data.get("criterion") ?? "")],
    riskTier: Number(data.get("riskTier") ?? 1) as 1 | 2 | 3
  });
  const error = document.querySelector<HTMLParagraphElement>("#task-error");
  if (error) error.textContent = result.ok ? "" : result.error.message;
  if (result.ok) {
    form.reset();
    await refresh();
  }
});

void refresh();
